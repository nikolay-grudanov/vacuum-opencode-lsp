# vacuum-opencode-lsp

LSP-обёртка над [vacuum](https://github.com/daveshanley/vacuum) CLI для OpenCode (и любого LSP-клиента). Даёт real-time диагностику OpenAPI/AsyncAPI/JSON Schema спек в редакторе, включая кастомные правила из ruleset-файла.

## Что это

`@quobix/vacuum` поставляет встроенный `language-server` (Go + glsp), но он **не передаёт ruleset через LSP** — только через cobra-флаги или env. Из-за ограничений OpenCode 1.x (cold start конфига, нет workspace/didChangeConfiguration) передать ruleset напрямую нативному серверу нельзя.

Эта обёртка — **посредник**: запускается как обычный LSP-сервер через stdio, получает `didOpen`/`didChange` от OpenCode, и на каждый вызов спавнит `vacuum spectral-report` с нужным `--ruleset` флагом. Результат парсится в Spectral-формате и мапится в LSP `publishDiagnostics`.

## Архитектура

```
OpenCode TUI
   │  textDocument/didOpen, didChange
   ▼
vacuum-opencode-lsp (this wrapper, Node.js)
   │  execFileSync('vacuum', ['spectral-report', '-r', RULESET, file])
   ▼
vacuum binary (@quobix/vacuum)
   │  stdout: Spectral-format JSON
   ▼
this wrapper (map result.code → LSP Diagnostic)
   │  textDocument/publishDiagnostics
   ▼
OpenCode TUI (editor squiggles)
```

## Установка

```bash
# 1. Установить peer-зависимости
npm install --save-dev @quobix/vacuum vacuum-opencode-lsp

# 2. Положить ruleset рядом с проектом
mkdir -p .opencode
cp path/to/your-ruleset.yaml .opencode/vacuum-ruleset.yaml
```

## Конфигурация OpenCode

В `.opencode/opencode.jsonc` добавь в секцию `lsp`:

```jsonc
{
  "lsp": {
    "vacuum-opencode-lsp": {
      "command": [
        "node",
        "./node_modules/vacuum-opencode-lsp/index.js",
        "--stdio",
        "--ruleset", "./.opencode/vacuum-ruleset.yaml",
        "--rule-scripts", "./.opencode/rule-scripts"
      ],
      "extensions": [".yaml", ".yml", ".json"]
    }
  }
}
```

**Важно:** OpenCode читает LSP-конфиг только при **cold start**. После изменения `opencode.jsonc` — перезапусти TUI.

## Rule scripts (v0.3.0)

Начиная с v0.3.0, обёртка поддерживает второй extension point: **Node.js plugin-скрипты** для cross-artifact правил, которые невозможно выразить в YAML vacuum ruleset (cross-file I/O, разрешение ссылок между артефактами, обращения к внешним системам).

### Когда это нужно

- `operationId` в OpenAPI должен существовать как `permission.code` в `role_models/**` → plugin читает второй файл
- `$ref` в одном спеке должен резолвиться в существующий файл → plugin проверяет наличие файлов
- Любое правило, требующее **доступа к файлам за пределами текущего документа**

### Контракт plugin-скрипта

Каждый `.js` файл в директории `--rule-scripts` экспортирует **одну async-функцию**:

```js
const fs = require('fs');
const path = require('path');

module.exports = async function rule(doc, context) {
  // doc       : object  — распарсенный YAML/JSON текущего файла
  // context   : {
  //   docPath       : string — абсолютный путь к файлу
  //   workspaceRoot : string — корень workspace (= cwd обёртки)
  //   wrapperRoot   : string — путь к обёртке (= для resolve deps через require)
  //   vacuumDiags   : Diagnostic[] — то, что уже нашёл vacuum
  //   cache         : object — шарится между вызовами (для memoization)
  //   text          : string — raw YAML/JSON (для точных range)
  // }
  // returns : LSP Diagnostic[] в формате:
  //   { severity: 0|1|2, range: {...}, code: 'rule-id',
  //     source: 'vacuum-lsp:rule-scripts', message: string }
  // throws → обёртка ловит try/catch, шлёт error diagnostic, НЕ роняет LSP

  return [{
    severity: 1,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    code: 'my-rule-id',
    source: 'vacuum-lsp:rule-scripts',
    message: 'Что-то не так с этим файлом',
  }];
};
```

### Гарантии

- **Безопасность:** один сломанный скрипт → error diagnostic, остальные скрипты работают.
- **Hot reload:** mtime-based invalidation `require.cache`. Правка правила → следующий `didChange` подхватывает новую версию, рестарт обёртки не нужен.
- **Изоляция кеша:** `context.cache` — общий объект в рамках одной сессии LSP. Ключи кеша = абсолютные пути.
- **Backward compat:** без флага `--rule-scripts` поведение = v0.2.0 byte-for-byte.

### Полный рабочий пример

См. `examples/rule-scripts/example-operationid-permission.js` — cross-artifact правило, которое проверяет что каждый `operationId` существует в permissions catalog.

Запуск standalone для проверки:

```bash
node examples/rule-scripts/example-operationid-permission.js
# Standalone run: 2 diagnostic(s)
#   [WARN] operationid-permission-not-found: operationId "listUsers" not found...
#   [WARN] operationid-permission-not-found: operationId "registerUser" not found...
```

### Когда НЕ нужно использовать rule-scripts

- Правило выразимо в YAML vacuum ruleset (наличие полей, формат значений, перечисления) → используйте `--ruleset`.
- Правило не требует I/O / async → можно использовать vacuum custom functions (`-f <dir>`), хотя они ограничены Goja sandbox без `fs`.
- Правило должно работать в CLI/CI независимо от LSP → переиспользуйте ту же логику в Node.js обёртке скрипта (см. `vacuum-lint.sh` в digital-architecture).

### Architectural Decision Record

Полная мотивация, considered alternatives, trade-offs и consequences — в [docs/adr/0001-wrapper-side-plugin-loader.md](./docs/adr/0001-wrapper-side-plugin-loader.md).

## CLI-флаги обёртки

| Флаг | Описание | Default |
|---|---|---|
| `--stdio` | Использовать stdio для LSP transport (обязателен для OpenCode) | всегда включён |
| `--ruleset <path>`, `-r <path>` | Путь к vacuum ruleset (`.yaml`) | `cwd/.opencode/vacuum-ruleset.yaml` |
| `--rule-scripts <dir>` **(v0.3.0)** | Путь к директории с Node.js plugin-скриптами (см. [Rule scripts](#rule-scripts-v030)) | `cwd/.opencode/rule-scripts` |
| `--debounce <ms>` | Задержка перед валидацией после `didChange` | `300` |
| `--timeout <ms>` | Таймаут subprocess `vacuum` | `10000` |
| `--help`, `-h` | Показать usage и выйти | — |

## Резолюция ruleset

Порядок поиска (первый существующий путь побеждает):

1. `--ruleset <path>` из CLI (абсолютный или относительный к `cwd`)
2. `<cwd>/.opencode/vacuum-ruleset.yaml`
3. `<cwd>/vacuum-ruleset.yaml`

Если ни один не найден — обёртка работает в режиме **built-in recommended** (только стандартные vacuum правила).

## Резолюция vacuum binary

1. `<__dirname>/../node_modules/@quobix/vacuum/bin/vacuum` (рядом с пакетом)
2. `<cwd>/node_modules/@quobix/vacuum/bin/vacuum` (в корне workspace)
3. `which vacuum` (PATH lookup)

Если не найден — обёртка **падает при старте** с понятной ошибкой.

## Диагностика

- `source: vacuum-lsp` — все diagnostics приходят от этой обёртки
- `code` — ID правила (built-in или кастомного из ruleset)
- `severity` — мапится из vacuum severity (0=error, 1=warning, 2=info)

Smoke-тест после установки:

```bash
opencode debug lsp diagnostics path/to/your-spec.yaml
```

## Debug logging

Для диагностики проблем (особенно когда LSP возвращает неожиданные diagnostics) обёртка и rule-script'ы пишут отладочный лог в файл. **OpenCode 1.x strips env vars from child-process**, поэтому debug logging **file-based, не stderr-based**.

### Переменные окружения

| Variable | Default | Effect |
|---|---|---|
| `VACUUM_LSP_DEBUG_FILE` | `/tmp/vacuum-lsp-debug.log` | Путь к debug-логу (file-based) |
| `VACUUM_LSP_DEBUG=off` | — | Полностью отключает debug logging |

**Важно:** задать переменную **в среде OpenCode**, а не через shell при ручном запуске `opencode debug ...` — env должна быть видна child-process'у LSP-сервера. Самый надёжный способ — в `~/.bashrc` / `~/.zshrc` или в unit-файле systemd/TUI-launcher.

### Что логируется

- `rule-loader-init` — какие .js файлы плагинов найдены в `--rule-scripts` директории
- `stage2-start` — на каждый `didOpen`: filePath, длина text, наличие operationId в text, parsed paths keys, wrapperRoot, workspaceRootCwd
- `stage2-end` — сколько diagnostics вернули все плагины, краткий список (code + line + message)
- Plugin-side: всё, что плагин сам пишет через `debugLog(label, data)` (см. examples)

### Workflow отладки

1. Задай `VACUUM_LSP_DEBUG_FILE=/tmp/my-debug.log` в среде где стартует OpenCode.
2. Открой файл в редакторе или запусти `opencode debug lsp diagnostics path/to/file.yaml`.
3. Прочитай `/tmp/my-debug.log` — там будет ground-truth: что пришло в обёртку, что обёртка передала плагинам, что плагины вернули.
4. Нашёл аномалию → поправь код → повтори шаг 2. Diff в debug-логе покажет что изменилось.

### Пример: "плагин возвращает 0 diagnostics, но я знаю что должен найти проблему"

```
$ cat /tmp/vacuum-lsp-debug.log
[ts] rule-loader-init {"absDir":"/path/.opencode/rule-scripts","scriptFiles":["operationid-permission.js"]}
[ts] stage2-start {"filePath":"/path/foo.yaml","textHasOperationId":true,"parsedPathsKeys":["/x"]}
[plugin ts] loadPermissions-entry {"projectRoot":"/path","permissionsSize":0}
```

Если `permissionsSize=0`, но `parsedPathsKeys` показывает что operations есть — проблема в плагине: либо walk-up нашёл не ту `role_models/`, либо permissions пустой по другой причине. Смотри plugin code, добавь свой `debugLog` в нужное место.

## Пример ruleset

Минимальный пример `.opencode/vacuum-ruleset.yaml`:

```yaml
extends: [[vacuum:oas, recommended]]
rules:
  must-have-description:
    description: Every operation must have a description.
    given: $.paths[*][*]
    severity: warn
    then:
      field: description
      function: defined
```

## Известные ограничения

- OpenCode 1.x **не пробрасывает** `initializationOptions` через LSP `initialize` для кастомных серверов → нельзя настроить ruleset через `opencode.jsonc` поле `initialization`. Используйте `--ruleset` CLI-флаг.
- Обёртка спавнит `vacuum` subprocess на каждом `didChange` (с debounce) → для очень крупных спек (1000+ строк) latency может вырасти. Используйте `--debounce` побольше.
- Парсинг YAML через vacuum требует, чтобы файл был **валидным** — при YAML syntax errors vacuum возвращает ошибку в stderr, а stdout пустой → 0 diagnostics. Чиньте YAML сначала.

## Разработка

```bash
git clone https://github.com/<owner>/vacuum-opencode-lsp
cd vacuum-opencode-lsp
npm install
npm test
```

## Лицензия

MIT — см. [LICENSE](./LICENSE).

## Благодарности

- [daveshanley/vacuum](https://github.com/daveshanley/vacuum) — OpenAPI/AsyncAPI линтер
- [vscode-languageserver](https://github.com/microsoft/vscode-languageserver-node) — LSP-фреймворк
- Архитектурный паттерн заимствован из [dbml-lsp](https://github.com/holistics/dbml)