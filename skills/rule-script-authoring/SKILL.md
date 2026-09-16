---
name: rule-script-authoring
description: "Создание JS-плагинов (rule-scripts) для vacuum-opencode-lsp — cross-artifact правила, которым нужны fs, async, чтение соседних файлов, HTTP-запросы, парсинг YAML/JSON, работа с context.cache. Use when: правило не выражается через jsonpath + builtin-функцию над одним файлом, или нужен cross-artifact join (например, operationId ↔ permissions.yaml, X-Schema-Id ↔ реальный файл, ссылочная целостность между двумя директориями)."
---

# Создание JS-плагинов для `--rule-scripts`

Этот skill — про **программируемые** правила, которые живут в `.opencode/rule-scripts/*.js` и подключаются через `--rule-scripts <dir>`. Они выполняются в Node.js-песочнице wrapper'а после spectral-валидации.

Если правило выразимо через `jsonpath` + builtin-функцию над одним файлом — пиши его в `vacuum-ruleset.yaml` (см. `vacuum-rule-authoring`), а не в JS.

## Когда загружать

- Нужно сравнить содержимое текущего файла с другими файлами в репозитории.
- Нужен `fs`, `http`, `path`, `yaml`, `csv-parse`, любая Node.js-библиотека.
- Правило требует async I/O (сетевые запросы, чтение нескольких файлов).
- Нужна логика, которая на YAML/JSON не выражается (regex + несколько файлов + state).
- Агент просит «напиши cross-artifact правило», «проверь operationId в role_models», «добавь плагин для LSP».

## Plugin contract (v0.3.0+)

Каждый `.js` в директории `--rule-scripts` — Node.js-модуль, экспортирующий **одну async-функцию** строгого контракта. ([ADR-0001](../../docs/adr/0001-wrapper-side-plugin-loader.md))

```js
// .opencode/rule-scripts/<your-rule>.js
module.exports = async function rule(doc, context) {
  // doc       : object             — распарсенный YAML/JSON текущего файла
  // context   : {
  //   docPath         : string,    // абсолютный путь к файлу
  //   workspaceRoot   : string,    // cwd wrapper'а (= workspace root OpenCode)
  //   vacuumDiags     : Diagnostic[],  // что уже нашёл vacuum в этом файле
  //   cache           : object     // кеш между didChange в сессии
  // }
  // returns   : Diagnostic[]      // массив в LSP-формате
  // throws    → wrapper ловит try/catch, шлёт error diagnostic, НЕ роняет LSP
  return [];
};
```

## Формат Diagnostic (LSP 3.16)

```js
{
  severity: 0 | 1 | 2,             // 0=Error, 1=Warning, 2=Information
  range: {
    start: { line: 0, character: 0 },
    end:   { line: 0, character: 1 },
  },
  code: '<rule-id>',                // обязательно, для дедупликации
  source: 'vacuum-lsp:rule-scripts', // обязательно (= константа)
  message: '<human-readable, agent-friendly>',
  data?: any,                       // произвольный payload (для хинтов)
}
```

**Контрактные обязательства:**
- `source` ровно `'vacuum-lsp:rule-scripts'` (иначе merge с vacuum ломается).
- `code` уникален в рамках всех плагинов (дедупликация по `{code, range.start.line, range.start.character}`).
- `range` — 0-based, `line` и `character` ≥ 0. Если не знаешь точную позицию — ставь `start: { line: 0, character: 0 }, end: { line: 0, character: 1 }`.
- `message` — пиши для **агента**, не для пользователя. «agent must do X» лучше чем «invalid».

## Резолюция путей

- `--rule-scripts <dir>` — относительный путь от `cwd` (= workspace root OpenCode).
- Если директория не существует → warning в LSP-лог, Stage 2 не выполняется (поведение v0.2.0 сохраняется).
- Файлы в директории резолвятся как обычные `.js` — `require.resolve()` от корня директории.

## Резолюция зависимостей

Каждый плагин — `require()`-mодуль из корня wrapper'а. **Wrapper-shipped deps** (например `js-yaml`) доступны через:

```js
const yaml = require(require.resolve('js-yaml', {
  paths: [module.filename, context.wrapperRoot],
}));
```

(подробнее — в `context.wrapperRoot` ниже — в новых версиях wrapper'а.)

Сторонние npm — через `package.json` в корне wrapper'а или в `node_modules/` родительского проекта, если плагин туда установлен. **Через `npm install` в рабочей директории OpenCode** — самый надёжный путь.

## Hot reload

Wrapper кеширует плагины по `require.resolve(p)`. На каждом `didChange` проверяется `fs.statSync(p).mtimeMs` — если файл изменился → `delete require.cache[...]` → перезагрузка. **Рестарт wrapper'а при разработке не требуется**, но тяжёлые изменения (новые require) могут потребовать cold start.

## Кеш между вызовами

```js
module.exports = async function rule(doc, context) {
  // context.cache — общий объект на всю LSP-сессию, шарится между файлами
  const CACHE_KEY = 'permissions:v1';  // версионируй ключи при изменении формата

  if (!context.cache[CACHE_KEY]) {
    // дорогая операция: парсинг YAML на 10000 строк
    context.cache[CACHE_KEY] = expensiveParse();
  }

  const permissions = context.cache[CACHE_KEY];
  // ...
};
```

**Конвенция:** ключи = абсолютный путь к файлу + версия формата (на случай изменения). Иначе при изменении shape'а source-файла получишь stale данные.

**Инициализация:** `context.cache` создаётся один раз при старте wrapper'а. При hot reload плагина кеш **обнуляется** (т.к. это новый загруженный модуль).

## Полный рабочий шаблон

```js
'use strict';

/**
 * <rule-name>.js
 *
 * What it does:
 *   <1-3 предложения на человеческом>
 *
 * Why a JS plugin (not vacuum-ruleset.yaml):
 *   <объясни, какая cross-artifact логика — это контракт для будущих мейнтейнеров>
 *
 * Inputs:
 *   doc               — текущий OpenAPI/AsyncAPI spec (parsed object)
 *   context.docPath   — путь к файлу (для условной логики)
 *
 * Configuration:
 *   Читает <где>, формат <какой>; триггер рефреша: <mtime / ручной / ...>
 *
 * Standalone smoke test:
 *   node .opencode/rule-scripts/<rule-name>.js
 *   (должен напечатать N diagnostics на fixture)
 */

const fs = require('fs');
const path = require('path');

// ─── Debug ──────────────────────────────────────────────
// Логирование через файл, см. lsp-setup SKILL.md для деталей
const DEBUG_FILE = process.env.VACUUM_LSP_DEBUG === 'off' ? null
  : (process.env.VACUUM_LSP_DEBUG_FILE || '/tmp/vacuum-lsp-debug.log');
function debugLog(label, data) {
  if (!DEBUG_FILE) return;
  try {
    fs.appendFileSync(DEBUG_FILE,
      `[plugin ${new Date().toISOString()}] ${label}${data ? ' ' + JSON.stringify(data) : ''}\n`);
  } catch {}
}

// ─── Plugin ──────────────────────────────────────────────

module.exports = async function rule(doc, context) {
  const diagnostics = [];
  if (!doc || typeof doc !== 'object') return diagnostics;

  // 1. Ранний выход, если правило неприменимо
  if (!doc.paths || typeof doc.paths !== 'object') return diagnostics;

  // 2. Загрузка каталога (с кешем)
  const catalog = loadCatalog(context);

  // 3. Итерация по документу
  for (const [urlPath, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const opId = op.operationId;
      if (!opId) {
        diagnostics.push({
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          code: '<rule-name>:missing-operationId',
          source: 'vacuum-lsp:rule-scripts',
          message: `Operation ${method.toUpperCase()} ${urlPath} has no operationId. Agent must add operationId to the contract.`,
        });
        continue;
      }

      // 4. Cross-artifact проверка
      if (!catalog.has(opId)) {
        diagnostics.push({
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          code: '<rule-name>:catalog-miss',
          source: 'vacuum-lsp:rule-scripts',
          message: `operationId "${opId}" not found in catalog. Agent must create the entry or update the contract.`,
          data: { operationId: opId, path: urlPath, method: method.toUpperCase() },
        });
      }
    }
  }

  debugLog('<rule-name>:emitting', { count: diagnostics.length, docPath: context.docPath });
  return diagnostics;
};

// ─── Helpers ──────────────────────────────────────────────

function loadCatalog(context) {
  const CACHE_KEY = 'catalog:v1:role_models';
  if (context && context.cache && context.cache[CACHE_KEY]) {
    return context.cache[CACHE_KEY];
  }

  // Пример: walk по role_models/
  const set = new Set();
  try {
    const root = path.join(context.workspaceRoot, 'role_models');
    if (fs.existsSync(root)) {
      walkYaml(root, (filePath) => {
        try {
          const text = fs.readFileSync(filePath, 'utf8');
          // Используй js-yaml через require.resolve (см. lsp-setup)
          const yaml = require(require.resolve('js-yaml', {
            paths: [module.filename, context.workspaceRoot],
          }));
          const data = yaml.load(text);
          collectCodes(data, set);
        } catch (err) {
          debugLog('<rule-name>:catalog-parse-error', { file: filePath, err: err.message });
        }
      });
    }
  } catch (err) {
    debugLog('<rule-name>:catalog-walk-error', { err: err.message });
  }

  if (context && context.cache) {
    context.cache[CACHE_KEY] = set;
  }
  return set;
}

function walkYaml(dir, cb) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkYaml(p, cb);
    else if (/\.(ya?ml|json)$/i.test(ent.name)) cb(p);
  }
}

function collectCodes(node, set) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectCodes(x, set);
    return;
  }
  if (typeof node.code === 'string') set.add(node.code);
  for (const v of Object.values(node)) collectCodes(v, set);
}

// ─── Standalone smoke test ───────────────────────────────

if (require.main === module) {
  // Минимальный mock context для `node .opencode/rule-scripts/<rule>.js`
  const yaml = require(require.resolve('js-yaml', { paths: [__dirname, process.cwd()] }));
  const fixture = process.argv[2] || path.join(__dirname, '..', '..', 'examples', 'fixtures', 'sample-spec.yaml');
  const text = fs.readFileSync(fixture, 'utf8');
  const doc = yaml.load(text);
  const ctx = {
    docPath: fixture,
    workspaceRoot: process.cwd(),
    vacuumDiags: [],
    cache: {},
  };
  module.exports(doc, ctx).then(diags => {
    console.log(`${diags.length} diagnostic(s):`);
    for (const d of diags) {
      const s = ['ERR', 'WARN', 'INFO'][d.severity] || '?';
      console.log(`  [${s}] ${d.code}: ${d.message}`);
    }
    process.exit(diags.length > 0 ? 0 : 1);
  });
}
```

## Позиционирование range

`line`/`character` — 0-based. **Default `0:0–0:1`** — нормально для MVP, но UI показывает «top-of-file squiggle», что расплывчато.

Для точных позиций:

```js
// Вариант 1: парсить YAML с line tracking (js-yaml не умеет, нужен 'yaml' package)
// npm install yaml --save-dev
const yaml = require('yaml');
const doc = yaml.parseDocument(text);  // у каждого узла есть .range: [start, value, end]
const opRange = yamlNode.range;  // [start, value, end]
```

```js
// Вариант 2: парсить raw text регуляркой
const lines = text.split('\n');
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s{2}(get|post|...):/);
  if (m && /* matches target op */) {
    const range = { start: { line: i, character: lines[i].indexOf(m[1]) }, end: { line: i, character: 0 } };
    // используй
  }
}
```

```js
// Вариант 3: переиспользовать диагностику vacuum (если знаем code)
const vacuum = context.vacuumDiags.find(d => d.code === 'some-vacuum-rule' && /* matching range */);
const range = vacuum ? vacuum.range : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
```

Минимум — всегда возвращай `0:0–0:1`. Уточни range, если правило часто срабатывает и агенту нужно понять, **где именно** править.

## Подключение плагина

В `opencode.jsonc`:

```jsonc
"command": [
  "node", "./.opencode/node_modules/@nikolay-grudanov/vacuum-opencode-lsp/index.js",
  "--stdio",
  "--ruleset", "./.opencode/vacuum-ruleset.yaml",
  "--rule-scripts", "./.opencode/rule-scripts"
]
```

Каждый `.js` в директории будет загружен. Если хочешь подмножество — создай поддиректорию (`.opencode/rule-scripts/strict/`) и используй её как `--rule-scripts`.

## Реальные кейсы (зачем нужен `--rule-scripts`)

См. ADR-0001 § «Real cases that already hurt»:

1. **operationId ↔ role_models** — `catalog-miss` rule на каждый operation, который не имеет permission.code.
2. **Resolvable `$ref`** в DTO-каталоге — обход `components/schemas/*.yaml`, поиск битых ссылок.
3. **Role-model gap** — внутри role_models: `permission.group` ссылается на несуществующий permission.

Все три решаются через `require('fs').readdirSync(...)` + js-yaml + `context.cache`. **Не выражаются через vacuum-ruleset.yaml** (Goja-sandbox без `fs`).

## Тестирование плагина

### 1. Standalone (быстро, без LSP)

```bash
node .opencode/rule-scripts/my-rule.js path/to/fixture.yaml
```

Любые ошибки видны сразу. Используй в pre-commit hook и в unit-тестах.

### 2. Через vacuum CLI (без LSP, но полный пайплайн)

```bash
# Прямой вызов wrapper'а с stdin:
cat openapi/service.yaml | node ./node_modules/@nikolay-grudanov/vacuum-opencode-lsp/index.js \
  --ruleset ./.opencode/vacuum-ruleset.yaml \
  --rule-scripts ./.opencode/rule-scripts \
  --base ./openapi
```

### 3. Через OpenCode (full feedback loop)

```bash
# В редакторе: открыть spec → diagnostics появляются как squiggles.
opencode debug lsp diagnostics openapi/service.yaml
```

Ищи `source: 'vacuum-lsp:rule-scripts'` — это твои плагины.

## Anti-patterns

- ❌ **`require('js-yaml')` без `require.resolve`** — в плагине может не быть прямого доступа к wrapper-узлам, но иногда локальный `node_modules` тоже подхватит; **надёжнее через `require.resolve(paths: ...)`** (см. шаблон).
- ❌ **Синхронный `fs.readFileSync` в горячем цикле** на каждое `didChange` — debounce 300ms уже есть, но на 100+ файлах ты упрёшься. Кешируй через `context.cache` с mtime-инвалидацией.
- ❌ **`severity: 0` (Error) на advisory-правила** — превращает CI в красноту. Severity `warn` для советов, `error` для блокирующих нарушений.
- ❌ **Бросать исключение наружу** — обёртка ловит, но лучше return empty diagnostics + debug log, чтобы другие правила не «отравили» фидбэк loop.
- ❌ **`code` без префикса плагина** → конфликты с другими плагинами или vacuum built-ins. Конвенция: `<plugin-name>:<specific-check>`.
- ❌ **Использовать `--rule-scripts` для простых AST-правил** — пиши в `vacuum-ruleset.yaml`. Плагины = heavy machinery.
- ❌ **`source: 'openapi-linter'` или что-то ещё** — строго `'vacuum-lsp:rule-scripts'` или merge с vacuum сломается.
- ❌ **Бесконечный цикл при изменении кеша** — помни: `mtime` файла-каталога меняется при чтении некоторыми ФС. Инвалидируй кеш разумно.
- ❌ **Использовать `wrapperRoot` напрямую** — поле `wrapperRoot` ещё не в стабильном API; в новых версиях используй `context.workspaceRoot` для проектных файлов и `require.resolve('js-yaml', {paths: [...]})` для wrapper-shipped deps.

## Чек-лист при создании нового плагина

1. ☐ Подтверждено, что правило нельзя выразить через `vacuum-ruleset.yaml` (нужен `fs` / async / cross-artifact).
2. ☐ Имя файла `<rule-name>.js`, контрактный header-комментарий в начале.
3. ☐ `module.exports = async function rule(doc, context) { return [] }`.
4. ☐ Return'ит массив `Diagnostic[]` с `source: 'vacuum-lsp:rule-scripts'`.
5. ☐ `code` префиксован именем плагина.
6. ☐ Ранний выход, если документ нерелевантен (нет нужного поля).
7. ☐ Дорогие операции идут через `context.cache` с версионированным ключом.
8. ☐ `try/catch` на каждом `require`/`fs.readFileSync` — throw не должен пробивать наружу.
9. ☐ Standalone smoke-тест в `if (require.main === module) {}` снизу файла.
10. ☐ Подключен в `opencode.jsonc` через `--rule-scripts`.
11. ☐ После изменения — cold restart OpenCode (не обязательно, но если не сработало — сначала это).

## Связанные skills

- `lsp-setup` — подключение LSP в проекте.
- `vacuum-rule-authoring` — декларативные правила (для статических AST-проверок).
- `vacuum-opencode-lsp-development` — изменение самого wrapper'а (для maintainer'а).

## Ссылки

- README wrapper'а: [../../README.md](../../README.md)
- Пример плагина operationId↔permission: [../../examples/rule-scripts/example-operationid-permission.js](../../examples/rule-scripts/example-operationid-permission.js)
- ADR-0001 (полный контракт plugin'а): [../../docs/adr/0001-wrapper-side-plugin-loader.md](../../docs/adr/0001-wrapper-side-plugin-loader.md)
- ADR-0002 (context fields): [../../docs/adr/0002-wrapper-root-in-plugin-context.md](../../docs/adr/0002-wrapper-root-in-plugin-context.md)
- ADR-0007 (agent-friendly messages): [../../docs/adr/0007-enrich-diagnostics-for-agents.md](../../docs/adr/0007-enrich-diagnostics-for-agents.md)
