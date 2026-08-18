---
name: vacuum-opencode-lsp-development
description: Развитие самого wrapper-пакета vacuum-opencode-lsp
---

# ADR-0007: Enrich vacuum diagnostics for coding agents

## Status

Accepted

## Date

2026-08-07

## Author

Miko (with Kolya's explicit approval)

## Context

`vacuum-opencode-lsp` translates the Spectral-compatible JSON emitted by
`vacuum spectral-report` into LSP `Diagnostic` objects and publishes them to
OpenCode and other LSP clients.

A real OpenCode 1.18.8 incident exposed a loss-of-context problem. Vacuum
correctly detected this invalid OpenAPI 3.0.1 schema:

```yaml
items:
  description: Код десков
  $ref: ../../../../models/Code.yaml#/components/schemas/Code
```

The built-in vacuum rule `no-$ref-siblings` returned a diagnostic, but the
coding agent saw only:

```text
ERROR [122:20] a `$ref` cannot be placed next to any other properties
```

The agent was not shown the rule ID, OpenAPI dialect, violated object, reason,
or repair pattern. It incorrectly inferred that the document had been checked
as Swagger/OpenAPI 2.0 rather than OpenAPI 3.0.1.

The underlying validation was correct: OpenAPI 3.0.x does not allow sibling
properties next to a schema `$ref`. The actionable repair is to move the
sibling property into the referenced schema or compose the reference through
`allOf`:

```yaml
items:
  description: Код десков
  allOf:
    - $ref: ../../../../models/Code.yaml#/components/schemas/Code
```

### Measured data-loss chain

The behavior below was verified against bundled vacuum 0.29.9, the wrapper
source at v0.5.0, and the locally installed OpenCode 1.18.8 binary.

1. `vacuum spectral-report` returns fields including:
   - `severity`
   - `range`
   - `message`
   - `code`
   - `source`
   - `path`
2. `vacuumResultToDiagnostic()` currently preserves `severity`, `range`,
   `message`, `code`, and `source`, but discards Spectral `path`.
3. The wrapper publishes the result through
   `textDocument/publishDiagnostics`.
4. OpenCode stores the full LSP diagnostic, but its model-visible formatter is:

```ts
function pretty(diagnostic) {
  const severity = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${severity} [${line}:${col}] ${diagnostic.message}`
}
```

5. `LSP.Diagnostic.report()` shows only severity-1 diagnostics and at most 20
   diagnostics per file. It does not render `code`, `source`, `data`,
   `relatedInformation`, or `codeDescription` into the text received by the
   agent.

Therefore `Diagnostic.message` is the only field guaranteed to carry semantic
repair context into the OpenCode coding-agent feedback loop.

### Related protocol problem

The wrapper currently places vacuum's document path from `result.source` into
LSP `Diagnostic.source`. That field is intended to identify the diagnostic
engine (for example, `vacuum-lsp`), not the affected file. The affected file is
identified by `PublishDiagnosticsParams.uri`; optional cross-file context can
also be represented through `relatedInformation`.

This mapping problem is especially visible when vacuum reports a violation in
an externally referenced YAML document while the wrapper publishes every
result under the URI of the open root document.

## Decision

Kolya explicitly decided: **"Давай создадим новый adr на то чтоб сообщение
обогащать для агента".**

We will add a deterministic, wrapper-side diagnostic-enrichment layer before
constructing LSP `Diagnostic` objects.

The layer will make every Stage 1 vacuum error self-contained enough for a
coding agent that can see only:

```text
SEVERITY [line:column] message
```

### 1. Generic visible contract

Every Stage 1 vacuum message with a rule code will visibly include that code:

```text
[<rule-code>] <original vacuum message>
```

Unknown rules will receive only this lossless prefix. Their original message
will otherwise remain unchanged.

If no rule code exists, the original message will be preserved byte-for-byte
apart from whitespace normalization required by the one-line contract.

### 2. Rule-aware enrichment registry

A small, deterministic registry will add concise explanation and repair hints
for known rules:

```js
const ENRICHERS = {
  'no-$ref-siblings': enrichNoRefSiblings,
};
```

The first supported rule will be `no-$ref-siblings` because it caused the
verified incident.

For an OpenAPI 3.0.x document, its model-visible message should be equivalent
to:

```text
[no-$ref-siblings] OpenAPI 3.0.x does not allow sibling properties next to `$ref` in the same schema object. Move adjacent fields into the referenced schema or wrap `$ref` in `allOf`.
```

If the exact version is reliably detected from the current in-memory document,
the message may use it:

```text
[no-$ref-siblings] OpenAPI 3.0.1 does not allow sibling properties next to `$ref` in the same schema object. Move adjacent fields into the referenced schema or wrap `$ref` in `allOf`.
```

If the dialect cannot be detected reliably, the hint must remain conservative:

```text
[no-$ref-siblings] OpenAPI 2.0/3.0.x does not allow sibling properties next to `$ref` in the same object. Move adjacent fields or use `allOf` for schema composition.
```

### 3. No speculative sibling names in the first implementation

The first implementation will not claim that a specific sibling such as
`description` or `type` caused the violation unless that sibling was located
deterministically in the correct source document.

Reasons:

- `js-yaml`, already used by the wrapper, does not preserve source ranges.
- Vacuum 0.29.9 `result.path` for `no-$ref-siblings` can describe the referenced
  target rather than the local object containing `$ref`.
- A guessed sibling name would recreate the same class of misleading agent
  output this ADR is intended to eliminate.

Exact sibling discovery may be added later only with a source-aware YAML AST or
a proven indentation/range algorithm covered by fixtures.

### 4. External-source compatibility fallback

When `result.source` is a trustworthy path that differs from the current
text-document path, the enriched visible message will append a workspace-
relative source hint:

```text
Actual source: openapi/path/to/ReferencedDto.yaml.
```

The hint will not include an absolute home-directory path when the file is
inside the workspace. Empty source values, `stdin`, and known synthetic or
tmp-style values will be omitted.

This visible fallback is required because OpenCode's `edit` tool only renders
diagnostics associated with the edited file, while its `write` tool can render
other-file diagnostics. Correct cross-file URI publication remains a separate
protocol concern and must not be treated as sufficient model-visible feedback
on its own.

### 5. Preserve machine-readable LSP fields

Enrichment will not replace structured data. The mapper will continue to set:

```js
{
  severity,
  range,
  code: result.code || 'vacuum',
  source: 'vacuum-lsp',
  message: enrichedMessage,
  data: {
    vacuum: {
      originalMessage: result.message,
      originalSource: result.source,
      path: result.path,
    },
  },
}
```

`Diagnostic.source` becomes the stable engine identifier `vacuum-lsp`.
Vacuum's original source and path are retained in `Diagnostic.data` for clients
and future tools that expose structured diagnostics.

The original vacuum message must always be recoverable from `data`, even when
the visible message is rewritten for clarity.

### 6. Deterministic and bounded behavior

The enricher must:

- make no LLM calls;
- make no network calls;
- introduce no consumer-install network hooks;
- contain no project-specific paths, terms, or Sber conventions;
- use English for package-level messages;
- return a single-line message;
- cap the visible message at 700 characters;
- fail open: if enrichment throws, publish the original vacuum message;
- never change severity, suppress a diagnostic, or invent a new violation.

### 7. Scope boundary

This ADR covers Stage 1 diagnostics produced by vacuum. Stage 2 Node.js plugin
scripts already own their diagnostic messages and are not rewritten.

The following are deliberately deferred:

- grouping and publishing diagnostics by the true external document URI;
- clearing stale diagnostics for previously referenced external documents;
- OpenCode formatter changes to render `code`, `source`, or `data`;
- warning/info visibility in OpenCode's automatic agent feedback;
- coordinate normalization and range correctness;
- exact YAML sibling-name extraction;
- adding rule-specific hints beyond incident-backed rules.

Those changes may receive separate ADRs or follow-up decisions. This ADR must
remain independently useful even if OpenCode's formatter never changes.

## Considered Alternatives

### 🅰️ Keep raw vacuum messages

- Pros: no wrapper code and no maintenance.
- Cons: the verified agent guessed the wrong OpenAPI dialect and proposed no
  valid repair because rule identity and remediation were hidden.
- Rejected: validation that an agent cannot correctly interpret does not close
  the feedback loop.

### 🅱️ Fork or patch OpenCode to render all LSP fields

- Pros: generic improvement for every LSP server.
- Pros: could expose `code`, `source`, `relatedInformation`, and `data`.
- Cons: requires maintaining an OpenCode fork or waiting for upstream.
- Cons: does not help VS Code, IntelliJ, or other clients with similarly terse
  presentations.
- Cons: OpenCode 1.18.8 also has different cross-file behavior between `edit`
  and `write` tools.
- Rejected as the primary solution. An upstream enhancement may still be filed.

### 🅲️ Prefix only the rule code

```text
[no-$ref-siblings] a `$ref` cannot be placed next to any other properties
```

- Pros: trivial, generic, and lossless.
- Pros: gives the agent a searchable rule ID.
- Cons: still does not explain OpenAPI 3.0.x semantics or the `allOf` repair.
- Partially accepted as the fallback for unknown rules, insufficient for known
  incident-backed rules.

### 🅳️ Deterministic rule-aware enrichment in the wrapper

- Pros: works with unmodified OpenCode and every other LSP client.
- Pros: zero runtime network and zero model cost.
- Pros: can provide exact, tested repair instructions per rule.
- Cons: hint registry must be maintained when vacuum behavior changes.
- Cons: longer messages consume more agent context.
- **Chosen.** The wrapper is the last layer that still has both vacuum-specific
  semantics and control of `Diagnostic.message`.

### 🅴️ Generate explanations through an LLM at runtime

- Pros: potentially richer and contextual advice.
- Cons: nondeterministic, slow, recursive, expensive, and incompatible with
  offline/air-gapped environments.
- Cons: can hallucinate exactly as the coding agent did in the incident.
- Rejected.

## Consequences

### Positive

- Coding agents receive the rule ID, applicable dialect semantics, and a repair
  pattern in the only field OpenCode reliably displays.
- Unknown vacuum rules become searchable through their visible code prefix.
- The original machine-readable diagnostic remains available in LSP fields and
  `data`.
- No OpenCode fork, network call, or consumer configuration change is required.
- The improvement benefits OpenCode, VS Code, IntelliJ, and other LSP clients.

### Negative / Risks

- Messages become longer; this adds bounded input-token cost for agents.
- Rule explanations can become stale after a future vacuum upgrade.
- A bad hint could be more damaging than a terse message.
- External source hints depend on vacuum returning a trustworthy source path.
- OpenCode still displays only severity-1 diagnostics in its automatic tool
  feedback; enrichment cannot change that client behavior.

### Mitigations

- Vacuum remains pinned to 0.29.9 until its behavior is reverified.
- Add hints only for rules with a reproduced incident and tests.
- Keep a lossless generic fallback.
- Preserve `originalMessage`, `originalSource`, and `path` in `data`.
- Cap each visible message and keep it one line.
- Test the exact text that an OpenCode-style formatter will show to the model.

## Implementation Plan

Implementation is intentionally separate from this ADR-only change.

1. `docs: ADR-0007 enrich vacuum diagnostics for coding agents`
2. `feat: add deterministic diagnostic enrichment registry`
3. `feat: integrate enrichment into vacuum diagnostic mapping`
4. `test: add agent-visible diagnostic enrichment contract`
5. `docs: document agent-friendly diagnostics`
6. Version bump and release placement decided separately from ADR-0006.

No code, version, package metadata, or publish configuration is changed by the
ADR commit itself.

## Verification

### Unit contract

Add `test/test-diagnostic-enrichment.js` with at least these cases:

1. Known `no-$ref-siblings` + `openapi: 3.0.1`:
   - visible message contains `[no-$ref-siblings]`;
   - visible message contains `OpenAPI 3.0.1`;
   - visible message contains `allOf`;
   - `data.vacuum.originalMessage` preserves the raw vacuum text.
2. Unknown rule code:
   - visible message is `[code] <original message>`;
   - no speculative explanation is added.
3. Missing code:
   - original message is preserved.
4. External source inside workspace:
   - visible message contains a workspace-relative source path;
   - no `/home/<user>` prefix leaks into the message.
5. `stdin`, empty, or tmp-style source:
   - no misleading source hint is added.
6. Enricher exception:
   - mapper publishes the original message instead of dropping the diagnostic.
7. All visible messages:
   - are one line;
   - are at most 700 characters;
   - preserve severity and range.
8. Stage 2 plugin diagnostic:
   - remains byte-for-byte unchanged.

### OpenCode-visible formatter simulation

The test must format the resulting LSP diagnostic with the measured OpenCode
1.18.8 contract:

```js
const pretty = d => {
  const severity = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'HINT' }[d.severity || 1];
  return `${severity} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
};
```

Expected output must contain enough information to choose the `allOf` repair
without inspecting `Diagnostic.code` or `Diagnostic.data`.

### End-to-end fixture

Use an OpenAPI 3.0.1 fixture containing:

```yaml
items:
  description: Item code
  $ref: ./Code.yaml#/components/schemas/Code
```

After `didOpen` or `didChange`, the published diagnostic must visibly include:

```text
[no-$ref-siblings]
OpenAPI 3.0.1
allOf
```

After changing the fixture to:

```yaml
items:
  description: Item code
  allOf:
    - $ref: ./Code.yaml#/components/schemas/Code
```

`no-$ref-siblings` must disappear.

### Regression suite

```bash
node test/test-diagnostic-enrichment.js
npm test
```

Existing `--ruleset` and `--rule-scripts` tests must remain green.

### Runtime verification in OpenCode

1. Install the implementation build in a test OpenCode project.
2. Cold-restart OpenCode so the LSP process loads the new wrapper.
3. Introduce the invalid `$ref + description` fixture.
4. Trigger an actual edit/save cycle.
5. Confirm the coding agent receives the enriched one-line message.
6. Ask the agent to explain and repair the issue without additional hints.
7. Confirm it chooses `allOf` or moves the sibling property, and does not infer
   Swagger/OpenAPI 2.0 validation.

## Open Questions

1. **Release placement:** ship independently as v0.6.0, or include after the
   ADR-0006 multi-platform work. Do not mix release scopes without Kolya's
   explicit decision.
2. **Exact sibling discovery:** add a source-aware YAML AST dependency later,
   or keep static remediation hints permanently?
3. **Cross-file publication:** should a future ADR publish an external
   diagnostic under its true URI and also retain a root-file summary for
   OpenCode `edit` compatibility?
4. **Additional rules:** enrich only rules that caused real agent confusion, or
   build an initial curated set? Default recommendation: incident-driven only.
5. **Upstream OpenCode:** file an enhancement asking `Diagnostic.pretty()` to
   render `code` and `source`, while keeping wrapper enrichment for portability?

## Decision Log

- 2026-08-07: Work-laptop screenshot showed the agent receiving only
  `ERROR [line:column] a '$ref' cannot be placed next to any other properties`.
- 2026-08-07: The actual violation was confirmed as `description + $ref` in the
  same OpenAPI 3.0.1 Schema Object; vacuum's validation was correct.
- 2026-08-07: The installed OpenCode 1.18.8 binary was inspected. Its formatter
  was confirmed to expose only severity, one-based start position, and message.
- 2026-08-07: Kolya explicitly approved creating an ADR for wrapper-side
  message enrichment.
- 2026-08-07: ADR number 0007 was selected because ADR-0006 is already reserved
  in the handoff for the deferred multi-platform bundle.
- 2026-08-07: Decision accepted; implementation has not started.
