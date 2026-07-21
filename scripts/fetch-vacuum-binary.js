#!/usr/bin/env node
'use strict';

/**
 * scripts/fetch-vacuum-binary.js
 *
 * Downloads the bundled vacuum Go binary from the official daveshanley/vacuum
 * GitHub release and copies it into ./bin/vacuum. This binary is what
 * @nikolay-grudanov/vacuum-opencode-lsp ships inside its npm tarball, so
 * users don't need to install @quobix/vacuum separately.
 *
 * Why bundle the binary instead of relying on @quobix/vacuum peer-dep:
 * - User controls version via @nikolay-grudanov/vacuum-opencode-lsp version
 *   (single source of truth — one version bump = one new binary)
 * - No postinstall network call needed at consumer install time
 * - Binary version is reproducible across lockfiles and CI
 * - No risk of consuming a fresh @quobix/vacuum release that breaks our CLI
 *
 * Why GitHub releases (not npm tarball):
 * - @quobix/vacuum@0.29.9 npm tarball only contains a Node wrapper +
 *   postinstall script. The actual Go binary lives in GitHub releases.
 * - Fetching from GitHub gives us the pre-built, signed, reproducible binary.
 *
 * Triggered by prepublishOnly hook in package.json.
 * Configurable via VACUUM_VERSION env var (defaults to '0.29.9').
 *
 * License: vacuum is MIT. Bundling the pre-built binary is permitted under
 * the MIT license; the LICENSE file is copied alongside the binary in
 * ./bin/LICENSE-vacuum for attribution.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const VACUUM_VERSION = process.env.VACUUM_VERSION || '0.29.9';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const TARGET_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'vacuum.exe' : 'vacuum');

const ARCH_MAPPING = {
  ia32: 'i386',
  x64: 'x86_64',
  arm64: 'arm64',
};
const PLATFORM_MAPPING = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

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

async function main() {
  if (process.env.SKIP_VACUUM_BUNDLE === '1') {
    log('SKIP_VACUUM_BUNDLE=1 set, skipping binary fetch');
    return;
  }

  const arch = ARCH_MAPPING[process.arch];
  const platform = PLATFORM_MAPPING[process.platform];
  if (!arch || !platform) {
    fail(`Unsupported platform: ${process.platform}/${process.arch}`);
  }

  log(`Target: vacuum ${VACUUM_VERSION} for ${platform}/${arch}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const tarballName = `vacuum_${VACUUM_VERSION}_${platform}_${arch}.tar.gz`;
  const url = `https://github.com/daveshanley/vacuum/releases/download/v${VACUUM_VERSION}/${tarballName}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-bin-'));
  const tarball = path.join(tmpDir, tarballName);

  try {
    log(`Downloading ${url}`);
    await download(url, tarball);
    log(`Downloaded ${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MB`);

    log(`Extracting to ${tmpDir}`);
    execSync(`tar -xzf "${tarball}" -C "${tmpDir}"`, { stdio: 'pipe' });

    const sourceBin = path.join(tmpDir, 'vacuum');
    if (!fs.existsSync(sourceBin)) {
      fail(`Expected binary at ${sourceBin} not found after extraction`);
    }

    log(`Copying binary → ${TARGET_BIN}`);
    fs.copyFileSync(sourceBin, TARGET_BIN);
    fs.chmodSync(TARGET_BIN, 0o755);

    const sourceLicense = path.join(tmpDir, 'LICENSE');
    if (fs.existsSync(sourceLicense)) {
      fs.copyFileSync(sourceLicense, path.join(BIN_DIR, 'LICENSE-vacuum'));
      log('Copied LICENSE-vacuum for MIT attribution');
    }

    const manifest = {
      vacuumVersion: VACUUM_VERSION,
      source: `https://github.com/daveshanley/vacuum/releases/tag/v${VACUUM_VERSION}`,
      bundledAt: new Date().toISOString(),
      platform,
      arch,
    };
    fs.writeFileSync(
      path.join(BIN_DIR, 'vacuum-version.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );

    // Quick smoke test: does the binary even start?
    try {
      execSync(`"${TARGET_BIN}" lint --help`, { stdio: 'pipe' });
      log('✓ Binary smoke test passed (vacuum lint --help responded)');
    } catch (e) {
      fail(`Bundled binary failed smoke test: ${e.message}`);
    }

    log(`✓ Bundled vacuum ${VACUUM_VERSION} for ${platform}/${arch}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => fail(e.message));
