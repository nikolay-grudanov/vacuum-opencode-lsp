---
name: vacuum-opencode-lsp-development
description: Развитие самого wrapper-пакета vacuum-opencode-lsp
---

# ADR-0008: Narrow supported platforms to linux-x86_64 and windows-x86_64

## Status

Accepted

## Date

2026-08-07

## Author

Miko (with Kolya's explicit approval)

## Context

ADR-0006 (multi-platform bundle) committed the wrapper to shipping
**5 mainstream platforms** inside the npm tarball:

| OS | Arch | Bundled binary |
|---|---|---|
| linux | x86_64 | `bin/vacuum-linux-x64` |
| linux | arm64 | `bin/vacuum-linux-arm64` |
| darwin | arm64 | `bin/vacuum-darwin-arm64` |
| windows | x86_64 | `bin/vacuum-windows-x64.exe` |
| windows | arm64 | `bin/vacuum-windows-arm64.exe` |

Total tarball cost: ~95 MB. Five downloads on the publisher machine,
five smoke tests in `prepublishOnly`.

Kolya explicitly observed: "кажется это много. давай оставим linux
x86_64, windows x86_64. так как пакет в первую очередь нацелен на
работу в моей команде то оставим только актуальные платформы для
моей команды. остальные позже добавим если попросит команда или
комьюнити."

The package's primary deployment is Kolya's team — analysts working
on OpenAPI / AsyncAPI specs in the `digital-architecture` repository.
The team's machines are uniformly Linux x86_64 (CI default) and
Windows x86_64 (the analysts' day-to-day machines). macOS and Linux
ARM are not in the team's standard environment; adding their bundles
is shipping weight nobody on the team consumes today.

This contradicts the position ADR-0006 took (bundle all "mainstream"
platforms up front, drop only the long-tail). ADR-0006 was right
about the engineering — those binaries exist and would work — and
wrong about the audience. The maintenance cost of five-platform
bundles (five smoke tests, five downloads per publish, larger
tarball) is real, and the only justification for paying it was a
demand we have not measured.

## Decision

Narrow the bundled set to **two platforms**:

| OS | Arch | Bundled binary |
|---|---|---|
| linux | x86_64 | `bin/vacuum-linux-x64` |
| windows | x86_64 | `bin/vacuum-windows-x64.exe` |

Everything else falls through to the unchanged fallback chain:

1. bundled map lookup (matches this ADR's two entries)
2. peer-dep `@quobix/vacuum/bin/vacuum[-.exe]` (rarely present)
3. `PATH` lookup for `vacuum`

This is a packaging decision, not a code-quality decision. The
wrapper's `findVacuumBinary()` logic stays exactly as it was after
ADR-0006 — only the `BINARY_NAME_FOR_PLATFORM` map shrinks from
five entries to two. Stage 2 plugin diagnostics, enricher
contract (ADR-0007), and all other wrapper behavior are unchanged.

### Adding platforms later

Future additions are a single-commit change in three places:

- `scripts/fetch-vacuum-binary.js` — extend `TARGETS` with the
  new `(nodePlatform, nodeArch, assetOs, assetArch, binaryExt)`
  row.
- `index.js` — extend `BINARY_NAME_FOR_PLATFORM` with the new map
  key.
- `test/test-binary-resolution.js` — extend the stub layout
  assertion so the new key gets coverage.

The ADR does not pre-commit to any list of "next time" platforms.
Linux-arm64 and darwin-arm64 are the obvious candidates when (and
only when) the team or the community asks for them.

## Considered Alternatives

### 🅰️ Keep the 5-platform bundle (status quo from ADR-0006)

- Pros: covers every realistic home machine without asking the user
  to fall back; tarball includes a binary for almost every laptop
  on the planet.
- **Cons: ships ~70 MB nobody on Kolya's team uses.** Each
  `npm publish` downloads 5 tarballs and runs 5 smoke tests. The
  set was chosen by Kolya's instinct for "mainstream," not by a
  measured demand. R&D-style builds are cheap; production tarball
  size is not.
- Rejected by Kolya's 2026-08-07 instruction.

### 🅱️ Bundle only linux-x86_64, drop windows

- Pros: smallest possible bundle (~19 MB), covers the CI default
  and every Linux workstation.
- **Cons: Kolya's team uses Windows as their day-to-day dev
  machine.** Dropping Windows would block the LSP on every
  analyst's laptop, which is the primary consumer.
- Rejected. Windows is non-negotiable for this team's workflow.

### 🅲️ Bundle linux-x86_64, windows-x86_64 only

- Pros: covers the actual team. Two smoke tests, two downloads,
  ~38 MB tarball. Maps precisely onto Kolya's instruction.
- Pros: every other downstream platform still works through the
  `@quobix/vacuum` peer-dep or `PATH` fallback, which is the same
  contract v0.5.0 had for every non-Linux-x86_64 host.
- **Chosen.** Smallest viable bundle that satisfies the team.

### 🅳️ Bundle no binaries, rely entirely on peer-dep / PATH

- Pros: tarball under 1 MB; no publisher-side network at all.
- **Cons: Kolya already rejected this path.** The original air-gap
  argument (ADR-0006 §"Hard rules of the consumer environment")
  rules out relying on `@quobix/vacuum`'s postinstall hook. PATH
  lookup is acceptable but not required.
- Rejected as the primary path.

### 🅴️ Per-platform npm `optionalDependencies` (Option D from handoff)

- Pros: each consumer downloads only the binary they need.
- **Cons: ADR-0006 already deferred this — it requires splitting
  ownership across per-platform sub-packages and that conflicts
  with the "single source of truth" pattern.** Not justified at
  this team size; revisit if a future consumer complains about
  tarball size.
- Rejected.

## Consequences

### Positive

- Tarball shrinks from ~95 MB to ~38 MB — every consumer who was
  not on linux-x86_64 or windows-x86_64 was already falling through
  to peer-dep / PATH on v0.5.0; now they explicitly fall through
  instead of silently crashing on a missing binary.
- `prepublishOnly` runs 2 downloads and 2 smoke tests, half the
  previous noise.
- README's "Supported platforms" section becomes a 2-row table
  instead of a 5-row table — easier to read for a consumer who
  only cares about their own machine.

### Negative / Risks

- Anyone on Linux-arm64, darwin-arm64, darwin-x86_64,
  windows-arm64, linux-i386, or windows-i386 who upgrades and
  expected the bundled binary will see the wrapper fall through
  to peer-dep / PATH. **README must make this clear.** Section
  "Supported platforms" already lists only the 2 bundled rows,
  but the fallback section also has to enumerate the explicit
  non-supported list so the contract is unambiguous.
- A user who finds the wrapper unusable on their platform might
  file an issue. The ADR is the answer: ADR-0008 records the
  team's actual platform list and the criteria for adding
  platforms later; the issue gets a "please open a PR extending
  TARGETS + BINARY_NAME_FOR_PLATFORM" response.

### Mitigations

- README explicitly says "we ship binaries for these platforms;
  everything else falls through." A second table lists the
  platforms that fall through.
- Tarball reduction makes the **publish-time verification**
  faster too: `npm pack && tar tzf | grep 'package/bin/'` is two
  rows now.
- The wrapper's runtime behavior on the supported platforms is
  byte-for-byte unchanged.

## Implementation Plan

Atomic commits inside this repo. Each commit passes `npm test`
(33 assertions across 4 test files, unchanged by this ADR). No
`git push` until Kolya asks.

1. `docs: ADR-0008 narrow supported platforms to linux-x86_64 and
   windows-x86_64` — this file.
2. `feat(scripts): bundle 2 platforms only (linux-x86_64 + windows-x86_64)`
   — reduce `TARGETS` in `scripts/fetch-vacuum-binary.js` from
   five rows to two.
3. `feat(index): BINARY_NAME_FOR_PLATFORM has 2 entries` — reduce
   the map in `index.js` from five keys to two.
4. `test: update multi-platform bundler smoke for 2 platforms` —
   regenerate the stubs in `test/test-binary-resolution.js` and
   adjust the long-tail assertions.
5. `docs: README — supported platforms narrowed to 2 rows` —
   update the existing "Supported platforms" subsection.

No version bump. The package version stays whatever Kolya last
set it to (currently `0.5.0` per his explicit 2026-08-07
instruction). The release-number decision is owned by Kolya and
is orthogonal to the supported-platforms decision.

## Verification

### Pre-merge (local)

```bash
npm test                 # 33/33 green
node scripts/fetch-vacuum-binary.js --skip   # smoke — SKIP_VACUUM_BUNDLE=1
node --check index.js
node --check scripts/fetch-vacuum-binary.js
```

### Publish-time (manual with Kolya's OTP)

```bash
npm whoami
npm run prepublishOnly            # 2 downloads + 2 smoke + npm test
npm pack
tar tzf $(npm pack 2>/dev/null) | grep 'package/bin/' | sort
# EXPECTED — exactly 3 files inside package/bin/:
#   bin/vacuum-linux-x64
#   bin/vacuum-windows-x64.exe
#   bin/vacuum-version.json
#   bin/LICENSE-vacuum
# (4 entries; the latter two are not platform binaries.)

npm publish --dry-run 2>&1 | grep -E '(bin|warn publish|error)'
# EXPECTED — no `npm warn publish ... bin[...] removed` line.
```

### Cross-platform manual smoke (optional, only if Kolya has access)

```bash
# On a Linux x86_64 box
npm install -g @nikolay-grudanov/vacuum-opencode-lsp
which vacuum-opencode-lsp
vacuum-opencode-lsp --stdio < /dev/null | head
# EXPECTED — path resolves, handshake starts.

# On a Windows x86_64 box
# Same three commands. Path resolves through npm's bin symlink.
```

A consumer on a non-supported platform (e.g. macOS arm64) will see
the wrapper fall back to `@quobix/vacuum` or `PATH`, exactly as
v0.5.0 did for every non-Linux-x86_64 host. README documents this.

## Open Questions

1. **darwin-arm64 in the consumer's scope** — currently nobody on
   the team uses Apple Silicon workstations. If that changes, the
   addition is a single PR per Implementation Plan step 2-4.
2. **linux-arm64** — same. AWS Graviton and Raspberry Pi are not
   in the team's immediate workflow; revisit when the team
   explicitly asks.
3. **Per-platform sub-packages** — already deferred by ADR-0006
   §"Open Questions". Still deferred. Worth revisiting only if the
   38 MB tarball is too heavy for a consumer and that consumer
   cannot use `@quobix/vacuum` for air-gap reasons.
4. **Platform-add policy** — this ADR does not enumerate the
   exact steps a third-party would need to follow to add a
   platform. README should mention this in the "Adding
   platforms" subsection once added.

## Decision Log

- 2026-08-07: ADR-0006 was pushed with 5 mainstream platforms.
  Tarball cost ~95 MB.
- 2026-08-07: Kolya observed: "кажется это много. давай оставим
  linux x86_64, windows x86_64." Rejected linux-only (🅱️) because
  Windows is the day-to-day machine for the analyst team.
- 2026-08-07: Kolya specified the audience rule: "так как пакет в
  первую очередь нацелен на работу в моей команде то оставим
  только актуальные платформы для моей команды."
- 2026-08-07: Kolya specified the add-later policy: "остальные
  позже добавим если попросит команда или комьюнити." Captured
  in Implementation Plan as the single-commit addition recipe.
- 2026-08-07: Decision accepted (🅲); implementation has not
  started.
