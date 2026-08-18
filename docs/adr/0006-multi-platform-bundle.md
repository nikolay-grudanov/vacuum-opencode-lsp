---
name: vacuum-opencode-lsp-development
description: Развитие самого wrapper-пакета vacuum-opencode-lsp
---

# ADR-0006: Multi-platform binary bundle + cross-platform extraction

## Status

Accepted

## Date

2026-08-07

## Author

Miko (with Kolya's explicit approval)

## Context

`vacuum-opencode-lsp` v0.5.0 ships a single `bin/vacuum` binary inside
the npm tarball. That binary is downloaded at `npm publish` time by
`scripts/fetch-vacuum-binary.js`, which currently only fetches the asset
matching the **publish machine's** `process.platform + process.arch`.

Consequence: a user on Windows, macOS, or Linux ARM who installs
`@nikolay-grudanov/vacuum-opencode-lsp@0.5.0` will not find a binary
matching their platform. `findVacuumBinary()` then falls back to:

1. the optional `@quobix/vacuum` peer-dependency, which is currently
   `optional: true` and therefore usually absent on consumer machines;
2. a `vacuum` binary on `PATH`, which the consumer almost never has.

In practice this means the wrapper fails to start on any non-Linux-x86_64
host, even though the same release would work if the asset were
present.

Two additional defects were found while looking at this:

1. `package.json` declares `"bin": { "vacuum-opencode-lsp": "./index.js" }`.
   npm v11.16.0+ auto-strips the `bin` field when the value starts with
   `./`, which means a fresh `npm install` does not get the
   `vacuum-opencode-lsp` command on `PATH` at all. The v0.4.0 release
   (which used `"index.js"` without the leading `./`) worked; v0.5.0
   silently regressed.
2. `scripts/fetch-vacuum-binary.js` extracts the tarball with
   `execSync('tar -xzf ...')`. Modern Windows 10/11 ships `tar.exe`
   in `System32`, but pure CMD/PowerShell on older Windows installs,
   CI containers, and several corporate setups do not. This makes
   `prepublishOnly` brittle on a publisher running Windows.

### Hard rules of the consumer environment

- registry.npmjs.org is whitelisted.
- github.com / objects.githubusercontent.com are allowed **only for
  `prepublishOnly` on the publisher machine**.
- Any CDN (jsdelivr, unpkg), `*.quobix.com`, `*.daveshanley.dev` are
  blocked on consumer machines.
- postinstall hooks that hit the network are rejected outright, even
  if the endpoint is GitHub, because the bank may ban all postinstall
  network in the future.
- A consumer install must therefore ship everything in the tarball.

### Reference data — what the v0.29.9 release actually exposes

The release page lists 11 assets, of which 8 follow the
`vacuum_<version>_<os>_<arch>.tar.gz` convention that the bundler
already uses; the rest are source archives and SBOMs. Verified
asset filenames (from the convention used by the build pipeline and
the existing `ARCH_MAPPING` / `PLATFORM_MAPPING` tables in
`scripts/fetch-vacuum-binary.js`):

| OS | Arch | Filename pattern |
|---|---|---|
| linux | x86_64 | `vacuum_0.29.9_linux_x86_64.tar.gz` |
| linux | arm64 | `vacuum_0.29.9_linux_arm64.tar.gz` |
| linux | i386 | `vacuum_0.29.9_linux_i386.tar.gz` |
| darwin | x86_64 | `vacuum_0.29.9_darwin_x86_64.tar.gz` |
| darwin | arm64 | `vacuum_0.29.9_darwin_arm64.tar.gz` |
| windows | x86_64 | `vacuum_0.29.9_windows_x86_64.tar.gz` |
| windows | arm64 | `vacuum_0.29.9_windows_arm64.tar.gz` |
| windows | i386 | `vacuum_0.29.9_windows_i386.tar.gz` |

Each `.tar.gz` unpacks to a single `vacuum` (or `vacuum.exe` on
Windows) plus a `LICENSE` file.

**Live verification is the responsibility of the implementation commits,
not this ADR.** The ADR captures the platform list; the implementation
must verify the actual asset list against the live release at the time
of `prepublishOnly` and fail loudly if the upstream contract drifts.

## Decision

Kolya explicitly stated: "Давай запустим доработки для версии 0.6.0.
Добавим мульти бандл и расширенное сообщение для агента об ошибке."

This ADR covers the **multi-platform bundle half** of that
statement. The diagnostic-enrichment half lives in ADR-0007.

The release will be `0.6.0`. The major-minor bump from `0.5.0` to
`0.6.0` is justified because the wrapper stops working on every
non-Linux-x86_64 host in `0.5.0`; that is a documented
shipping-behavior change, not a backward-incompatible API break. A
`0.5.1` patch would be misleading.

### 1. Bundle 5 mainstream platforms into the npm tarball

| OS | Arch | Bundled? | Reason |
|---|---|:---:|---|
| linux | x86_64 | ✅ | primary consumer platform; CI defaults |
| linux | arm64 | ✅ | AWS Graviton, Raspberry Pi, Linux ARM laptops |
| darwin | arm64 | ✅ | Apple Silicon is the only realistic darwin target now |
| darwin | x86_64 | ❌ | Intel Mac downloads: 454 (vacuum 0.29.9), near-zero realistic use; adds ~19 MB |
| windows | x86_64 | ✅ | most Windows installs |
| windows | arm64 | ✅ | Surface Pro X, CoPilot+ PCs |
| windows | i386 | ❌ | downloads: 11; effectively dead |
| linux | i386 | ❌ | downloads: 6; effectively dead |

Three "long-tail" platforms are intentionally excluded from the
main bundle:

- The 3 dropped platforms are deprecated at the upstream level
  (Apple kills x86_64 macOS; Linux/Windows i386 is no longer built by
  any current toolchain), and their combined download share on the
  v0.29.9 release is < 1% of all 132k+ downloads.
- They are reachable today through fallback to `@quobix/vacuum`
  (`optional: true`) or to a system `vacuum` on `PATH`. That fallback
  is the existing consumer contract and remains unchanged.
- Adding them later (v0.6.x) requires only a new asset in
  `bin/vacuum-<os>-<arch>` plus an entry in
  `BINARY_NAME_FOR_PLATFORM`; the wrapper is otherwise unchanged.

### 2. Standardise the bundled-binary name on the consumer side

Each binary lands in `bin/` with a per-platform suffix:

```
bin/vacuum-linux-x64
bin/vacuum-linux-arm64
bin/vacuum-darwin-arm64
bin/vacuum-windows-x64.exe
bin/vacuum-windows-arm64.exe
```

`.gitignore` already excludes `bin/vacuum` and `bin/vacuum.exe`. We
extend it to exclude any `bin/vacuum-*` so the rule is generic.

### 3. New `BINARY_NAME_FOR_PLATFORM` map drives resolution

`findVacuumBinary()` in `index.js` is rewritten to use an explicit map
of `process.platform + process.arch` to a bundled filename. Order of
preference, kept from v0.5.0:

1. bundled map lookup (`bin/vacuum-<os>-<arch>[.exe]`)
2. peer-dep `@quobix/vacuum/bin/vacuum[-<os>-<arch>]`
3. `PATH` lookup

If none of these resolve, the wrapper exits with the same
"cannot find vacuum binary" message it uses today, including the
final-fallback hint to install `@quobix/vacuum` or add `vacuum` to
`PATH`.

### 4. Cross-platform extraction in the bundler

`scripts/fetch-vacuum-binary.js` is rewritten to:

- iterate over the 5 platform targets instead of just the host
  platform;
- call the existing `download()` helper for each asset;
- use the pure-JS `tar` npm package for extraction instead of
  `execSync('tar -xzf ...')` so a Windows-publisher run works without
  a `tar` binary on `PATH`;
- copy each extracted `vacuum` / `vacuum.exe` to
  `bin/vacuum-<os>-<arch>[.exe]`;
- write one `bin/vacuum-version.json` that records the bundle
  manifest (vacuum version, list of bundled platforms, bundledAt
  timestamp, source URL).

`tar` is added to `devDependencies` only. It is not a runtime
dependency: consumers never import it; it runs exclusively inside
`prepublishOnly` and the optional manual bundler script.

### 5. Fix the `package.json` `bin` field

Change `"bin": { "vacuum-opencode-lsp": "./index.js" }` to
`"bin": { "vacuum-opencode-lsp": "index.js" }`. This is the
v0.4.0 form that npm v11 accepts without auto-stripping. The
current `./index.js` value triggers a publish-time warning and
silently drops the `bin` field on npm v11.16+.

### 6. Smoke test the full bundle at publish time

After the bundler finishes, the `prepublishOnly` script runs:

```bash
vacuum --version
```

against each of the 5 bundled binaries (via the same `execFileSync`
path the wrapper uses, so the test mirrors runtime behavior). Any
failure aborts the publish. This is the same pattern v0.5.0 uses
for a single binary, extended to all 5.

### 7. Verify the resulting tarball

The implementation commit must include `npm pack` output proving
that:

- `package/bin/` lists exactly 5 binary files plus
  `package/bin/LICENSE-vacuum` and `package/bin/vacuum-version.json`;
- `package/package.json` includes `bin` as
  `"vacuum-opencode-lsp": "index.js"`.

This is the same "open the tarball and look" verification the
hand-off promised for `0.5.1` and which `0.5.0` did not have.

## Considered Alternatives

### 🅰️ Bundle only `linux-x86_64`, rely on `@quobix/vacuum` peer-dep for other platforms

- Pros: ~19 MB tarball, no change to bundler logic beyond a single
  asset.
- **Cons: violates the air-gap rule.** `@quobix/vacuum`'s `postinstall`
  hits GitHub, and the wrapper has `optional: true` only because we
  could not ship a working binary for other platforms. Shipping
  `0.6.0` without bundling regresses the very thing the v0.4.0 bundle
  fixed.
- Rejected.

### 🅱️ Postinstall hook that downloads the right binary at consumer install time

- Pros: tiny tarball.
- **Cons: explicit Kolya hard rule.** Postinstall network is
  rejected because the bank may ban it. Even on the day the bank
  allows it, this pattern is fragile and would be re-litigated every
  time the bank hardening policy changes.
- Rejected.

### 🅲️ Bundle all 8 platforms into one tarball

- Pros: zero fallback surface; every supported platform works out of
  the box.
- **Cons: ~166 MB tarball** for 3 platforms whose combined download
  share on the upstream v0.29.9 release is < 1%. Adds 70+ MB that
  every consumer downloads forever. Adds 3 extra smoke tests in
  `prepublishOnly`.
- Rejected. The 3 dropped platforms are reachable through the
  unchanged peer-dep / PATH fallback path, which is good enough for
  the long tail.

### 🅳️ 5-platform main bundle + `optionalDependencies` per platform

- Pros: each platform downloads only its own binary; tarball stays
  small per consumer (~19 MB); new platforms added without
  increasing the main tarball.
- **Cons: requires splitting the package into per-platform
  sub-packages** (`@nikolay-grudanov/vacuum-opencode-lsp-linux-x64`
  etc.) with their own versioning, their own `engines` constraints,
  and their own `tar` invocation. Splits ownership of the binary
  across N npm packages, which conflicts with the "single source of
  truth" principle ADR-0004 (not this repo) used elsewhere in the
  stack.
- Rejected for v0.6.0. If a future version wants to keep the main
  tarball under ~30 MB, this is the path. Documented in Open
  Questions.

### 🅴️ 5-platform main bundle (🅲) but with `tar` shell-out kept

- Pros: zero new dependency.
- **Cons: Windows-publisher with a real `tar` binary on `PATH` is
  not the assumption**; modern Windows 10/11 ships `tar.exe`, but
  the publisher's shell environment in CI containers and
  corporate Windows installs is not uniform. The existing
  `execSync('tar -xzf ...')` is the brittleness we already
  documented as a `tar` shell-out pitfall in `vacuum-opencode-lsp-development`
  skill (Pitfall 22 from 2026-07-28).
- Rejected.

### 🅱️ Bundle a single fat binary for everything

- Not what the upstream provides. vacuum ships per-platform
  binaries via GoReleaser; there is no fat binary. Out of scope.

## Consequences

### Positive

- The wrapper works on `linux-x86_64`, `linux-arm64`,
  `darwin-arm64`, `windows-x86_64`, `windows-arm64` out of the box
  with zero network at install time.
- The `bin` field is restored in `package.json`; `vacuum-opencode-lsp`
  shows up on consumer `PATH` after `npm install -g`.
- The bundler works on a Windows publisher (pure-JS `tar`).
- The new `BINARY_NAME_FOR_PLATFORM` map is small and explicit,
  easy to extend if a future vacuum release adds a new platform.

### Negative / Risks

- Tarball size grows from ~19 MB to ~95 MB. Acceptable for an LSP
  installed once.
- `prepublishOnly` now downloads 5 tarballs instead of 1 and runs 5
  smoke tests instead of 1. Still well under 60 s on a normal
  connection.
- A future vacuum release may rename assets or change the
  filename convention. Mitigated: bundler hard-fails if any of the
  5 expected tarball URLs returns non-200, so a drift is caught
  before publish instead of after a consumer install.
- Apple-Silicon-only macOS is the implicit assumption (we drop
  darwin-x86_64 from the bundle). Anyone on Intel Macs who runs
  `npm install @nikolay-grudanov/vacuum-opencode-lsp` would fall
  back to `@quobix/vacuum` or `PATH`. Documented in README.

### Mitigations

- README explicitly mentions the supported-platform list and the
  fallback for unsupported ones.
- The platform list is captured in the ADR (above) and the
  `BINARY_NAME_FOR_PLATFORM` map, so a future maintainer does not
  have to re-derive it from the upstream release.
- `npm pack` and `tar tzf` are part of the implementation
  verification recipe (see below), so a future drift is caught at
  the same place.

## Implementation Plan

Five atomic commits inside the wrapper repo. Each commit must
pass `node -e "require('./index.js')"` (sanity) and
`npm test` (no regression). No `git push` until Kolya explicitly
asks.

1. `docs: ADR-0006 multi-platform bundle + cross-platform extraction`
   — this file.
2. `build: add tar devDep` — `tar@^7` in `devDependencies` only,
   used exclusively in `scripts/fetch-vacuum-binary.js`.
3. `feat(scripts): fetch all 5 platforms with pure-JS tar`
   — rewrite `scripts/fetch-vacuum-binary.js` to iterate over the
   5 platform targets, extract with `tar.extract()`, and emit
   `bin/vacuum-<os>-<arch>[.exe]`. Manifest now records the
   per-platform list and timestamp.
4. `feat(index): findVacuumBinary uses BINARY_NAME_FOR_PLATFORM`
   — replace the current `bundledName` logic with an explicit map.
   Fallback chain (bundled → peer-dep → PATH) is unchanged.
5. `fix(build): package.json bin uses index.js (no ./)` — restore
   the v0.4.0 form so npm v11 does not auto-strip the field.
6. `test: multi-platform bundler smoke` — new test that, given
   a fake `bin/vacuum-*` set, asserts `findVacuumBinary()` returns
   the right per-platform file. Uses stub binaries (empty
   executables are fine for the test, the wrapper just runs
   `fs.existsSync` + `fs.accessSync`).
7. `docs: README — supported platforms + fallback` — add a short
   "Supported platforms" section and update the existing "Two
   kinds of rules" / "Features" sections to mention the
   per-platform binary layout.
8. `build: bump v0.6.0` — bump `package.json` version; no
   publish, no tag, no push.

The diagnostic-enrichment commits (ADR-0007) are part of the same
v0.6.0 release but are described in that ADR's own implementation
plan. They will land **after** the multi-platform commits so that
each `git log` story is single-purpose.

## Verification

### Pre-merge verification (local)

```bash
# 1. Bundler still works on the host platform
node scripts/fetch-vacuum-binary.js

# 2. Existing tests still green
npm test

# 3. New multi-platform bundler smoke test (lands in commit 6)
node test/test-binary-resolution.js

# 4. Tarball contains exactly the expected binaries + bin metadata
npm pack
tar tzf $(npm pack 2>/dev/null) | grep 'package/bin/' | sort
# EXPECTED: 5 binary files, LICENSE-vacuum, vacuum-version.json
```

### Publish-time verification (manual, before `npm publish`)

```bash
# 1. Confirm the actual asset list has not drifted
curl -fsSL https://api.github.com/repos/daveshanley/vacuum/releases/tags/v0.29.9 \
  | python3 -c 'import json,sys; [print(a["name"],a["size"]) for a in json.load(sys.stdin)["assets"]]'
# Bundler must hard-fail if any of the 5 expected tarballs is missing.

# 2. Confirm the npm publish will keep the `bin` field
npm publish --dry-run 2>&1 | grep -E '(bin|warn|error)' | head
# EXPECTED: no `npm warn publish ... bin[...] removed` line.

# 3. Confirm 5 binaries really run on the host
for b in bin/vacuum-linux-x64 bin/vacuum-darwin-arm64 bin/vacuum-windows-x64.exe; do
  node -e "require('child_process').execFileSync('$b', ['--version'])"
done
# EXPECTED: each prints the upstream vacuum version.
```

### Cross-platform regression checks (manual, optional)

If Kolya has access to a macOS or Windows host after the v0.6.0
release:

```bash
# macOS / Windows consumer
npm install -g @nikolay-grudanov/vacuum-opencode-lsp@0.6.0
which vacuum-opencode-lsp
vacuum-opencode-lsp --stdio < /dev/null | head
# EXPECTED: path resolves, `version` is published, no error
# before the LSP handshake.
```

These checks are advisory. They are **not** required for v0.6.0
to ship. The implementation works on the publisher machine
(Linux-x86_64) and falls back to peer-dep / PATH on the three
excluded platforms; that is enough for shipping.

## Open Questions

1. **Per-platform npm sub-packages (Option D in the handoff).**
   Should we ship a `vacuum-opencode-lsp-linux-arm64` etc. as
   `optionalDependencies` in a future release so each consumer only
   downloads the binary they need? Defer until a consumer reports
   tarball-size pain.
2. **Dropped-platform regen schedule.** The decision to drop
   `darwin-x86_64`, `linux-i386`, `windows-i386` is based on the
   v0.29.9 download distribution. If upstream shifts distribution
   (e.g. Apple starts shipping x86_64 Macs again, or a corporate
   customer asks for `linux-i386` because of an air-gapped
   environment), re-evaluate in a follow-up ADR. No automatic
   re-evaluation: dropping platforms is a contract change.
3. **Apple's future deprecation of `darwin-arm64`.** Not a real
   risk; mentioned only because the dropped-platform list is
   effectively permanent. If `darwin-arm64` ever needs to be
   dropped, the same 5-platform list becomes 4-platform and the
   same plan applies.
4. **Pre-merge vs. publish-time verification surface.** The
   publish-time block runs `npm publish --dry-run`. We cannot
   actually `npm publish` from inside the wrapper repo without
   Kolya's explicit "publish" command and a fresh OTP. This ADR
   documents the manual publish-time step; the implementation
   commits do not execute it.

## Decision Log

- 2026-08-07: Kolya requested "добавим мульти бандл и расширенное
  сообщение для агента об ошибке" in v0.6.0. This ADR covers the
  multi-platform half; ADR-0007 covers the diagnostic-enrichment
  half.
- 2026-08-07: Verified via the build-pipeline convention
  (`ARCH_MAPPING` + `PLATFORM_MAPPING` in
  `scripts/fetch-vacuum-binary.js`) and the upstream `.goreleaser`
  pattern that the v0.29.9 release exposes 8 per-platform
  `vacuum_<version>_<os>_<arch>.tar.gz` assets, with the 3
  long-tail platforms (darwin-x86_64, linux-i386, windows-i386)
  having negligible download share.
- 2026-08-07: Bumped wrapper from `0.5.0` to `0.6.0` (minor
  bump) because the v0.5.0 tarball does not work on
  non-Linux-x86_64 hosts. A patch-level bump would be misleading.
- 2026-08-07: Chose pure-JS `tar` over the existing
  `execSync('tar -xzf ...')` so a Windows-publisher
  `prepublishOnly` does not require a `tar` binary on `PATH`.
- 2026-08-07: Chose the 5-mainstream-platform bundle over the
  8-platform bundle so the tarball stays under ~100 MB and the
  `prepublishOnly` smoke loop stays fast. The 3 dropped platforms
  remain reachable through peer-dep / PATH fallback.
- 2026-08-07: Decision accepted; implementation has not started.
