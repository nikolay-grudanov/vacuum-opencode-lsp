---
name: lsp-setup
description: "Подключение vacuum-opencode-lsp в проекте (OpenCode / VS Code / IntelliJ) — установка wrapper, настройка opencode.jsonc, выбор CLI-флагов (--ruleset, --rule-scripts, --debounce, --timeout), настройка debug-логирования. Use when: agent запускается в новом проекте с OpenAPI/AsyncAPI/JSON-Schema артефактами и нужно включить real-time линтинг в редакторе, или пользователь просит подключить вакуум, настроить lsp, добавить валидацию openapi."
---

# Настройка vacuum-opencode-lsp в проекте

Этот skill — про **подключение и конфигурацию** LSP-сервера в потребительском проекте. Не про сам wrapper (см. vacuum-opencode-lsp-development), не про написание правил (см. vacuum-rule-authoring, rule-script-authoring).

## Когда загружать

- Пользователь говорит: «подключи вакуум-LSP», «настрой валидацию openapi», «добавь lsp в opencode».
- Агент видит в проекте `.opencode/`, `openapi/`, `asyncapi/`, или `*.yaml` со схемами, но нет `vacuum-opencode-lsp` в LSP-конфиге.
- После клонирования проекта — проверить, что LSP подключён.
- При апгрейде wrapper (новый major version) — обновить конфиг.

## Что такое vacuum-opencode-lsp

Node.js-обёртка над CLI-линтером `@quobix/vacuum` (Go), работает как LSP через stdio. Поддерживает OpenAPI 3.x, AsyncAPI 2.x, JSON Schema. Два extension point'а:

| Flag | Для чего | Файл/директория |
|---|---|---|
| `--ruleset <path>` | Декларативные Spectral-правила (статический AST одной document) | `vacuum-ruleset.yaml` |
| `--rule-scripts <dir>` | Node.js-плагины для cross-artifact правил (нужен `fs`, async, чтение других файлов) | `rule-scripts/*.js` |

Wrapper решает одну архитектурную проблему: вакуум не передаёт ruleset через `InitializationOptions` / `didChangeConfiguration`, только через CLI-флаги. А OpenCode 1.x читает LSP-конфиг **только при cold start** и не пробрасывает options. Wrapper = bridge. ([ADR-0001](../docs/adr/0001-wrapper-side-plugin-loader.md))

## Установка wrapper

### Вариант 1: глобально в npm (предпочтительно)

```bash
npm install -g @nikolay-grudanov/vacuum-opencode-lsp
```

Wrapper таскает бинарь `vacuum` внутри npm-tarball'а (Linux x64 / Windows x64). Никаких peer-deps или postinstall-сетевых вызовов. Для остальных платформ — fallback на `@quobix/vacuum` peer-dep или PATH lookup. ([ADR-0008](../docs/adr/0008-narrow-supported-platforms.md))

### Вариант 2: локально в проекте (для CI / hermetic builds)

```bash
npm install --save-dev @nikolay-grudanov/vacuum-opencode-lsp
```

Команда тогда:

```jsonc
"command": [
  "node",
  "./node_modules/@nikolay-grudanov/vacuum-opencode-lsp/index.js",
  "--stdio",
  "--ruleset", "./.opencode/vacuum-ruleset.yaml",
  "--rule-scripts", "./.opencode/rule-scripts"
]
```

## Подключение в OpenCode

В `.opencode/opencode.jsonc` (или `~/.config/opencode/opencode.jsonc` для global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "vacuum-opencode-lsp": {
      "command": [
        "node",
        "./.opencode/node_modules/@nikolay-grudanov/vacuum-opencode-lsp/index.js",
        "--stdio",
        "--ruleset", "./.opencode/vacuum-ruleset.yaml",
        "--rule-scripts", "./.opencode/rule-scripts"
      ],
      "extensions": [".yaml", ".yml", ".json"]
    }
  }
}
```

Если wrapper установлен глобально:

```jsonc
"command": ["vacuum-opencode-lsp", "--stdio", "--ruleset", "./.opencode/vacuum-ruleset.yaml"]
```

**Важно:** OpenCode перечитывает LSP-конфиг только при cold restart. После правки `opencode.jsonc` → restart TUI.

## Подключение в VS Code

В `.vscode/settings.json`:

```json
{
  "vacuum-opencode-lsp.command": "vacuum-opencode-lsp",
  "vacuum-opencode-lsp.args": ["--stdio", "--ruleset", "./.opencode/vacuum-ruleset.yaml"]
}
```

Или через любое LSP-совместимое расширение (SaratogaSF / vscode-custom-lsp и т.п.).

## Подключение в IntelliJ IDEA

1. Установить плагин [LSP4IJ](https://github.com/redhat-developer/lsp4ij).
2. **Settings → Languages & Frameworks → Language Server → Add:**
   - Command: `vacuum-opencode-lsp`
   - Args: `--stdio --ruleset ./.opencode/vacuum-ruleset.yaml`
3. File → Invalidate caches (cold start LSP).

## Минимальная структура проекта

```
project-root/
├── .opencode/
│   ├── opencode.jsonc          # LSP-конфиг
│   ├── vacuum-ruleset.yaml     # декларативные правила
│   └── rule-scripts/           # JS-плагины (опционально)
│       └── check-permissions.js
└── openapi/                    # спецификации (или другое имя)
    └── service-a.yaml
```

Если `--ruleset` не передан, wrapper ищет в порядке: `cwd/.opencode/vacuum-ruleset.yaml`, затем `cwd/vacuum-ruleset.yaml`. Если ничего не нашёл — работает vacuum built-in `recommended` (40+ базовых правил для OpenAPI).

## Полезные флаги

| Flag | Что делает | Default |
|---|---|---|
| `--ruleset <path>`, `-r <path>` | Spectral ruleset YAML | `cwd/.opencode/vacuum-ruleset.yaml` → `cwd/vacuum-ruleset.yaml` |
| `--rule-scripts <dir>` | Директория с `.js` плагинами | отключено (Stage 2 не выполняется) |
| `--debounce <ms>` | Задержка перед валидацией после `didChange` | `300` |
| `--timeout <ms>` | Таймаут subprocess'а vacuum | `10000` |

**Большие спеки (>1000 строк):** поднять `--debounce` до `500–700`, чтобы не было jank при быстром наборе.

**Медленные cross-artifact правила:** кешируй прочитанные файлы через `context.cache` (см. rule-script-authoring). Тяжёлые операции — open issue, пока в обход через `--debounce`.

## Известные ограничения

1. **Некоторые LSP-клиенты не пробрасывают `initializationOptions`.** Конфигурируй ruleset через CLI-флаг `--ruleset`, не через `initialization`.
2. **YAML syntax error → пустой stdout** от vacuum → 0 диагностик вместо настоящей ошибки парсинга. Сначала валидируй YAML (`yamllint`, `node -e "yaml.load(...)"`).
3. **Без `--ruleset` → только built-in `recommended`** — некоторые команды этого не знают и думают, что LSP не работает.

## Debug-логирование

OpenCode 1.x режет env vars у child-процессов → stderr-based логи не доходят. Wrapper пишет в файл.

| Env var | Default | Что делает |
|---|---|---|
| `VACUUM_LSP_DEBUG_FILE` | `/tmp/vacuum-lsp-debug.log` | Путь к лог-файлу |
| `VACUUM_LSP_DEBUG=off` | — | Полностью отключить логирование |

Выставлять переменные нужно **в окружении, где стартует сам OpenCode** (`~/.bashrc`, `~/.zshrc`, systemd unit), а не в shell, из которого ты запускаешь `opencode debug ...`.

Просмотр в реальном времени:

```bash
tail -f /tmp/vacuum-lsp-debug.log
```

## Проверка, что LSP работает

```bash
# Изнутри OpenCode:
opencode debug lsp diagnostics openapi/service-a.yaml

# Должно быть:
# - diagnostics с source 'vacuum' (от Stage 1)
# - diagnostics с source 'vacuum-lsp:rule-scripts' (от Stage 2, если подключены)
```

Если diagnostics пустые — сначала проверь валидность YAML (см. ограничение #2).

## Anti-patterns

- ❌ Использовать `vacuum-opencode-lsp` без `--ruleset` в проекте с кастомными политиками → молча работает только built-in `recommended`.
- ❌ Передавать `ruleset` через `initializationOptions` → игнорируется у половины клиентов.
- ❌ Забыть рестартить OpenCode TUI после правки `opencode.jsonc` → старый конфиг продолжает действовать.
- ❌ Указывать путь к rule-scripts без `require.resolve` для wrapper-shipped deps → `Cannot find module 'js-yaml'` в плагинах.

## Чек-лист при подключении в новый проект

1. ☐ Установить wrapper (`npm install -g` или local).
2. ☐ Создать `.opencode/opencode.jsonc` с LSP-конфигом.
3. ☐ Создать `.opencode/vacuum-ruleset.yaml` (минимум `extends: [[vacuum:oas, recommended]]`).
4. ☐ *(опционально)* Создать `.opencode/rule-scripts/` если нужны cross-artifact правила.
5. ☐ **Cold restart** OpenCode / VS Code / IntelliJ.
6. ☐ Открыть любой OpenAPI-файл → проверить, что появились diagnostics.
7. ☐ *(если нужно)* Настроить `VACUUM_LSP_DEBUG_FILE` для логов.

## Связанные skills

- `vacuum-rule-authoring` — как писать правила в `vacuum-ruleset.yaml`.
- `rule-script-authoring` — как писать JS-плагины в `rule-scripts/`.
- `vacuum-opencode-lsp-development` — изменение самого wrapper (для maintainer'а).

## Ссылки

- README wrapper'а: [../../README.md](../../README.md)
- ADR-0001 (plugin loader): [../../docs/adr/0001-wrapper-side-plugin-loader.md](../../docs/adr/0001-wrapper-side-plugin-loader.md)
- ADR-0008 (supported platforms): [../../docs/adr/0008-narrow-supported-platforms.md](../../docs/adr/0008-narrow-supported-platforms.md)
- Примеры: [../../examples/](../../examples/)
