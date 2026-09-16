---
name: vacuum-rule-authoring
description: "Создание декларативных правил в vacuum-ruleset.yaml (Spectral-формат) для vacuum-opencode-lsp — статические AST-проверки одного документа, такие как required-поля, формат значений, перечисления, $ref-политики, naming-conventions. Use when: агента просят добавить правило, описать политику, как задать чтобы поле X было обязательным, или нужна custom-проверка, которая не требует чтения других файлов (для cross-artifact — см. rule-script-authoring)."
---

# Создание правил в vacuum-ruleset.yaml

Этот skill — про **декларативные** Spectral-правила в YAML. Они работают через `jsonpath`/`given`-селектор над **одним** документом и применяются на каждом `didOpen/didChange`.

Если правилу нужен доступ к другим файлам (cross-artifact join, async I/O, HTTP-запросы), нужен **JS-плагин** через `--rule-scripts` — см. `rule-script-authoring`.

## Когда использовать, а когда — нет

| Задача | Инструмент |
|---|---|
| «operationId должен существовать» | ruleset YAML |
| «description обязательно у каждой operation» | ruleset YAML |
| «status code только из списка {200,201,204,400,404,500}» | ruleset YAML |
| «имя поля в snake_case» | ruleset YAML |
| «operationId должен быть в role_models/permissions.yaml» | **rule-script** |
| «X-Schema-Id должен ссылаться на реальный файл» | **rule-script** |
| «внешний $ref (https://...) запрещён» | ruleset YAML (`pattern`-функция) |

Ключевой критерий: **всё, что можно выразить как jsonpath-селектор над одним файлом + builtin-функцию** — YAML. Остальное — JS.

## Минимальный шаблон

```yaml
# .opencode/vacuum-ruleset.yaml
extends: [[vacuum:oas, recommended]]   # базовые 60+ правил для OpenAPI

rules:
  operation-must-have-summary:
    description: Every operation must have a summary (one-liner, shown in UI).
    message: "{{property}} must have a summary"
    severity: warn     # error | warn | info
    given: $.paths[*][*]   # jsonpath: все HTTP-методы всех путей
    then:
      field: summary
      function: defined
```

Положить в `.opencode/vacuum-ruleset.yaml` (предпочтительно) или в `cwd/vacuum-ruleset.yaml`.

Подключить:

```jsonc
"command": [
  "vacuum-opencode-lsp", "--stdio",
  "--ruleset", "./.opencode/vacuum-ruleset.yaml"
]
```

(или через `extends`/`--ruleset` в CLI wrapper'а).

## Анатомия правила

```yaml
<rule-id>:
  description: <человеческое описание>
  message: <шаблон сообщения, поддерживает {{property}}, {{value}}, {{path}}>
  severity: error | warn | info
  given: <jsonpath селектор>
  then:
    field: <jsonpath относительно узла given>
    function: <имя функции>
    functionOptions:
      <option>: <value>
```

- **`given`** — точка входа. Результат селектора = набор узлов, к которым применяется `then`.
- **`then.field`** — что внутри узла проверять. Можно не указывать, если проверяем сам узел (`truthy`, `pattern`).
- **`then.function`** — что делать (см. builtin-функции ниже).

## Built-in функции (встроенные)

| Функция | Что делает | Когда использовать |
|---|---|---|
| `truthy` | Значение не null/undefined/empty string | «поле должно быть заполнено» |
| `defined` | Поле **существует** в объекте | «обязательное поле» |
| `falsy` | Обратное `truthy` | редко |
| `pattern` | Regex-match по строке | имена, ID, форматы |
| `enum` | Значение ∈ списку | статусы, методы, content-type |
| `schema` | Соответствие JSON Schema | сложные структурные проверки |
| `length` | Длина строки/массива в диапазоне | минимальная длина пароля и т.п. |
| `alphabetical` | Ключи в алфавитном порядке | редко |
| `xor` / `xone` | Ровно/хотя бы одно из полей | `oneOf`-подобные правила |
| `undefined` | Поле **отсутствует** | запрет полей (вместо allowed-полисы) |

Полный список с примерами: [документация Spectral](https://stoplight.io/open-source/spectral) и вывод `vacuum functions list`.

## Расширенные функции (нужен `functions` блок)

Сложные кастомные функции (`pattern-from-description`, `casing`, `uniqueproperties` etc.) подключаются через spectral functions. Vacuum поддерживает свой набор встроенно. Чтобы добавить нестандартные — регистрируй через `--functions <dir>` (НЕ путать с `--rule-scripts`!).

## JSONPath-подсказки для OpenAPI

```yaml
given: $                                  # весь документ
given: $.paths                            # все пути
given: $.paths[*]                         # все path-item'ы
given: $.paths[*][*]                      # все операции (методы всех путей)
given: $.paths[*].get                     # только GET'ы
given: $.components.schemas[*]            # все схемы
given: $.components.schemas.*.properties  # все properties схем (но не вложенных!)
given: $..parameters                      # все parameters (deep)
given: $..['x-*']                         # все extension keys
```

**Подводный камень:** `$.components.schemas[*].properties` НЕ рекурсивен — пропускает вложенные объекты в property. Для recursive обхода: `$..properties` (через `$..`).

## Рабочие паттерны

### 1. Обязательное поле на каждой operation

```yaml
operation-must-have-summary:
  description: Every operation must have a summary.
  message: "operation {{property}} must have a summary"
  severity: warn
  given: $.paths[*][*]
  then:
    field: summary
    function: defined
```

### 2. Длина строки

```yaml
operation-summary-not-too-short:
  description: Operation summary must be at least 10 chars.
  message: "{{property}} summary too short, expected >= 10 chars"
  severity: info
  given: $.paths[*][*]
  then:
    field: summary
    function: length
    functionOptions:
      min: 10
```

### 3. Значение из enum

```yaml
operation-success-status-only-standard:
  description: Success responses only from standard set.
  message: "status code {{value}} not in standard set"
  severity: warn
  given: $.paths[*][*].responses
  then:
    field: "[?(!@property.startsWith('5') && !@property.startsWith('4') && !@property.startsWith('2'))]"
    function: falsy
```

Короче и надёжнее через `enum`:

```yaml
http-status-must-be-valid:
  description: HTTP status codes must be standard.
  message: "{{property}} is not a known HTTP status code"
  severity: warn
  given: $.paths[*][*].responses
  then:
    field: "@key"
    function: enum
    functionOptions:
      values:
        - "200" - "201" - "204" - "301" - "400" - "401" - "403" - "404" - "409" - "422" - "500" - "503"
```

### 4. Шаблон имени / ID

```yaml
operation-id-kebab-case:
  description: operationId must be kebab-case.
  message: "{{property}} is not kebab-case (expected /^[a-z][a-z0-9-]*$/)"
  severity: warn
  given: $.paths[*][*]
  then:
    field: operationId
    function: pattern
    functionOptions:
      match: "^[a-z][a-z0-9-]*$"
```

### 5. Запрет extension'ов (любые, кроме whitelisted)

```yaml
no-deletable-headers:
  message: "{{property}} header is forbidden"
  given: $..headers
  then:
    field: "@key"
    function: pattern
    functionOptions:
      notMatch: "^(X-|x-).*"   # запрещаем ВСЕ заголовки (для примера)
```

### 6. Cross-field XOR (нужно одно из двух)

```yaml
request-body-or-parameters:
  description: Each operation has either requestBody OR parameters.
  message: "operation needs requestBody or parameters"
  severity: error
  given: $.paths[*][*]
  then:
    field: requestBody
    function: xor
    functionOptions:
      properties:
        - parameters
```

### 7. Использовать `severity`

`error` — блокирует CI / PR (зависит от настроек), `warn` — в редакторе как warning squiggle, `info` — хинт.

Для агентов, которые читают diagnostics: **`severity: warn` или `error` важнее, чем `info`** — info часто игнорируется UI редактора.

## Наследование и композиция

```yaml
# Стандартный набор:
extends: [[vacuum:oas, recommended]]

# Конкретный built-in:
extends: [[vacuum:oas, operation-operationId-unique]]

# Несколько источников:
extends:
  - [[vacuum:oas, recommended]]
  - ./shared-ruleset.yaml    # локальный extends
```

`extends` мерджит правила из источника. Твоё правило с тем же именем **перекрывает** extended.

## Message templates — для агентов

Wrapper обогащает built-in сообщения (no-$ref-siblings → подсказывает `allOf`, и т.п.), но **твои custom rule'ы проходят как есть**. Это значит: пиши `message` так, чтобы агент сразу понял, что чинить. ([ADR-0007](../../docs/adr/0007-enrich-diagnostics-for-agents.md))

**Плохо:**
```yaml
message: "invalid"
```

**Хорошо:**
```yaml
message: "Operation {{property}} at {{path}} is missing field 'summary'. Add a one-line description (shown in OpenAPI Explorer)."
```

Доступные переменные:
- `{{property}}` — имя поля / id правила
- `{{value}}` — текущее значение
- `{{path}}` — JSONPath до узла
- `{{description}}` — описание правила

## Тестирование правила вручную

```bash
# Vacuum CLI напрямую (быстрее итерации):
npx @quobix/vacuum lint \
  --ruleset ./.opencode/vacuum-ruleset.yaml \
  openapi/service-a.yaml

# С фильтром по rule id:
npx @quobix/vacuum lint --ruleset ... openapi/*.yaml 2>&1 | grep operation-must-have-summary
```

Если YAML невалиден — `vacuum lint` ругается на парсинг. Если правило молчит — проверь `given` (частая ошибка — `$.paths.[*]` вместо `$.paths[*]`).

## Anti-patterns

- ❌ **Длинные custom chains через `functions`-директорию** для Goja-runtime → `vacuum` НЕ передаёт `fs` в Goja. Если нужно прочитать файл — это `--rule-script`, а не custom function.
- ❌ **`given: $..properties`** без оговорок → проверяет **всё** поле `properties` в схемах, включая чужие. Уточняй: `$..[?(@.type === 'object')].properties`.
- ❌ **`severity: info` для важных правил** — агенты их игнорируют.
- ❌ **`then: { function: schema }` без указания `schema`** — вакуум использует default OpenAPI-schema, часто не то что ты хочешь.
- ❌ **Хардкодить `message` без `{{property}}` / `{{path}}`** — агенту приходится гадать, о чём речь.

## Отладка: правило не срабатывает

Чек-лист:

1. ☐ YAML валиден? (`npx @quobix/vacuum lint --ruleset <ruleset> <file>` покажет ошибку парсинга).
2. ☐ `given` селектор резолвится? Запусти `--format json` и посмотри `results[].path`.
3. ☐ `then.field` существует в узле? Частая ошибка — задать `field: tags` когда в Operation он называется `tags` (ok) vs `tags.foo` (не существует — нет эффекта).
4. ☐ Имя правила уникально в рамках ruleset? Дубликат → берётся последнее.
5. ☐ `extends` не перекрывает твоё правило? Имя совпадает → extended **перезаписывается** при merge'е (не перекрывается вниз).

## Связанные skills

- `lsp-setup` — подключение LSP в проекте.
- `rule-script-authoring` — для cross-artifact правил (нужен `fs`).
- `vacuum-opencode-lsp-development` — изменение самого wrapper'а.

## Ссылки

- README wrapper'а: [../../README.md](../../README.md)
- Spectral documentation: https://stoplight.io/open-source/spectral
- Полный список vacuum rules: `npx @quobix/vacuum rules`
- Полный список vacuum functions: `npx @quobix/vacuum functions list`
- ADR-0007 (обогащение diagnostics): [../../docs/adr/0007-enrich-diagnostics-for-agents.md](../../docs/adr/0007-enrich-diagnostics-for-agents.md)
