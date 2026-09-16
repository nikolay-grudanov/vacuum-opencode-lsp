# Skills для vacuum-opencode-lsp

Эта папка содержит скилы для **агентов**, работающих с `vacuum-opencode-lsp` в потребительских проектах. Авторы самих правил (YAML или JS-плагинов) — главные пользователи.

## Карта скилов

| Skill | Когда | Что внутри |
|---|---|---|
| [`lsp-setup/`](./lsp-setup/SKILL.md) | Подключение LSP в OpenCode/VSCode/IntelliJ, выбор флагов, debug-логи | Установка wrapper, `opencode.jsonc`, hot-restart, troubleshooting |
| [`vacuum-rule-authoring/`](./vacuum-rule-authoring/SKILL.md) | Создание декларативных правил в `vacuum-ruleset.yaml` | Spectral-формат, jsonpath, builtin-функции, типичные паттерны |
| [`rule-script-authoring/`](./rule-script-authoring/SKILL.md) | Создание JS-плагинов в `rule-scripts/` | Plugin contract, Diagnostic[], context.cache, cross-artifact join |

## Когда какой скил подгружать

- **Новый проект без LSP** — начни с `lsp-setup`.
- **Уже подключён, нужны новые статические правила** — `vacuum-rule-authoring`.
- **Правило требует чтения других файлов / async / HTTP** — `rule-script-authoring`.
- **Изменение самого wrapper'а** — это **не** этот набор (см. `~/.hermes/skills/vacuum-opencode-lsp-development/` для maintainer'а).

## Связь с примерами в репозитории

| Skill | Живой пример |
|---|---|
| `lsp-setup` | [`../examples/opencode.jsonc.snippet`](../examples/opencode.jsonc.snippet) |
| `vacuum-rule-authoring` | рекомендованные правила `vacuum:oas, recommended` (встроенные) |
| `rule-script-authoring` | [`../examples/rule-scripts/example-operationid-permission.js`](../examples/rule-scripts/example-operationid-permission.js) |

## Расширение набора

Эти скилы покрывают три базовых потока. Если появятся новые частые задачи (например, «генерация CI-конфига для rule-scripts», «миграция с spectral-cli на vacuum-opencode-lsp», «написание тестов для правил») — добавляй SKILL.md в свою подпапку. Именование: lowercase, hyphens, существительное-описывает-результат.
