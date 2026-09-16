# vacuum-opencode-lsp

LSP wrapper over the [vacuum](https://github.com/daveshanley/vacuum) OpenAPI /
AsyncAPI / JSON Schema linter. Adds a `--ruleset` flag and an optional Node.js
plugin system, and bridges vacuum's `language-server` limitations inside
OpenCode, VS Code, IntelliJ, and any other LSP client.

## Installation

```bash
npm install -g @nikolay-grudanov/vacuum-opencode-lsp
```

The wrapper bundles the `vacuum` binary (pinned version) inside the npm
tarball, so no peer-dep install is required.

### Supported platforms

The bundled layout covers **two** platforms — the team that
consumes this package uses Linux x86_64 (CI default) and Windows
x86_64 (analyst day-to-day machines):

| OS | Arch | Bundled binary |
|---|---|---|
| linux | x86_64 | `bin/vacuum-linux-x64` |
| windows | x86_64 | `bin/vacuum-windows-x64.exe` |

Anything **not** in this table falls through to the existing
peer-dep / PATH fallback:

| OS | Arch | What happens |
|---|---|---|
| linux | arm64 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |
| darwin | x86_64 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |
| darwin | arm64 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |
| windows | arm64 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |
| linux | i386 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |
| windows | i386 | uses `@quobix/vacuum` peer-dep or `PATH` lookup |

The wrapper logs a clear error on startup if no binary resolves.
See ADR-0008 for the rationale and ADR-0006 for the original
wider bundle. Add-on platforms land via PRs that extend `TARGETS`
in `scripts/fetch-vacuum-binary.js` and `BINARY_NAME_FOR_PLATFORM`
in `index.js` in the same commit — keep them in sync.

## Usage as an LSP server

```bash
vacuum-opencode-lsp --stdio
```

For a project with custom rules, point at a ruleset:

```bash
vacuum-opencode-lsp --stdio --ruleset path/to/vacuum-ruleset.yaml
```

## Integration with OpenCode

Add to `.opencode/opencode.jsonc`:

```jsonc
{
  "lsp": {
    "vacuum-opencode-lsp": {
      "command": [
        "vacuum-opencode-lsp",
        "--stdio"
      ],
      "extensions": [".yaml", ".yml", ".json"]
    }
  }
}
```

OpenCode reloads its LSP config only on cold restart — restart the TUI after
editing `opencode.jsonc`.

To add custom rules, drop a `vacuum-ruleset.yaml` next to the project root
(or in `.opencode/`) and pass `--ruleset` explicitly. See the
[Two kinds of rules](#two-kinds-of-rules) section below.

## Integration with VS Code

Add to your VS Code `settings.json`:

```json
{
  "vacuum-opencode-lsp.command": "vacuum-opencode-lsp",
  "vacuum-opencode-lsp.args": ["--stdio"]
}
```

Or use any VS Code extension that supports a custom LSP server command.

## Integration with IntelliJ IDEA

1. Install the [LSP4IJ](https://github.com/redhat-developer/lsp4ij) plugin.
2. Go to **Settings → Languages & Frameworks → Language Server**.
3. Add a new server:
   - **Command:** `vacuum-opencode-lsp`
   - **Args:** `--stdio`

## Two kinds of rules

The wrapper supports two complementary extension points:

### 1. vacuum ruleset (YAML)

Declarative Spectral-format rules. Best for static checks that only need
the current document: presence of a field, value format, allowed
enumerations, etc.

`./.opencode/vacuum-ruleset.yaml`:

```yaml
extends: [[vacuum:oas, recommended]]
rules:
  operation-must-have-description:
    description: Every operation must have a description.
    given: $.paths[*][*]
    severity: warn
    then:
      field: description
      function: defined
```

Pass it on the command line:

```bash
vacuum-opencode-lsp --stdio --ruleset ./.opencode/vacuum-ruleset.yaml
```

### 2. Node.js plugin scripts (--rule-scripts)

For rules that don't fit YAML — cross-file I/O, reads from another spec,
async checks, anything that needs `fs`. Each `.js` file in the directory
exports one async function that returns LSP `Diagnostic[]`:

```js
// .opencode/rule-scripts/check-permissions.js
const fs = require('fs');

module.exports = async function rule(doc, context) {
  const perms = JSON.parse(fs.readFileSync('permissions.json', 'utf8'));
  const ops = Object.keys((doc.paths || {}));
  return ops
    .filter(op => !perms.some(p => p.name === op))
    .map(op => ({
      severity: 1,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      code: 'check-permissions:missing-permission',
      source: 'vacuum-lsp:rule-scripts',
      message: `operation "${op}" has no matching permission`,
    }));
};
```

```bash
vacuum-opencode-lsp --stdio \
  --ruleset ./.opencode/vacuum-ruleset.yaml \
  --rule-scripts ./.opencode/rule-scripts
```

Properties:

- One broken script → an error diagnostic, the others still run.
- `require` in plugins uses standard Node.js resolution. Wrapper-shipped
  deps (e.g. `js-yaml`) can be located with
  `require(require.resolve('js-yaml', { paths: [module.filename, context.wrapperRoot] }))`.
- `context.cache` is shared across `didChange` events within one LSP session
  for memoization.

## CLI flags

| Flag | Description | Default |
|---|---|---|
| `--stdio` | Use stdio for LSP transport (required for OpenCode / VS Code / IntelliJ) | always on |
| `--ruleset <path>`, `-r <path>` | Path to vacuum ruleset (`.yaml`) | `cwd/.opencode/vacuum-ruleset.yaml`, then `cwd/vacuum-ruleset.yaml` |
| `--rule-scripts <dir>` | Directory with Node.js plugin scripts | no plugins |
| `--debounce <ms>` | Delay before validation after `didChange` | `300` |
| `--timeout <ms>` | Subprocess timeout for `vacuum` | `10000` |
| `--help`, `-h` | Show usage and exit | — |

If no `--ruleset` is found, the wrapper runs vacuum's built-in `recommended`
ruleset only.

## Features

- Real-time validation of OpenAPI 3.x, AsyncAPI 2.x, and JSON Schema files
  (`.yaml`, `.yml`, `.json`).
- Custom Spectral-compatible ruleset via `--ruleset`.
- Optional Node.js plugin system for cross-artifact rules via `--rule-scripts`.
- `textDocument/publishDiagnostics` with proper line/column ranges.
- stdin + `--base` for correct `$ref` resolution across folders.
- Bundled `vacuum` binary — no peer-dep install or postinstall network call.
- Agent-friendly diagnostic messages — built-in vacuum rules like
  `no-$ref-siblings` are enriched with the OpenAPI family and a
  concrete repair hint (`allOf`, etc.) so the coding agent does not
  infer Swagger 2.0 from an OpenAPI 3.0.x violation. Custom rules
  and Stage 2 plugin diagnostics are passed through unchanged.
- Skill pack for AI agents (see [Skills](#skills) below) — three
  `SKILL.md` files cover LSP setup, declarative rule authoring, and
  JS plugin authoring, so an agent can scaffold correct `vacuum-ruleset.yaml`
  and `rule-scripts/*.js` files without re-deriving the contract.

## Skills

This repo ships a small set of `SKILL.md` files under [`skills/`](./skills)
for AI coding agents that work with `vacuum-opencode-lsp` in consumer
projects. They are the canonical reference for the LSP plugin contract,
Spectral rule patterns, and the `opencode.jsonc` wiring.

| Skill | When to load it | What it covers |
|---|---|---|
| [`lsp-setup`](./skills/lsp-setup/SKILL.md) | Wiring the LSP into a new or existing project | Installation (global npm vs local), `opencode.jsonc` for OpenCode / VS Code / IntelliJ, `--ruleset` / `--rule-scripts` / `--debounce` / `--timeout` flags, debug logging, cold-restart gotchas |
| [`vacuum-rule-authoring`](./skills/vacuum-rule-authoring/SKILL.md) | Writing static AST checks in `vacuum-ruleset.yaml` | Spectral format, `given` jsonpath patterns, built-in functions (`defined`, `truthy`, `pattern`, `enum`, `length`, `xor`, …), agent-friendly `message` templates, common pitfalls |
| [`rule-script-authoring`](./skills/rule-script-authoring/SKILL.md) | Writing cross-artifact checks in `rule-scripts/*.js` | Plugin contract (`async function rule(doc, context)` → `Diagnostic[]`), `source: 'vacuum-lsp:rule-scripts'`, `context.cache` memoization, dependency resolution via `require.resolve`, hot reload, standalone smoke tests |

Each skill references the relevant ADR in [`docs/adr/`](./docs/adr) and the
runtime example in [`examples/`](./examples), and is kept in sync with the
plugin contract defined in [ADR-0001](./docs/adr/0001-wrapper-side-plugin-loader.md).
If you publish a new version that changes the contract, update both the
SKILL.md files and the ADR in the same commit.

These skills are **not** installed by `npm install`. They are meant to be
loaded by an agent manually (e.g. `skill_view(name='lsp-setup')` in Hermes,
or copied verbatim into another agent's skill bank). The skills are also
useful as a human reference — they document the same contract the
`index.js` code follows.

## Known limitations

- Some LSP clients don't propagate `initializationOptions` to custom servers.
  Configure ruleset via the `--ruleset` CLI flag, not via `initialization`.
- The wrapper spawns `vacuum` on each `didChange` (with debounce). For very
  large specs (>1000 lines), increase `--debounce` to avoid jank.
- YAML syntax errors return an empty stdout from vacuum — you get 0
  diagnostics instead of the real parse error. Fix the YAML first.

## Debug logging

OpenCode 1.x strips env vars from child processes, so debug logging is
**file-based**, not stderr-based.

| Variable | Default | Effect |
|---|---|---|
| `VACUUM_LSP_DEBUG_FILE` | `/tmp/vacuum-lsp-debug.log` | Path to the debug log |
| `VACUUM_LSP_DEBUG=off` | — | Disable debug logging entirely |

Set the variable in the environment where OpenCode itself starts (e.g.
`~/.bashrc`, `~/.zshrc`, systemd unit) — not in the shell where you run
`opencode debug ...` manually.

## Development

```bash
git clone https://github.com/nikolay-grudanov/vacuum-opencode-lsp
cd vacuum-opencode-lsp
npm install
npm test
```

Tests cover the `--ruleset` flag and the `--rule-scripts` plugin contract.
`scripts/fetch-vacuum-binary.js` re-pulls the pinned `vacuum` binary into
`bin/vacuum` (used by `prepublishOnly`).

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- [daveshanley/vacuum](https://github.com/daveshanley/vacuum) — the
  OpenAPI/AsyncAPI linter at the core of this wrapper.
- [vscode-languageserver](https://github.com/microsoft/vscode-languageserver-node) —
  the LSP framework used.
- Architectural inspiration from
  [dbml-lsp](https://www.npmjs.com/package/dbml-lsp).
