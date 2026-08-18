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

The bundled layout covers the 5 mainstream platforms:

| OS | Arch | Bundled binary |
|---|---|---|
| linux | x86_64 | `bin/vacuum-linux-x64` |
| linux | arm64 | `bin/vacuum-linux-arm64` |
| darwin | arm64 | `bin/vacuum-darwin-arm64` |
| windows | x86_64 | `bin/vacuum-windows-x64.exe` |
| windows | arm64 | `bin/vacuum-windows-arm64.exe` |

Consumers on **darwin-x86_64**, **linux-i386**, or **windows-i386**
fall through to the `@quobix/vacuum` peer-dep (when installed)
or a `vacuum` binary on `PATH`. The wrapper logs a clear error
on startup if no binary is found. See ADR-0006 for the rationale.

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
