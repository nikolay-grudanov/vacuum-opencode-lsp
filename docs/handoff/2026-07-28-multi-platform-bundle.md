# Handoff — Multi-platform bundle for v0.5.0/v0.5.1

**Date:** 2026-07-28
**Session:** (this conversation — Miko + Kolya)
**Status:** Open / Not started (deferred per Kolya's "не сегодня, потом")
**Pickup from:** Session ended after v0.5.0 published to npm, ADR-0005 (stdin+--base) shipped.
**Goal for next session:** ship **multi-platform bundle** so `npm install @nikolay-grudanov/vacuum-opencode-lsp` works on Windows / macOS / Linux ARM without any postinstall or runtime network call.

---

## TL;DR (where we left off)

- ✅ v0.5.0 published to npm (4 atomic commits pushed to origin/main: ADR-0005, feat(index), bump 0.5.0, README rewrite)
- ✅ Standalone `vacuum` binary downloaded at `npm publish` time (prepublishOnly), bundled in tarball — but **only for Kolya's machine** (linux x86_64)
- 🚨 **Critical bug surfaced by Kolya:** wrapper currently ships a single-platform binary. Other platforms get fallback (peer-dep or PATH) or fail
- ❌ Rejected: **postinstall hook that downloads platform-specific binary** (would break air-gap constraint — Kolya's bank policies forbid it, may even ban GitHub network from corporate laptops in the future)
- ✅ Rejected alternative already shipped by upstream: `@quobix/vacuum` does exactly that (postinstall → github.com fetch) — would violate Kolya's hard rule
- 🎯 **Approved path:** **bundle all 9 platform binaries** in wrapper tarball (~165 MB) + add platform+arch suffix to binary name (`bin/vacuum-linux-x64`, `bin/vacuum-darwin-arm64`, `bin/vacuum-windows-x64.exe`, etc.)
- 🐛 Secondary bug found while looking: `scripts/fetch-vacuum-binary.js` uses `execSync('tar -xzf ...')` — fails on Windows-only pure CMD/PowerShell (no `tar`). Defer tar→node-tar rewrite as part of the same release.

---

## Kontext: why this matters

`scripts/fetch-vacuum-binary.js` runs in **prepublishOnly** and currently does this:

```js
const arch = ARCH_MAPPING[process.arch];           // x64
const platform = PLATFORM_MAPPING[process.platform]; // linux
const tarballName = `vacuum_${VACUUM_VERSION}_${platform}_${arch}.tar.gz`;
// downloads only that ONE tarball — Kolya's platform
```

→ Result: tarball has `bin/vacuum` (= linux x64 Go binary, 65 MB), and **only** that. A Windows user's `npm install @nikolay-grudanov/vacuum-opencode-lsp@0.5.0` will:
1. Download tarball from `registry.npmjs.org` (fine)
2. Look for `bin/vacuum.exe` — NOT FOUND
3. Fallback to peer-dep `@quobix/vacuum` — optional, may not be installed
4. Fallback to PATH (`which vacuum`) — may not exist
5. Crash with "cannot find vacuum binary"

Confirmed bug — `KfulOpportunityAiAgentCommentDto.yaml` test would pass on Linux, fail on Windows.

Kolya explicitly stated (2026-07-28): **air-gap means zero network at consumer install**, including postinstall hooks to GitHub. May also be retroactively retro-banned for any package with such hooks if the bank hardening policy continues. **Multi-platform bundle** is the only path.

---

## Open questions for the next session

### Q1. Which platforms to bundle? (Kolya hint: "возможно можно будет часть отбросить")

Vacuum v0.29.9 release assets (verified):

| Platform | Arch | Size | Downloads | Worth bundling? |
|---|---|---:|---:|:---:|
| linux | x86_64 | 19.1 MB | 132 015 | ✅ mainstream |
| linux | arm64 | 17.7 MB | 1 025 | 🤔 depends on usage (Apple Silicon Macs, AWS Graviton, Raspberry Pi) |
| linux | i386 | 18.0 MB | 6 | ❌ almost nobody |
| darwin | x86_64 | 19.9 MB | 454 | 🤔 Intel Macs (legacy) |
| darwin | arm64 | 18.5 MB | 1 966 | ✅ Apple Silicon |
| windows | x86_64 | 19.4 MB | 1 413 | ✅ mainstream |
| windows | arm64 | 17.8 MB | 415 | 🤔 Surface Pro X, CoPilot+ PCs |
| windows | i386 | 18.6 MB | 11 | ❌ nobody |

**Total of all 8:** ~166 MB. **Total of "useful" 5 (linux x64/arm64, darwin arm64, windows x64/arm64):** ~93 MB. **Minimal 2 (linux x64 + darwin arm64 + windows x64):** ~57 MB.

Recommendation: start with the 5-mainstream subset (~93 MB tarball), add more on demand. Discuss with Kolya before release.

### Q2. Tarball size implications

- @quobix/vacuum@0.29.9 unpacked: 33 KB (only Node.js wrapper, no binaries)
- Our v0.5.0: 65 MB single binary
- With 5 platforms: ~93 MB
- With all 8 platforms: ~166 MB

Disk + bandwidth cost. Mitigation: gzip compression is good (~2x for binaries), so tarball may stay under 50-90 MB downloaded.

### Q3. Existing config-snippet in `examples/opencode.jsonc.snippet`

Will need regeneration to verify the new `bin/vacuum-<os>-<arch>` resolution pattern is tested.

### Q4. Backward compatibility for users upgrading from v0.5.0

If they did `findVacuumBinary()` fallback to `@quobix/vacuum` peer-dep before — that chain still works after our change, we just add one more priority level (bundled → peer-dep → PATH). Safe.

### Q5. `bin` field in `package.json`

Currently broken (npm auto-removed it in v0.5.0 because we wrote `./index.js` instead of `index.js`). Should be fixed in the SAME release as multi-platform — both are small bugfixes, defer them together into v0.5.1.

Recommended fix:
```json
"bin": { "vacuum-opencode-lsp": "index.js" }
```
(no leading `./` — what we had in v0.3.0/v0.4.0, what npm accepts)

### Q6. ADR-0006 vs inline commit?

This change is non-trivial (multi-platform, file renaming, manifest updates, smoke-test on multiple OS). Recommend **ADR-0006** in `docs/adr/` following the same Nygard format used in ADR-0001 (plugin loader) and ADR-0005 (stdin+--base). 3-pattern table, considered alternatives, verification section.

### Q7. Tar-on-windows fix while we're at it

Current `scripts/fetch-vacuum-binary.js` uses `execSync('tar -xzf ...')` which fails on Windows without git-bash. While modern Windows 10/11 ships `tar.exe` in System32 by default, npm install on macOS/Linux/Windows should all work with `tar` package (Node.js, cross-platform). Add `tar` to `devDependencies` (used only in prepublishOnly hook).

### Q8. Optional platforms: how to ship them?

Option (a): package ALL into one tarball (~166 MB), everyone downloads all
Option (b): npm `optionalDependencies` per platform (npm picks right one based on `process.platform`) — too complex, breaks our pattern
Option (c): separate optional npm packages (`@nikolay-grudanov/vacuum-opencode-lsp-linux-x64`) as `optionalDependencies` — modern binary pattern. Best long-term if Kolya cares about tarball size
Option (d): just bundle the 5 mainstream and ignore the rest

Recommend starting with (a) for simplicity, evaluate (c) if users complain about size.

---

## Plan when we resume

1. Re-read this handoff
2. Discuss Q1 + Q4-Q8 with Kolya before code — ADR-0006 first
3. Create ADR-0006-multi-platform-bundle.md in `docs/adr/`
4. Atomic commits per ADR plan:
   - `docs: ADR-0006 multi-platform bundle`
   - `feat(scripts): fetch all 9 platforms, add tar-on-windows fix`
   - `feat(index): findVacuumBinary selects by process.platform+arch`
   - `fix(build): bin field uses index.js (not ./index.js)`
   - `build: bump v0.5.1 (multi-platform + bin fix)`
5. Run smoke test locally (Linux x86_64), confirm nothing regressed
6. Push, publish, cascade digital-architecture to v0.5.1
7. Bonus: smoke-test on macOS and Windows if Kolya has access to either

---

## Related context (read these first)

- ADR-0001 (`docs/adr/0001-wrapper-side-plugin-loader.md`) — pattern for ADR writing
- ADR-0005 (`docs/adr/0005-replace-tmp-with-stdin.md`) — current release, same Nygard format
- README "Bundled vacuum binary" section — needs update to mention multi-platform after this
- `index.js:findVacuumBinary()` (lines 124-136) — current priority chain
- `scripts/fetch-vacuum-binary.js:108-112` — current single-platform fetch + shell tar
- AGENTS.md "Bundled vacuum binary (v0.4.0+)" section in digital-architecture — same topic, cross-project context

---

## Air-gap mechanics (Kolya confirmed + fact-checked 2026-07-28)

**Question raised by Kolya:** does postinstall go through npm proxy or direct from user machine?

**Answer (with source-code evidence):** postinstall runs **directly from the user machine**, not through npm proxy.

Source code proof (`@npm/run-script/lib/make-spawn-args.js:32`):
```js
const spawnOpts = {
  env: spawnEnv,          // = { ...process.env, ...env } = full user environment
  stdio,
  stdioString,
  cwd: path,              // cwd = node_modules/@scope/pkg/
  shell: scriptShell,     // default true → spawn through user shell
};
```

npm calls `child_process.spawn` with `shell: true`. Inside the postinstall, code like `https.get('https://github.com/foo.tar.gz')` makes a **direct TCP connection from the user process to github.com**.

**Important detail:** `proxy` config in `.npmrc` only affects npm's own tarball-fetching. Inside postinstall, the script must explicitly read `process.env.HTTPS_PROXY` (which `@quobix/vacuum` does via `https-proxy-agent`). If a package's postinstall doesn't respect it, **traffic bypasses any proxy that npm was configured with**.

**Kolya's bank reality:**
- registry.npmjs.org → ✅ whitelisted (only way to ship JS packages)
- github.com / objects.githubusercontent.com → ⚠️ currently works for prepublishOnly on Kolya's dev machine, but **may be banned anytime** on corporate laptops (Kolya explicitly stated: "я даже git clone не могу сделать")
- Any CDN (jsdelivr, unpkg) → ❌ blocked
- Custom hosts (*.quobix.com, *.daveshanley.dev) → ❌ blocked

**Consequence for our distribution strategy:**
Bundle is the only safe path. Not "safer than alternative" — **the only option** that survives future tightening of bank policy. Even postinstall-on-github is fragile.

## Frozen facts about Kolya's air-gap rule (DO NOT re-litigate)

- ✅ Allowed endpoints at consumer install: `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`
- ❌ Blocked: `cdn.jsdelivr.net`, `unpkg.com`, `static.cloudflareinsights.com`, any `*.daveshanley.dev`
- ❌ Postinstall hooks that hit network — rejected even if endpoint is GitHub (entire pattern is rejected for forward-compatibility — bank may ban ALL postinstall traffic soon)
- ✅ prepublishOnly that hits GitHub — allowed (we control this machine, peer-dep compliance is one-time audit-trail)
- ❌ `peer-dep` required on `@quobix/vacuum` — rejected because their postinstall does network
- ✅ Current peer-dep setting `optional: true` on `@quobix/vacuum` — correct
