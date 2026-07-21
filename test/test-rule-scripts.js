'use strict';

/**
 * test/test-rule-scripts.js
 *
 * Smoke test for lib/ruleLoader.js (ADR-0001). Tests the loader in
 * isolation — does NOT spin up the LSP server.
 *
 * Run: node test/test-rule-scripts.js
 * Exit code 0 on success, 1 on failure.
 *
 * Cases:
 *   1. Missing directory → 0 diagnostics, no crash
 *   2. Empty directory → 0 diagnostics, no crash
 *   3. One valid script that emits 1 diagnostic → 1 diagnostic
 *   4. One valid script that emits 0 diagnostics → 0 diagnostics
 *   5. One BROKEN script (syntax error) → 1 error diagnostic, no crash
 *   6. Mix: 1 valid + 1 broken → 2 diagnostics (valid + error), no crash
 *   7. mtime invalidation: change script content → new behavior picked up
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const RuleLoader = require('../lib/ruleLoader.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rule-scripts-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  console.log('--- RuleLoader smoke tests (ADR-0001) ---');

  // Case 1: Missing directory
  await test('missing directory returns 0 diagnostics, no crash', async () => {
    const loader = new RuleLoader('/nonexistent/path/that/does/not/exist');
    const diags = await loader.runScripts({}, { docPath: '/x', workspaceRoot: '/y', vacuumDiags: [], cache: {} });
    assert.strictEqual(diags.length, 0, `expected 0, got ${diags.length}`);
  });

  // Case 2: Empty directory
  await test('empty directory returns 0 diagnostics, no crash', async () => {
    const dir = tmpDir();
    try {
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 0);
    } finally { cleanup(dir); }
  });

  // Case 3: One valid script emitting 1 diagnostic
  await test('valid script emitting 1 diagnostic → 1 diagnostic', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'good.js'), `
        module.exports = async function(doc, ctx) {
          return [{
            severity: 1,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            code: 'rule-a',
            source: 'vacuum-lsp:rule-scripts',
            message: 'rule-a fired'
          }];
        };
      `);
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 1, `expected 1, got ${diags.length}`);
      assert.strictEqual(diags[0].code, 'rule-a');
    } finally { cleanup(dir); }
  });

  // Case 4: Valid script emitting 0 diagnostics
  await test('valid script emitting 0 diagnostics → 0 diagnostics', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'silent.js'), `
        module.exports = async function(doc, ctx) { return []; };
      `);
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 0);
    } finally { cleanup(dir); }
  });

  // Case 5: BROKEN script — syntax error
  await test('broken script (syntax error) → error diagnostic, no crash', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'broken.js'), 'this is not valid {');
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 1, `expected 1 error diag, got ${diags.length}`);
      assert.match(diags[0].code, /^rule-script-error:/);
      assert.match(diags[0].message, /require\(\) failed/);
    } finally { cleanup(dir); }
  });

  // Case 6: Mix — 1 valid + 1 broken, no crash
  await test('mix of 1 valid + 1 broken → 2 diagnostics (no crash)', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'a-valid.js'), `
        module.exports = async function(doc, ctx) {
          return [{ severity: 1, range: { start: {line:0,character:0}, end:{line:0,character:1} }, code: 'a', source: 'vacuum-lsp:rule-scripts', message: 'a' }];
        };
      `);
      fs.writeFileSync(path.join(dir, 'b-broken.js'), 'syntax error here {{{');
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 2, `expected 2, got ${diags.length}`);
      // Valid one first (sorted alphabetically), then error
      assert.strictEqual(diags[0].code, 'a');
      assert.match(diags[1].code, /^rule-script-error:/);
    } finally { cleanup(dir); }
  });

  // Case 7: Runtime throw inside valid script → error diagnostic
  await test('runtime throw in script → error diagnostic, no crash', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'throws.js'), `
        module.exports = async function(doc, ctx) {
          throw new Error('boom');
        };
      `);
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 1);
      assert.match(diags[0].code, /^rule-script-error:throws\.js$/);
      assert.match(diags[0].message, /invoke\(\) failed: boom/);
    } finally { cleanup(dir); }
  });

  // Case 8: mtime invalidation — edit script, behavior changes
  await test('mtime change → next run picks up new script version', async () => {
    const dir = tmpDir();
    try {
      const p = path.join(dir, 'evolving.js');
      fs.writeFileSync(p, `
        module.exports = async function(doc, ctx) {
          return [{ severity: 1, range: { start: {line:0,character:0}, end:{line:0,character:1} }, code: 'v1', source: 'vacuum-lsp:rule-scripts', message: 'v1' }];
        };
      `);
      const loader = new RuleLoader(dir);
      let diags = await loader.runScripts({}, {});
      assert.strictEqual(diags[0].code, 'v1');

      // Wait a bit so mtime changes (some FS have 1s resolution)
      await new Promise(r => setTimeout(r, 1100));
      fs.writeFileSync(p, `
        module.exports = async function(doc, ctx) {
          return [{ severity: 1, range: { start: {line:0,character:0}, end:{line:0,character:1} }, code: 'v2', source: 'vacuum-lsp:rule-scripts', message: 'v2' }];
        };
      `);

      diags = await loader.runScripts({}, {});
      assert.strictEqual(diags[0].code, 'v2', `mtime invalidation failed: got ${diags[0].code}`);
    } finally { cleanup(dir); }
  });

  // Case 9: context.cache memoization works
  await test('context.cache is shared across runScripts calls', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'cached.js'), `
        module.exports = async function(doc, ctx) {
          ctx.cache.counter = (ctx.cache.counter || 0) + 1;
          return [];
        };
      `);
      const loader = new RuleLoader(dir);
      const ctx = { docPath: '/x', workspaceRoot: '/y', vacuumDiags: [], cache: {} };

      await loader.runScripts({}, ctx);
      await loader.runScripts({}, ctx);
      await loader.runScripts({}, ctx);

      assert.strictEqual(ctx.cache.counter, 3);
    } finally { cleanup(dir); }
  });

  // Case 11: wrapperRoot is forwarded to plugin context (ADR-0002)
  await test('wrapperRoot is passed through to plugin context', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'check-wrapper.js'), `
        module.exports = async function(doc, ctx) {
          return [{
            severity: 1,
            range: { start: {line:0,character:0}, end:{line:0,character:1} },
            code: 'wrapper-root-' + (ctx.wrapperRoot ? 'present' : 'missing'),
            source: 'vacuum-lsp:rule-scripts',
            message: 'wrapperRoot=' + (ctx.wrapperRoot || 'undefined')
          }];
        };
      `);
      const loader = new RuleLoader(dir);
      const ctx = {
        docPath: '/x',
        workspaceRoot: '/y',
        wrapperRoot: '/opt/vacuum-opencode-lsp',
        vacuumDiags: [],
        cache: {},
      };
      const diags = await loader.runScripts({}, ctx);
      assert.strictEqual(diags.length, 1);
      assert.strictEqual(diags[0].code, 'wrapper-root-present');
      assert.match(diags[0].message, /wrapperRoot=\/opt\/vacuum-opencode-lsp/);
    } finally { cleanup(dir); }
  });

  // Case 10: non-.js files are ignored
  await test('non-.js files in dir are ignored', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# this is not a script');
      fs.writeFileSync(path.join(dir, 'rule.js'), `
        module.exports = async function(doc, ctx) { return []; };
      `);
      const loader = new RuleLoader(dir);
      const diags = await loader.runScripts({}, {});
      assert.strictEqual(diags.length, 0, `expected 0, got ${diags.length}`);
    } finally { cleanup(dir); }
  });

  // ─── Summary ───
  console.log('');
  console.log(`--- Results ---`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('');
    console.log('✗ FAIL');
    process.exit(1);
  } else {
    console.log('');
    console.log('✓ PASS: RuleLoader contract verified');
    process.exit(0);
  }
})().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});