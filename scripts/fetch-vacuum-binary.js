#!/usr/bin/env node
'use strict';

/**
 * scripts/fetch-vacuum-binary.js
 *
 * Downloads the bundled vacuum Go binaries for the 2 platforms we
 * support from the official daveshanley/vacuum GitHub release and copies
 * them into ./bin/. The binaries are what
 * @nikolay-grudanov/vacuum-opencode-lsp ships inside its npm tarball,
 * so users don't need to install @quobix/vacuum separately.
 *
 * Bundled platforms (see ADR-0008):
 *   linux-x86_64, windows-x86_64
 *
 * ADR-0006 originally bundled 5 mainstream platforms. ADR-0008 narrowed
 * the bundle to 2 after Kolya's explicit 2026-08-07 instruction:
 * the package is built for the team first, broader platforms on
 * demand later.
 *
 * Why bundle the binaries instead of relying on @quobix/vacuum peer-dep:
 * - User controls version via @nikolay-grudanov/vacuum-opencode-lsp version
 *   (single source of truth — one version bump = one new binary set)
 * - No postinstall network call needed at consumer install time
 * - Binary version is reproducible across lockfiles and CI
 * - No risk of consuming a fresh @quobix/vacuum release that breaks our CLI
 *
 * Why GitHub releases (not npm tarball):
 * - @quobix/vacuum@0.29.9 npm tarball only contains a Node wrapper +
 *   postinstall script. The actual Go binaries live in GitHub releases.
 * - Fetching from GitHub gives us the pre-built, signed, reproducible binaries.
 *
 * Why pure-JS tar (not execSync('tar -xzf ...')):
 * - Shell `tar` is not on PATH on a pure Windows CMD/PowerShell publisher.
 * - The pure-JS `tar` npm package works on any platform without shell-out.
 *
 * Triggered by prepublishOnly hook in package.json.
 * Configurable via VACUUM_VERSION env var (defaults to '0.29.9').
 * SKIP_VACUUM_BUNDLE=1 short-circuits the script for manual runs.
 *
 * License: vacuum is MIT. Bundling the pre-built binary is permitted under
 * the MIT license; the LICENSE file is copied alongside the binary in
 * ./bin/LICENSE-vacuum for attribution.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');
const tar = require('tar');

const VACUUM_VERSION = process.env.VACUUM_VERSION || '0.29.9';
const BIN_DIR = path.join(__dirname, '..', 'bin');

// Per-platform: { nodePlatform, nodeArch, assetOs, assetArch, binaryExt }
// - assetOs/assetArch match the upstream tarball filename
//   (vacuum_<version>_<os>_<arch>.tar.gz)
// - binaryExt is "" on POSIX (file is named `vacuum`) and ".exe" on Windows
//
// ADR-0008: bundled set was narrowed from 5 mainstream platforms to 2.
// The team that consumes this package uses Linux x86_64 (CI) and
// Windows x86_64 (analyst day-to-day machines). Other platforms
// (linux-arm64, darwin-arm64, darwin-x86_64, windows-arm64, the two
// i386 variants) fall through to peer-dep / PATH fallback.
const TARGETS = [
  { nodePlatform: 'linux', nodeArch: 'x64',   assetOs: 'linux',  assetArch: 'x86_64', binaryExt: ''     },
  { nodePlatform: 'win32', nodeArch: 'x64',   assetOs: 'windows', assetArch: 'x86_64', binaryExt: '.exe' },
];

// Filename the wrapper's findVacuumBinary() looks up for a given (platform, arch).
// Mirrors the BINARY_NAME_FOR_PLATFORM map in index.js — keep them in sync.
function bundledBinaryName(t) {
  return `vacuum-${t.assetOs}-${t.assetArch}${t.binaryExt}`;
}

function log(msg) {
  console.log(`[fetch-vacuum-binary] ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-vacuum-binary] ERROR: ${msg}`);
  process.exit(1);
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'vacuum-opencode-lsp bundler' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        download(next, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function fetchOne(t) {
  const tarballName = `vacuum_${VACUUM_VERSION}_${t.assetOs}_${t.assetArch}.tar.gz`;
  const url = `https://github.com/daveshanley/vacuum/releases/download/v${VACUUM_VERSION}/${tarballName}`;
  const bundledName = bundledBinaryName(t);
  const bundledPath = path.join(BIN_DIR, bundledName);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-bin-'));
  const tarball = path.join(tmpDir, tarballName);

  try {
    log(`[${t.assetOs}/${t.assetArch}] Downloading ${url}`);
    await download(url, tarball);
    const dlBytes = fs.statSync(tarball).size;
    log(`[${t.assetOs}/${t.assetArch}] Downloaded ${(dlBytes / 1024 / 1024).toFixed(1)} MB`);

    // Extract via pure-JS tar. tar.extract handles .tar.gz natively and
    // works on Windows without a `tar` binary on PATH.
    await tar.extract({ file: tarball, cwd: tmpDir, gzip: true });

    // The upstream tarball expands directly into cwd (no wrapping
    // subdirectory): LICENSE, README.md, vacuum (or vacuum.exe on
    // Windows). Verified against the actual archive listing of
    // vacuum_0.29.9_linux_x86_64.tar.gz on 2026-08-07.
    const sourceBin = path.join(tmpDir, t.binaryExt ? 'vacuum.exe' : 'vacuum');
    if (!fs.existsSync(sourceBin)) {
      fail(`Expected binary at ${sourceBin} not found after extraction`);
    }

    fs.copyFileSync(sourceBin, bundledPath);
    fs.chmodSync(bundledPath, 0o755);

    // Quick smoke: does the binary actually run? `lint --help` is a
    // built-in subcommand that any correctly-built vacuum binary
    // answers. `--version` is NOT a top-level flag on vacuum 0.29.9
    // — version prints via `vacuum version`, which we use for the
    // manifest read step. Verified live on 2026-08-07 during the
    // bundler debug session: a wrongly-platformed binary refuses to
    // exec with a clear "exec format error", and a correctly-
    // platformed one prints lint --help and exits 0. We use lint
    // --help here because it catches every relevant failure mode
    // (not-executable, wrong-platform, broken ELF, missing
    // dynamic libs) without depending on a flag that does not
    // exist at the top level.
    try {
      execFileSync(bundledPath, ['lint', '--help'], { stdio: 'pipe', timeout: 5000 });
      log(`[${t.assetOs}/${t.assetArch}] ✓ smoke test passed (lint --help responded)`);
    } catch (e) {
      fail(`Bundled binary ${bundledName} failed smoke test: ${e.message}`);
    }

    return { bundledName, size: fs.statSync(bundledPath).size, status: 'ok' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.SKIP_VACUUM_BUNDLE === '1') {
    log('SKIP_VACUUM_BUNDLE=1 set, skipping binary fetch');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  log(`Target: vacuum ${VACUUM_VERSION} across ${TARGETS.length} platforms`);
  log(`Targets: ${TARGETS.map(t => `${t.nodePlatform}/${t.nodeArch}`).join(', ')}`);

  const results = [];
  for (const t of TARGETS) {
    try {
      results.push(await fetchOne(t));
    } catch (e) {
      // Surface a hard failure for any single target — partial bundles
      // are worse than no bundle because consumers see green npm install
      // followed by a confusing wrapper crash.
      fail(`[${t.assetOs}/${t.assetArch}] ${e.message}`);
    }
  }

  // LICENSE-vacuum is the same upstream LICENSE for every tarball.
  // The upstream archive extracts LICENSE directly into cwd (verified
  // 2026-08-07). We re-download the first tarball just to obtain the
  // license file, because keeping the extraction tmpDir alive for the
  // whole run would add ~20 MB per platform to peak memory.
  const licenseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-license-'));
  try {
    const first = TARGETS[0];
    const tarballName = `vacuum_${VACUUM_VERSION}_${first.assetOs}_${first.assetArch}.tar.gz`;
    const url = `https://github.com/daveshanley/vacuum/releases/download/v${VACUUM_VERSION}/${tarballName}`;
    const tarball = path.join(licenseTmp, tarballName);
    await download(url, tarball);
    await tar.extract({ file: tarball, cwd: licenseTmp, gzip: true });
    const upstreamLicense = path.join(licenseTmp, 'LICENSE');
    if (fs.existsSync(upstreamLicense)) {
      fs.copyFileSync(upstreamLicense, path.join(BIN_DIR, 'LICENSE-vacuum'));
      log('Copied LICENSE-vacuum for MIT attribution');
    } else {
      fail(`Upstream LICENSE missing in ${tarballName}`);
    }
  } finally {
    fs.rmSync(licenseTmp, { recursive: true, force: true });
  }

  // Manifest: version, source, list of bundled platforms, timestamp.
  const manifest = {
    vacuumVersion: VACUUM_VERSION,
    source: `https://github.com/daveshanley/vacuum/releases/tag/v${VACUUM_VERSION}`,
    bundledAt: new Date().toISOString(),
    platforms: results.map(r => ({ binary: r.bundledName, sizeBytes: r.size })),
  };
  fs.writeFileSync(
    path.join(BIN_DIR, 'vacuum-version.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  log(`✓ Bundled ${results.length} platforms; manifest written to bin/vacuum-version.json`);
}

main().catch(e => fail(e.message));
