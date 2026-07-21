'use strict';

/**
 * example-operationid-permission.js
 *
 * Reference rule-script for vacuum-opencode-lsp.
 *
 * What it does:
 *   For every operation under $.paths[*], checks that its operationId
 *   is present in the set of permission codes defined in some other
 *   file in the workspace (in real projects, this would be
 *   role_models/<domain>/<service>.yaml — here we use a small
 *   permissions.json fixture for the example).
 *
 * If the operationId is missing → warning diagnostic asking the agent
 * to either add the permission or update the contract.
 *
 * How to run:
 *   1. Place this file (and any others) in .opencode/rule-scripts/
 *   2. Add --rule-scripts to your opencode.jsonc command array
 *   3. Open an OpenAPI file in OpenCode → diagnostics appear as squiggles
 *
 * See ADR-0001 for the full contract: docs/adr/0001-wrapper-side-plugin-loader.md
 *
 * NOTE: This example reads from a sibling fixture file (../examples/fixtures/permissions.json)
 * so you can run it standalone via:
 *   node examples/rule-scripts/example-operationid-permission.js
 *
 * (The wrapper injects the doc + context; standalone runs use mock context.)
 */

const fs = require('fs');
const path = require('path');

// ─── Debug logging helper ──────────────────────────────────────────────
// OpenCode 1.x strips env vars from child-process; stderr-based debug
// logging doesn't work. Write to a file instead. Plugin authors can use
// this helper to add their own debugLog('label', data) calls.
//
// Set VACUUM_LSP_DEBUG_FILE=/path/to/log in OpenCode env to redirect.
// Set VACUUM_LSP_DEBUG=off to disable entirely.
const DEBUG_FILE = process.env.VACUUM_LSP_DEBUG === 'off' ? null
  : (process.env.VACUUM_LSP_DEBUG_FILE || '/tmp/vacuum-lsp-debug.log');
function debugLog(label, data) {
  if (!DEBUG_FILE) return;
  try {
    const ts = new Date().toISOString();
    const payload = data ? ' ' + JSON.stringify(data) : '';
    fs.appendFileSync(DEBUG_FILE, `[plugin ${ts}] ${label}${payload}\n`);
  } catch {}
}

module.exports = async function operationidPermission(doc, context) {
  const diagnostics = [];
  debugLog('plugin-invoked', {
    docPath: context && context.docPath,
    operationsCount: doc && doc.paths ? Object.keys(doc.paths).length : 0,
  });

  // 1. Skip if this doesn't look like an OpenAPI/AsyncAPI spec with paths
  if (!doc || typeof doc !== 'object') return diagnostics;
  if (!doc.paths || typeof doc.paths !== 'object') return diagnostics;

  // 2. Load the permission set. In real projects, walk role_models/**.
  //    For this example, use a fixture file next to the rule-script.
  const permissions = loadPermissions(context);

  // 3. Iterate over every path × method and check operationId presence
  for (const [urlPath, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const opId = op.operationId;

      // Skip endpoints that intentionally have no operationId (rare)
      if (!opId) {
        diagnostics.push({
          severity: 1,
          range: rangeForOperation(doc, urlPath, method, context),
          code: 'operationid-missing',
          source: 'vacuum-lsp:rule-scripts',
          message: `Operation ${method.toUpperCase()} ${urlPath} has no operationId. ` +
                   `Agent must add operationId to the contract.`,
        });
        continue;
      }

      // Convention: mock endpoints are scaffold, ignore them
      if (opId === 'mock') continue;

      // The actual cross-artifact check
      if (!permissions.has(opId)) {
        diagnostics.push({
          severity: 1,
          range: rangeForOperation(doc, urlPath, method, context),
          code: 'operationid-permission-not-found',
          source: 'vacuum-lsp:rule-scripts',
          message: `operationId "${opId}" not found in permissions catalog. ` +
                   `Agent must create the permission or update the contract.`,
          data: { operationId: opId, path: urlPath, method: method.toUpperCase() },
        });
      }
    }
  }

  return diagnostics;
};

/**
 * Load the set of permission codes. In production this walks
 * role_models/<domain>/<service>.yaml files. For the example we
 * read a sibling JSON fixture.
 *
 * Uses context.cache to memoize across LSP messages in the same session.
 */
function loadPermissions(context) {
  const cacheKey = '__example_permissions__';
  if (context && context.cache && context.cache[cacheKey]) {
    return context.cache[cacheKey];
  }

  // Resolve fixture relative to this script (one level up from rule-scripts/)
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'permissions.json');

  const set = new Set();
  try {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.permissions)) {
      for (const p of data.permissions) {
        if (p && typeof p.code === 'string') set.add(p.code);
      }
    }
  } catch (err) {
    // Fixture missing — return empty set, every operationId will fail
    // (this is intentional for the example: makes the rule demonstrable)
  }

  if (context && context.cache) {
    context.cache[cacheKey] = set;
  }
  return set;
}

/**
 * Compute a best-effort range for an operation. Without raw text + line
 * offsets we can only point at line 0; in real scripts you should
 * re-parse the source text with line tracking (js-yaml's failure-tolerant
 * loader or yaml package's CST) and locate the exact line.
 *
 * For now: line 0, char 0 — visible in editor as top-of-file marker.
 */
function rangeForOperation(doc, urlPath, method, context) {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
}

// ─── Standalone test (run via `node examples/rule-scripts/example-operationid-permission.js`) ───

if (require.main === module) {
  const fixtureSpec = path.join(__dirname, '..', 'fixtures', 'sample-spec.yaml');
  const fsSync = require('fs');
  if (!fsSync.existsSync(fixtureSpec)) {
    console.error('Fixture missing:', fixtureSpec);
    process.exit(1);
  }
  const yaml = require('js-yaml');
  const text = fsSync.readFileSync(fixtureSpec, 'utf8');
  const doc = yaml.load(text);
  const context = {
    docPath: fixtureSpec,
    workspaceRoot: path.join(__dirname, '..', '..'),
    vacuumDiags: [],
    cache: {},
  };
  module.exports(doc, context).then(diags => {
    console.log(`Standalone run: ${diags.length} diagnostic(s)`);
    for (const d of diags) {
      console.log(`  [${d.severity === 0 ? 'ERR' : 'WARN'}] ${d.code}: ${d.message}`);
    }
    process.exit(diags.length > 0 ? 0 : 1);
  });
}