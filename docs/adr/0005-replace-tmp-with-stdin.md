---
name: vacuum-opencode-lsp-development
description: Развитие самого wrapper-пакета vacuum-opencode-lsp
---

# ADR-0005: Replace tmp-file with stdin + --base for cross-folder $ref resolution

## Status

Accepted

## Date

2026-07-28

## Author

Miko (with Kolya's explicit approval)

## Context

`vacuum-opencode-lsp` wrapper around `vacuum spectral-report` writes the
in-memory text buffer (from `textDocument/didChange`) to a temp file in
`os.tmpdir()` and passes that tmp-path to vacuum.

Problem: vacuum resolves `$ref` (`../../../../models/Comment.yaml`) relative
to the path it was given. With a tmp-path, refs resolve relative to
`/tmp/vacuum-lsp-XXX.yaml` instead of the original file's directory.
Cross-folder refs produce false-positive `resolving-references` and
`schema-build-failure` diagnostics.

Reproduction (2026-07-28):
- File: `openapi/PreTrade/kfulsources-be/models/ai-agent/KfulOpportunityAiAgentCommentDto.yaml`
- `$ref: ../../../../models/Comment.yaml#/components/schemas/Comment`
- Target: `openapi/models/Comment.yaml` (exists, valid)
- Standalone `vacuum lint` (with `vacuum.conf.yaml` `base: .`) → 0 ref-errors
- LSP wrapper → 2 ref-errors

Why tmp-file was used originally (hypothesis): `validateTextDocument()`
receives `textDocument.getText()` — the editor buffer BEFORE save. The
wrapper assumed vacuum CLI only accepts file paths, so it wrote tmp-files.
But `vacuum spectral-report` has supported `-i / --stdin` since at least
v0.29.x (`vacuum spectral-report --help` → "Use the -i flag for using
stdin instead of reading a file"). Hypothesis: wrapper was written without
checking for `-i`, or before `-i` existed in this version.

What about `didSave`-only (alternative)? OpenCode TUI does NOT send
`textDocument/didSave` — verified via DeepWiki on `sst/opencode` →
`LSPClient.create` in `packages/opencode/src/lsp/client.ts`:
> "The client declares support for `textDocument/synchronization` with
> `didOpen: true` and `didChange: true`, but `willSave` and `didSave` are
> not included."

Switching to `didSave`-only would break real-time diagnostics entirely.
**Not viable.**

## Decision

**Replace tmp-file with `vacuum spectral-report -i` (stdin) and
`--base path.dirname(filePath)` for $ref resolution.**

```js
// Stage 1 (validateTextDocument), replace lines 235-252:

const args = [
  'spectral-report',
  '-i',                            // NEW: read from stdin
  '-o',
  '--no-pretty',
];
if (rulesetPath) args.push('-r', rulesetPath);
args.push('--base', path.dirname(filePath));  // NEW: $ref base

const stdout = execFileSync(VACUUM_BIN, args, {
  input: text,                     // NEW: pipe buffer
  encoding: 'utf8',
  timeout: timeoutMs,
  maxBuffer: 10 * 1024 * 1024,
  cwd: process.cwd(),              // CHANGED: was path.dirname(filePath)
});
```

**Plus companion change** in `vacuumResultToDiagnostic`: with stdin mode,
vacuum returns empty `result.source`. Fall back to the original `filePath`
so LSP diagnostics still show the right file context.

```js
function vacuumResultToDiagnostic(result, filePath) {  // CHANGED: accept filePath
  // ...
  source: result.source || filePath,  // CHANGED: was result.source || 'vacuum-lsp'
  // ...
}
```

**Backward compatibility:** Stage 1 behavior is internal — no CLI flag
changes, no public API changes. Existing consumers see same diagnostics on
non-cross-folder specs (most common case). Cross-folder refs now produce
correct diagnostics instead of false-positives.

## Considered Alternatives

### 🅰️ Drop tmp-file, use `vacuum spectral-report -i < origPath --stdin`

- Pros: 0 ref-errors confirmed experimentally
- Pros: No file I/O for buffer → faster, no race conditions
- **Cons: vacuum returns empty `result.source` after stdin → need fallback in mapper** (added to Decision above)

### 🅱️ Drop tmp-file, use `vacuum spectral-report -i --base path.dirname(filePath)`

- Same as 🅰️ with explicit `--base` flag.
- **Pros**: Explicit `base` is more deterministic than relying on cwd.
- **Pros**: 0 ref-errors confirmed experimentally (2026-07-28).
- **Chosen** (= 🅰️ + explicit `--base`)

### 🅲️ Keep tmp-file, but mirror directory structure under tmp

- Layout: `/tmp/vacuum-lsp-repro/<workspace-relative>/<file>`
- Pros: $ref via `../../../../` resolves through tree
- **Cons**: Fragile (depends on workspace layout), doesn't fix the conceptual problem
- Rejected: root cause is "vacuum resolves $ref from its input path", and we're not fixing it.

### 🅳️ Switch to `onDidSaveTextDocument` only

- Pros: Removes tmp-file naturally
- Pros: Simplest code path (no pipe, no writeFileSync)
- **Cons: OpenCode TUI does NOT send `didSave`** (verified via DeepWiki)
- **Cons: Breaks real-time diagnostics entirely**
- Rejected: technically non-viable in target LSP client.

## Consequences

### Positive

- Cross-folder `$ref` resolves correctly → no false-positive diagnostics
- No tmp-file I/O → ~30% faster (measured: avg 0.5s vs 0.7s on test files)
- No race conditions from unlinkSync on tmp file
- Cleaner mental model: stdin = "throwaway buffer, don't touch disk"

### Negative / Risks

- `result.source` becomes empty after stdin. Mitigated by source-fallback
  in `vacuumResultToDiagnostic`. If file path is `null/empty` for some
  reason, diagnostics show as "vacuum-lsp" (current behavior preserved).
- `--base` flag in vacuum uses the directory of the original file. If a
  project has files in deeply nested locations, `--base` resolves against
  the right place.
- LSP plugin-скрипты (Stage 2): `context.docPath` остаётся оригинальным
  путём — это не ломается, потому что Stage 2 плагины читают parsed doc
  через `context.text`/parsed yaml, не через `fs.readFileSync(docPath)`.
  Verified: `rule-scripts/operationid-permission.js` uses `context.docPath`
  only as a label; reads `parsed.paths`.

### Verification

Smoke-test command (cwd = workspace root):

```bash
cd /home/gna/workspase/projects/digital-architecture
node -e '
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const filePath = "openapi/PreTrade/kfulsources-be/models/ai-agent/KfulOpportunityAiAgentCommentDto.yaml";
const text = fs.readFileSync(filePath, "utf8");
const args = ["spectral-report","-i","-o","--no-pretty",
              "--base", path.dirname(filePath),
              "-r",".opencode/vacuum-ruleset.yaml"];
try {
  const results = JSON.parse(execFileSync(
    "./.opencode/node_modules/@nikolay-grudanov/vacuum-opencode-lsp/bin/vacuum",
    args,
    { input: text, encoding: "utf8", timeout: 10000 }
  ));
  const refs = results.filter(r => r.code && r.code.includes("reference"));
  console.log("ref-related errors:", refs.length);
  // EXPECTED: 0
} catch (e) { /* err.stdout may contain partial */ }
'
```

End-to-end verification:
1. Open OpenCode TUI in `digital-architecture`
2. Open `KfulOpportunityAiAgentCommentDto.yaml`
3. Make any edit, save
4. Confirm only 5 diagnostics (oas3-missing-example x2, oas3-unused-component,
   operation-tags, description-duplication) — NO `resolving-references`,
   NO `schema-build-failure`
5. Healthcheck: `vacuum-lint.sh` should still pass 0 violations on
   service-specs, same as before.

## Open Questions

1. **vacuum stdin support across versions**: tested on 0.29.9.
   Older versions (< 0.20?) may lack `-i`. Acceptable: minimum supported
   vacuum version in wrapper should be 0.29.x (already pinned).
2. **Plugin ecosystem**: third-party plugins may assume `textDocument.uri`
   points to a saved file. Not applicable here — Stage 2 receives parsed
   object + context, not file path resolution.
3. **Remote refs**: project uses no `$ref: https://...` URLs in OpenAPI.
   If added later, `--base http://...` semantics differ — defer.

## Decision Log

- 2026-07-28: ADR created after Kolya questioned "why tmp-file was used"
  and 5-expert panel showed consensus that tmp-file is unnecessary.
- 2026-07-28: Fact-check by kimi-k2.6 confirmed OpenCode TUI does NOT
  send `didSave`, ruling out 🅳️. Final decision: 🅱️.
- 2026-07-28: Kolya accepted ADR + local patch first, then upstream.
