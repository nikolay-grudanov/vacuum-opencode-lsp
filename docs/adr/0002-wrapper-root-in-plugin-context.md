# ADR 0002 — Wrapper exposes wrapperRoot in plugin context

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-21 |
| **Author** | Николай Груданов (при участии Miko/Hermes Agent) |
| **Supersedes** | — |
| **Related** | ADR-0001 (`--rule-scripts`), v0.3.0 plugin contract |

---

## Context

ADR-0001 ввёл `--rule-scripts <dir>` и зафиксировал plugin contract: каждая скрипт-плагинка получает `context = { docPath, workspaceRoot, vacuumDiags, cache, text }`. Это работает **до момента, когда плагину нужны npm-зависимости из обёртки** (например, `js-yaml` для парсинга role_models).

В v0.3.0 плагин `operationid-permission.js` должен парсить `role_models/**/*.yaml`, для чего нужен YAML-парсер. Зависимости `vacuum-opencode-lsp` (`js-yaml`, `vscode-languageserver`) — это dep обёртки, не dep проекта-пользователя. Плагин не должен зависеть от того, что проект их случайно установил локально.

### Проблема: walk-up через symlinks ненадёжен

Самый простой фикс — `require('js-yaml')` напрямую. Если проект установил `js-yaml` — работает. Если нет — падает. Это **плохо**: ожидаемое поведение нарушает принцип «плагин = часть обёртки, не часть проекта».

Следующая попытка — walk-up от `__dirname` плагина в поисках `node_modules/js-yaml`. Это **архитектурно неверно** и **эмпирически ненадёжно**:

1. На `/tmp` (tmpfs) симлинк на директорию **резолвится в реальную директорию** для `lstatSync` — `isSymbolicLink()` возвращает `false`. Walk-up пропускает уровень.
2. На ext4 `lstatSync` правильно видит симлинки, но **только если они лежат на пути walk-up'а**. Симлинк внутри `node_modules/<wrapper>/node_modules/` — не лежит, walk-up его не находит.
3. Конфигурации установки различаются:
   - `project/node_modules/vacuum-opencode-lsp/` (symlink на wrapper, где живут `node_modules` wrapper'а)
   - `project/node_modules/vacuum-opencode-lsp/node_modules/...` (плоский, npm install без symlink)
   - `project/.opencode/node_modules/vacuum-opencode-lsp/` (отдельная иерархия в OpenCode-стиле)

Walk-up через все эти конфигурации — это 30+ строк хрупкого кода, который **всё равно** сломается на edge-case.

### Решение

Обёртка **знает свой путь** (через `__dirname` самого `index.js`). Это **ground truth**: `wrapperRoot = path.dirname(__filename)` — каталог, где лежит `package.json` обёртки, а `node_modules/js-yaml` лежит в `<wrapperRoot>/node_modules/js-yaml`.

Передаём `wrapperRoot` в `context` каждой плагинки. Плагин делает:

```js
const wrapperRoot = context.wrapperRoot;
const yaml = require(path.join(wrapperRoot, 'node_modules', 'js-yaml'));
```

**Одна строка**, **ground truth**, **работает в любой конфигурации установки**.

---

## Decision

Добавляем `context.wrapperRoot` (string, абсолютный путь к обёртке) в plugin contract v0.3.0.

### Что меняется

| Файл | Изменение |
|---|---|
| `index.js` | `context.wrapperRoot = path.dirname(__filename)` в `validateTextDocument()` |
| `lib/ruleLoader.js` | `perScriptContext.wrapperRoot = context.wrapperRoot` |
| `README.md` | Документация поля в plugin contract |
| `examples/rule-scripts/example-operationid-permission.js` | Использует `context.wrapperRoot` для `require('js-yaml')` |
| `test/test-rule-scripts.js` | Новый кейс: `context.wrapperRoot` присутствует и абсолютен |

### Backward Compatibility

- **Добавление поля** в context — backward compatible. Плагины, которые не используют `wrapperRoot`, продолжают работать.
- **Версия**: остаёмся на `v0.3.0` (ADR-0001 закрыт в v0.3.0). ADR-0002 — это **уточнение** того же minor-release, не новый feature.
- **Никаких breaking changes** в plugin contract.

### Альтернативы рассмотрены

#### 🅰️ Walk-up через symlinks в плагине — **REJECTED**

- 30+ строк хрупкого FS-кода
- Не работает на tmpfs (Linux symlink resolution quirk)
- Не работает если симлинк глубже walk-up уровня
- Каждый новый edge-case = ещё одна правка

#### 🅱️ Заставлять проекты ставить `js-yaml` как peer-dep — **REJECTED**

- Нарушает «plugin = часть wrapper» архитектуру
- Каждый новый wrapper-dep в плагине = ещё одна правка в package.json проекта
- Ломает принцип «out-of-the-box»

#### 🅲 Передавать `js-yaml` напрямую в context — **REJECTED**

- Передача целых npm-модулей в context размывает границы ответственности
- Плагин не знает, какие deps доступны → хрупкость
- Wrapper должен экспонировать **только** стабильные пути и идентификаторы

#### 🅳 `wrapperRoot` в context — **ACCEPTED** (этот ADR)

- 1 строка в `index.js`
- Ground truth через `__filename`
- Работает в любой FS-конфигурации
- Расширяемо (можно добавить `wrapperVersion`, `wrapperCapabilities` в будущем)

---

## Consequences

### ✅ Положительные

- **Плагины больше не зависят от FS-конфигурации** проекта. Нет хрупкого walk-up.
- **js-yaml доступен из коробки** для любого плагина, как и другие wrapper-deps.
- **Ground truth** через `__filename` — не зависит от cwd, env, FS-quirks.
- **Расширяемо**: будущие ADR могут добавить `wrapperVersion`, `wrapperCapabilities`, `nodeModulesPath` без breaking change.

### ⚠️ Негативные

| Риск | Severity | Решение |
|---|---|---|
| Плагин может использовать `wrapperRoot` для **несанкционированного доступа** к wrapper internals | 🟡 Medium | Документация: `wrapperRoot` для **resolve deps**, не для хака internals. v0.4.0 (если потребуется) — добавить `wrapperAllowedAPIs`. |
| `__filename` может быть unwrapped (bundler) | 🟢 Low | Не наш случай (raw Node.js, не webpack/rollup). |
| Путь может содержать symlinks — `realpath` не делаем | 🟢 Low | `path.dirname(__filename)` достаточно; `require()` следует symlink сам. |

### 📦 Размер diff

- `index.js`: +1 строка (`context.wrapperRoot = ...`)
- `lib/ruleLoader.js`: +1 строка (forward в perScriptContext)
- `README.md`: +5 строк (документация поля)
- `examples/rule-scripts/example-operationid-permission.js`: -25 строк (упрощаем `resolveJsYaml`)
- `test/test-rule-scripts.js`: +15 строк (новый кейс)

**Итого:** ~3 строки кода + упрощение примера. Чистое расширение без breaking changes.

---

## Verification

1. `npm test` — все 10 тестов зелёные + новый кейс для `wrapperRoot`.
2. `opencode debug lsp diagnostics` на `/home/gna/.cache/lsp-e2e-fixture/openapi/sales.yaml`:
   - Diagnostic от `operationid-permission-not-found` появляется
   - **Без** `js-yaml` копирования в `fixture/node_modules/`
   - Только через `context.wrapperRoot`
3. Standalone тест plugin с mock context `{ wrapperRoot: '/path/to/wrapper' }` — находит `js-yaml`.

---

## Decision Log

- 2026-07-21 — ADR принят после end-to-end теста v0.3.0 показал, что walk-up ненадёжен на tmpfs и при глубоких симлинках.
- 2026-07-21 — Live verification: плагин через `wrapperRoot` работает в любой FS-конфигурации.
- 2026-07-21 — ADR-0002 закрывает **последнюю** open issue из ADR-0001 §Open Questions (не считая worker_threads/pre-commit/versioning, которые остаются отложенными).