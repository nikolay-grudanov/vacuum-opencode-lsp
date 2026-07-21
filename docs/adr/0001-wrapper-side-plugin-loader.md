# ADR 0001 — Wrapper-side plugin loader (`--rule-scripts <dir>`)

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-21 |
| **Author** | Николай Груданов (при участии Miko/Hermes Agent) |
| **Supersedes** | — |
| **Related** | vacuum-opencode-lsp v0.2.0, digital-architecture `.opencode/` |

---

## Context

`vacuum-opencode-lsp` v0.2.0 — это Node.js-обёртка над CLI-линтером `@quobix/vacuum`, запускаемая как LSP-сервер через stdio. Обёртка решает одну архитектурную проблему: вакуум не передаёт кастомный ruleset через LSP (`InitializationOptions` или workspace/didChangeConfiguration), только через CLI-флаги — а OpenCode 1.x читает LSP-конфиг только при cold start и не пробрасывает options.

Текущий канал расширения — единственный: `--ruleset <path>` к YAML-файлу с правилами в Spectral-формате. Этого хватает для **AST-валидации** (наличие полей, формат значений, перечисления), но **не хватает для cross-artifact проверок**.

### Реальные кейсы, которые уже болят (digital-architecture, 21 файл)

1. **operationId ↔ role_models:** каждый `operationId` в `openapi/<service>/*.yaml` должен существовать как `permission.code` в `role_models/<domain>/<service>.yaml`. Если нет — агенту надо либо создать permission, либо переименовать operationId. Сейчас это знание живёт в skill `validate-role-models.ts` (cross-artifact tool) — агент должен **помнить, что надо его вызвать**. Не помнит → пропускает.

2. **Resolvable `$ref`:** в `sales.yaml` 8 ссылок на несуществующие DTO-файлы. Это ловит built-in `resolving-references` (39 violations), но **только в CLI-режиме**, не в LSP. В редакторе — тишина.

3. **Role-model gap:** permission-group ссылается на несуществующий `permission.code`. Сейчас — error в CLI через `validate-references.ts`, в редакторе — ничего.

Все три кейса объединяет одно: **правилу нужен доступ к файлам за пределами текущего документа** (другим YAML в репо). Ни одно из них нельзя выразить как JSONPath-селектор над одним файлом — это cross-artifact join.

### Текущий workaround (и почему он плохой)

Все cross-artifact правила оформлены как **отдельные OpenCode-tools** (`validate-references.ts`, `validate-role-models.ts`) или skills. Это работает, но:

- **Засорение контекста агента** — каждый tool = описание в system prompt (~500 токенов на tool).
- **Забывает вызвать** — агент не обязан это делать, и часто не делает.
- **Не в редакторе** — tools запускаются вручную, не в feedback-loop `didOpen/didChange`.

Хотим: **правила в LSP, в редакторе, как squiggles**. Чтобы агент видел нарушение глазами, а не «помнил, что нужно вызвать tool X».

---

## Decision

Добавляем в `vacuum-opencode-lsp` второй CLI-флаг, **симметричный** существующему `--ruleset`:

```
--rule-scripts <dir>
```

`<dir>` — путь к директории с `.js`-файлами. Каждый файл — Node.js-модуль, экспортирующий **одну async-функцию** фиксированного контракта. Обёртка загружает все скрипты, запускает их для каждого `didOpen`/`didChange` (после vacuum-валидации), мерджит результаты и шлёт `publishDiagnostics`.

### Контракт plugin-скрипта

```js
// .opencode/rule-scripts/operationid-permission.js
module.exports = async function rule(doc, context) {
  // doc       : object  — распарсенный YAML/JSON текущего файла
  // context   : {
  //   docPath       : string — абсолютный путь к файлу
  //   workspaceRoot : string — корень workspace (= cwd обёртки)
  //   vacuumDiags   : Diagnostic[] — то, что уже нашёл vacuum
  //   cache         : object — произвольный кеш между вызовами
  // }
  // returns : Diagnostic[] в формате LSP
  // throws  → обёртка ловит try/catch, шлёт error diagnostic, НЕ роняет LSP
};
```

LSP-Diagnostic:

```ts
{
  severity: 0|1|2,            // 0=Error, 1=Warning, 2=Information
  range: { start: {line, character}, end: {line, character} },
  code: '<rule-id>',          // обязательно с префиксом для дедупликации
  source: 'vacuum-lsp:rule-scripts',  // обязательно для различения от vacuum
  message: string,
  data?: any
}
```

### Поток выполнения

```
OpenCode ──didOpen──▶ vacuum-opencode-lsp
                          │
                          ├─ Stage 1: vacuum spectral-report ──exec──▶ vacuum binary
                          │              ◀──vacuumDiagnostics (Spectral JSON)──
                          │
                          ├─ Stage 2: rule-scripts loader (NEW)
                          │     require() каждого .js в --rule-scripts dir
                          │     await rule(doc, context) для каждого
                          │     ◀──pluginDiagnostics────────
                          │     один сломанный скрипт → try/catch → error diag
                          │
                          └─ Merge по {code, range.start} ──▶ publishDiagnostics
                                                                │
                                                                ▼
                                                          OpenCode TUI
```

### Резолюция путей

- `--rule-scripts <dir>` — относительный путь резолвится относительно `cwd` (= workspace root OpenCode).
- Если флаг не указан → Stage 2 не выполняется, поведение v0.2.0 сохраняется на 100%.
- Если директория не существует → warning в LSP console, Stage 2 не выполняется.

### Кеш и hot reload

- Скрипты загружаются через `require()` и кешируются по абсолютному пути.
- На каждом вызове проверяется `fs.statSync(p).mtimeMs` — при изменении `delete require.cache[require.resolve(p)]` и перезагрузка.
- **Этого достаточно для dev-loop:** правил обычно мало (5-10), рестарт обёртки не требуется.
- **Open issue:** worker_threads / child-process для изоляции тяжёлых скриптов — отложено до появления реального bottleneck'а.

### Конфигурация пользователя

В `opencode.jsonc`:

```jsonc
{
  "lsp": {
    "vacuum-opencode-lsp": {
      "command": [
        "node",
        "./.opencode/node_modules/vacuum-opencode-lsp/index.js",
        "--stdio",
        "--ruleset", "./.opencode/vacuum-ruleset.yaml",
        "--rule-scripts", "./.opencode/rule-scripts"
      ],
      "extensions": [".yaml", ".yml", ".json"]
    }
  }
}
```

Изменения **минимальные** — добавляется одна строка в уже существующий массив `command`.

---

## Considered Alternatives

### 🅰️ Vacuum `--functions <dir>` (JS в Goja runtime) — **REJECTED**

**Как работает:** vacuum встроил Goja (JS-интерпретатор на Go), `--functions <dir>` подхватывает `.js` файлы и регистрирует их как новые `function:` в Spectral-формате.

**Почему не подходит:**

| Ограничение | Следствие |
|---|---|
| Goja **sandbox без `fs`** | ❌ Нельзя прочитать `role_models/**` для cross-artifact |
| Нет `path` модуля | ❌ Нельзя вычислить абсолютный путь к соседнему файлу |
| Нет `async`/`Promise` | ❌ Не поддерживается `await` для I/O |
| `input` = только текущий YAML-узел | ⚠️ Доступ к документу ограничен селектором |
| Привязка к Spectral ruleset | ⚠️ Не любые правила выразимы через `function:` |

**Эмпирически проверено 2026-07-21:** live-тест с `myEcho.js` → `"not a directory"` без правильного `-f <dir>`, и функция не вызывается даже при корректном флаге, если ruleset ожидает иной формат. Это **фундаментальное ограничение Goja**, не bug и не misconfiguration.

**Вердикт:** тупик для cross-artifact. Подходит только для stateless-функций над одним YAML-узлом (например, кастомный `pattern`-проверщик).

### 🅱️ Wrapper-side plugin loader — **ACCEPTED** (этот ADR)

| Критерий | Оценка |
|---|---|
| Cross-artifact | ✅ Полный Node.js: `fs`, `path`, `async`, любые npm |
| Универсальность | ✅ Не только API — можно валидировать DBML, role_models, что угодно |
| Extension point | ✅ Один флаг, консистентный с `--ruleset` |
| Размер diff | ⚠️ ~70 строк в `index.js` + новый `lib/ruleLoader.js` (~50 строк) |
| Sandboxing | ⚠️ Trusted devs (своя рабочая директория) |
| Per-keystroke perf | ⚠️ `--debounce 300ms` уже есть; тяжёлые скрипты — open issue |
| Hot reload правил | ⚠️ mtime-based кеш; worker_threads — отложено |

### 🅲 Hybrid (Stage-1 vacuum + Stage-2 Node с фильтром) — **REJECTED**

**Идея:** vacuum как первый фильтр AST-правил, Node-rules как второй проход **только** если vacuum что-то нашёл ИЛИ если скрипт объявил `when: 'always'`.

**Почему не подходит:**

- Два source of truth для правил (часть в `vacuum-ruleset.yaml`, часть в `rule-scripts/`) — путаница при onboarding.
- Merge-логика по `{code, range}` — ещё один слой багов.
- Экономия CPU миллисекундная, не оправдывает сложность.
- Условная логика (`when:`) хрупкая.

**Когда пересмотреть:** когда в проекте появится 100+ OpenAPI-файлов и Node-rules станут реальным bottleneck'ом (а не теоретическим). Это **эволюция B**, не альтернатива.

### 🅳 PR в `daveshanley/vacuum` с добавлением Node.js-runtime — **REJECTED**

- Месяцы работы в чужом Go-репозитории.
- Goja выбран осознанно (sandbox + speed) — Node.js требует другого IPC.
- Issue #729 уже открыт в upstream'е с октября 2025 — нет активности по полноценному Node-runtime.
- Обёртка создана **именно** для обхода ограничений vacuum; инвертировать архитектуру нерационально.

---

## Consequences

### ✅ Положительные

- **Cross-artifact правила в редакторе** — агент видит `operationid-permission-not-found` как squiggle → действует без чтения skills.
- **Снятие засорения контекста** — 3-4 cross-artifact tool'а → 0 tool'ов, знания переезжают в plugin-скрипты.
- **Универсальный extension point** — `--rule-scripts <dir>` подходит для **любого** типа артефактов (DBML, role_models, db-schemas).
- **Generic обёртка** — никаких project-specific знаний в `index.js`. Skill и ruleset per-project.
- **Симметрия с `--ruleset`** — тот же паттерн (YAML-файл / JS-директория), та же резолюция, тот же fallback.
- **Эволюционный путь** — если в будущем понадобится Stage-1 фильтр (вариант C), это **расширение** B, а не переписывание.
- **Совместимость назад** — без флага = поведение v0.2.0 byte-for-byte.

### ⚠️ Негативные и как их закрываем

| Риск | Severity | Решение |
|---|---|---|
| **Скрипт падает → роняет LSP** | 🔴 High | `try/catch` вокруг каждого `require` И каждого `invoke`. Ошибка → diagnostic с `source: 'vacuum-lsp:rule-scripts'`, остальные скрипты продолжают работать. |
| **Per-keystroke latency** (N скриптов на каждое `didChange`) | 🔴 High | `--debounce 300ms` уже есть. Кеш `parsed role_models` через `context.cache` с инвалидацией по mtime. |
| **Горячий reload правил** | 🟡 Medium | mtime-based invalidation в `lib/ruleLoader.js`. Полный рестарт обёртки (или worker_threads) — **open issue**. |
| **Sandboxing** | 🟢 Low | Trusted developers — своя рабочая директория. Если потребуется isolation — `worker_threads` с timeout (отложено). |
| **YAML парсинг дублируется** | 🟢 Low | Обёртка парсит YAML один раз → передаёт `doc` в скрипты. +1 npm dep: `js-yaml` (минимальный, стабильный). |
| **Дублирование с vacuum diagnostics** | 🟢 Low | `source`-prefix (`'vacuum-lsp:rule-scripts'`) + merge по `{code, range.start}` гарантирует дедупликацию. |
| **Расширение attack surface** | 🟢 Low | Скрипты подключаются как обычные npm-зависимости проекта; OpenCode не выходит за пределы workspace. |

### 📦 Размер изменений

- `index.js`: +70 строк (CLI-флаг, loader-call, merge, try/catch).
- `lib/ruleLoader.js`: новый файл, ~50 строк.
- `package.json`: +1 dep (`js-yaml`), version bump `0.2.0` → `0.3.0`.
- `examples/opencode.jsonc.snippet`: +1 строка в `command`.
- `examples/rule-scripts/example-operationid-permission.js`: новый, ~40 строк.
- `test/test-rule-scripts.js`: новый smoke-тест, ~30 строк.
- `README.md`: +1 секция (`## Rule scripts`).

**Итого:** +1 файл, ~190 строк кода, ~30 строк документации. Полностью в рамках существующего package'а.

---

## Plugin Contract (Reference)

Полная спецификация контракта для авторов скриптов (попадёт в README и examples/).

```js
/**
 * @param {object} doc       — распарсенный YAML/JSON
 * @param {object} context   — { docPath, workspaceRoot, vacuumDiags, cache }
 * @returns {Array<Diagnostic>} — LSP diagnostics
 *
 * Diagnostic shape:
 *   {
 *     severity: 0|1|2,
 *     range: { start: { line, character }, end: { line, character } },
 *     code: string,                    // уникальный rule ID
 *     source: 'vacuum-lsp:rule-scripts',  // обязательно
 *     message: string,
 *     data?: any
 *   }
 *
 * Конвенции:
 *   - async функция (можно sync, но async предпочтительнее для I/O)
 *   - throws → обёртка ловит, шлёт error diagnostic, НЕ роняет LSP
 *   - state между вызовами — через context.cache (object, любая форма)
 *   - читать другие файлы — context.workspaceRoot + Node fs
 */
module.exports = async function rule(doc, context) {
  return [];
};
```

---

## Open Questions

1. **Worker threads / child process isolation** — отложено. Может понадобиться для тяжёлых скриптов (сетевые запросы, большие файлы). Не блокирует релиз.
2. **Идемпотентность и caching между файлами** — `context.cache` инициализируется заново при каждом запуске обёртки, но **шарится между документами в рамках одной сессии**. Конвенция: ключи кеша = абсолютные пути к файлам.
3. **Конфликт имён между правилами из разных источников** — решается через merge по `{code, range.start}`. Сейчас этого достаточно; edge-case (два правила с одинаковым `code`) — задокументировать, что `code` должен быть уникальным.
4. **Версионирование правил** — не решено. Сейчас правила = часть проекта, версионируются вместе с кодом (git blame / git log). Если правила выйдут в отдельный npm — нужен ADR-0002.
5. **Pre-commit hook для запуска rule-scripts в CI** — естественное расширение, не часть текущего ADR. Уже сейчас можно сделать через Node-обёртку.

---

## Verification

После реализации ADR проверяем:

1. `npm install` — без warning'ов, `js-yaml` подтягивается.
2. `npm test` — оба теста (existing `test-ruleset-flag.js` + new `test-rule-scripts.js`) зелёные.
3. `opencode debug lsp diagnostics openapi/<service>.yaml` — diagnostics содержат записи **с source `vacuum-lsp:rule-scripts`**.
4. Контрольный пример в `examples/rule-scripts/example-operationid-permission.js` — без флага `-scripts` возвращает 0 diag; с флагом — N diag (по числу operationId без permission).
5. Сломанный rule-script (syntax error) → error diagnostic, не crash обёртки. Тест: положить битый `.js`, открыть файл, убедиться что LSP продолжает работать.
6. Изменение правила на диске → при следующем `didChange` новая версия подхватывается (mtime invalidation).

---

## Decision Log

- 2026-07-21 — ADR принят, штурм по 4 reference-каналам (deepseek-v4-flash, gpt-oss-20, glm-4.7, tencent/hy3-preview), единогласно за B.
- 2026-07-21 — Live-тест vacuum `--functions` подтвердил непригодность Goja для cross-artifact.
- 2026-07-21 — Решение НЕ реализовывать C (over-engineering), с возможностью эволюции в будущем.