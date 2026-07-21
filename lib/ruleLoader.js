'use strict';

/**
 * ruleLoader — loads and runs user-supplied Node.js plugin scripts for
 * vacuum-opencode-lsp. Each script is a single async function that receives
 * a parsed YAML/JSON document and returns LSP diagnostics.
 *
 * Contract: docs/adr/0001-wrapper-side-plugin-loader.md
 *
 * Key behaviors:
 *   - Walks a directory for *.js files (top-level only, no recursion)
 *   - require() with try/catch — broken scripts don't crash the loader
 *   - mtime-based cache invalidation — edit rule, no restart needed
 *   - invoke() wrapped in try/catch — runtime errors → error diagnostic
 *   - Returns merged Diagnostics[] from all scripts
 *
 * Stateless across LSP messages beyond `cache` object — each invocation
 * is independent unless the script opts into caching via context.cache.
 */

const fs = require('fs');
const path = require('path');

class RuleLoader {
  /**
   * @param {string} dir - absolute path to rule-scripts directory
   */
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.cache = new Map();  // absolutePath → { mtimeMs, fn }
    this.diagSource = 'vacuum-lsp:rule-scripts';
  }

  /**
   * Discover all .js files in the rule-scripts dir (top-level only).
   * Returns absolute paths, sorted for determinism.
   * @returns {string[]}
   */
  discoverScripts() {
    if (!fs.existsSync(this.dir)) return [];
    try {
      const entries = fs.readdirSync(this.dir, { withFileTypes: true });
      return entries
        .filter(e => e.isFile() && e.name.endsWith('.js'))
        .map(e => path.join(this.dir, e.name))
        .sort();
    } catch (err) {
      // EACCES, ENOTDIR, etc. — treat as empty
      return [];
    }
  }

  /**
   * Load (or reload from cache) a single script. Returns { fn, error }.
   * @param {string} absPath
   * @returns {{ fn?: Function, error?: string }}
   */
  loadScript(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      return { error: `Cannot stat ${absPath}: ${err.message}` };
    }
    const mtimeMs = stat.mtimeMs;

    const cached = this.cache.get(absPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.fn) {
      return { fn: cached.fn };
    }

    // mtime changed or never loaded → reload
    try {
      // Bust require cache for hot-reload
      delete require.cache[require.resolve(absPath)];
      const mod = require(absPath);
      const fn = typeof mod === 'function' ? mod : mod.default;
      if (typeof fn !== 'function') {
        return { error: `Module does not export a function (got ${typeof mod})` };
      }
      this.cache.set(absPath, { mtimeMs, fn });
      return { fn };
    } catch (err) {
      return { error: `require() failed: ${err.message}` };
    }
  }

  /**
   * Run all discovered scripts against the given document.
   * One bad script never breaks the others.
   *
   * @param {object} doc - parsed YAML/JSON
   * @param {object} context - { docPath, workspaceRoot, vacuumDiags, cache }
   * @returns {Promise<Array<object>>} - merged LSP Diagnostics
   */
  async runScripts(doc, context) {
    const scripts = this.discoverScripts();
    const out = [];

    // Shared cache object across scripts in the same session (per ADR §Open Questions)
    const sharedCache = context.cache || {};

    const perScriptContext = {
      docPath: context.docPath,
      workspaceRoot: context.workspaceRoot,
      vacuumDiags: context.vacuumDiags || [],
      cache: sharedCache,
    };

    for (const absPath of scripts) {
      const { fn, error } = this.loadScript(absPath);

      if (error) {
        // Load-time error → emit error diagnostic, continue
        out.push(this._errorDiagnostic(absPath, error));
        continue;
      }

      try {
        const result = await fn(doc, perScriptContext);
        const diagnostics = Array.isArray(result) ? result : [];
        for (const d of diagnostics) {
          out.push(this._normalizeDiagnostic(d, absPath));
        }
      } catch (err) {
        out.push(this._errorDiagnostic(absPath, `invoke() failed: ${err.message}`));
      }
    }

    return out;
  }

  /**
   * Wrap a load/invoke error into an LSP diagnostic so the user sees it.
   */
  _errorDiagnostic(scriptPath, message) {
    const name = path.basename(scriptPath);
    return {
      severity: 1,  // Warning — error in user code, not in their spec
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      code: `rule-script-error:${name}`,
      source: this.diagSource,
      message: `rule-script '${name}': ${message}`,
    };
  }

  /**
   * Normalize a user-returned diagnostic — ensure source prefix,
   * fill in defaults for missing fields.
   */
  _normalizeDiagnostic(d, scriptPath) {
    const name = path.basename(scriptPath);
    return {
      severity: typeof d.severity === 'number' ? d.severity : 1,
      range: d.range || {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      code: d.code || `rule-script:${name}`,
      source: d.source || this.diagSource,
      message: typeof d.message === 'string' ? d.message : 'Violation',
      ...(d.data ? { data: d.data } : {}),
    };
  }
}

module.exports = RuleLoader;