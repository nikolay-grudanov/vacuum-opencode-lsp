#!/usr/bin/env node
'use strict';

/**
 * vacuum-opencode-lsp — generic LSP wrapper over vacuum CLI for OpenCode
 * (and any LSP client).
 *
 * Configurable via CLI flags:
 *   --ruleset <path>     Path to vacuum ruleset file (.yaml). Optional.
 *   --debounce <ms>      Debounce window for didChange events. Default: 300.
 *   --timeout <ms>       Vacuum subprocess timeout. Default: 10000.
 *   --stdio               Use stdio for LSP transport (default, required by OpenCode).
 *
 * Ruleset resolution order:
 *   1. --ruleset CLI flag (absolute or relative path)
 *   2. .opencode/vacuum-ruleset.yaml in cwd
 *   3. vacuum-ruleset.yaml in cwd
 *
 * Usage in opencode.jsonc:
 *   "vacuum-opencode-lsp": {
 *     "command": ["node", "./node_modules/vacuum-opencode-lsp/index.js",
 *                 "--stdio", "--ruleset", "./.opencode/vacuum-ruleset.yaml"],
 *     "extensions": [".yaml", ".yml", ".json"]
 *   }
 */

const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  DiagnosticSeverity,
  TextDocumentSyncKind
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── CLI argument parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
let rulesetOverride = null;
let debounceMs = 300;
let timeoutMs = 10000;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--stdio') {
    // no-op; vscode-languageserver reads stdio by default
    continue;
  } else if (a === '--ruleset' || a === '-r') {
    rulesetOverride = args[++i];
  } else if (a === '--debounce') {
    debounceMs = parseInt(args[++i], 10);
  } else if (a === '--timeout') {
    timeoutMs = parseInt(args[++i], 10);
  } else if (a === '--help' || a === '-h') {
    process.stderr.write(
      'Usage: vacuum-opencode-lsp --stdio [--ruleset <path>] [--debounce <ms>] [--timeout <ms>]\n'
    );
    process.exit(0);
  } else {
    process.stderr.write(`Unknown argument: ${a}\n`);
    process.exit(1);
  }
}

// ─── Ruleset resolution ─────────────────────────────────────────────────────

function resolveRuleset(override) {
  const candidates = [];
  if (override) {
    // Resolve relative paths against cwd
    candidates.push(path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override));
  }
  // Generic fallbacks (relative to cwd, i.e. workspace root)
  candidates.push(path.join(process.cwd(), '.opencode', 'vacuum-ruleset.yaml'));
  candidates.push(path.join(process.cwd(), 'vacuum-ruleset.yaml'));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const rulesetPath = resolveRuleset(rulesetOverride);

// ─── Vacuum binary discovery ─────────────────────────────────────────────────
//
// Order:
//   1. ../node_modules/@quobix/vacuum/bin/vacuum (when this wrapper is also
//      installed as a node_module, peerDep resolution puts @quobix/vacuum
//      next to it)
//   2. <workspace>/node_modules/@quobix/vacuum/bin/vacuum
//   3. PATH lookup (vacuum binary)
//
function findVacuumBinary() {
  const local = path.join(__dirname, '..', 'node_modules', '@quobix', 'vacuum', 'bin', 'vacuum');
  if (fs.existsSync(local)) return local;
  const cwdLocal = path.join(process.cwd(), 'node_modules', '@quobix', 'vacuum', 'bin', 'vacuum');
  if (fs.existsSync(cwdLocal)) return cwdLocal;
  // PATH lookup
  const which = require('child_process').spawnSync('which', ['vacuum']);
  if (which.status === 0) return which.stdout.toString().trim();
  return null;
}

const VACUUM_BIN = findVacuumBinary();

if (!VACUUM_BIN) {
  process.stderr.write(
    'vacuum-opencode-lsp: cannot find vacuum binary.\n' +
    'Install @quobix/vacuum as a peer dep, or expose `vacuum` on PATH.\n'
  );
  process.exit(1);
}

// ─── LSP Setup ──────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let validationTimeout = null;

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental
  }
}));

connection.onInitialized(() => {
  connection.console.log(
    `vacuum-opencode-lsp initialized\n` +
    `  ruleset: ${rulesetPath || '(built-in recommended)'}\n` +
    `  vacuum:  ${VACUUM_BIN}\n` +
    `  debounce: ${debounceMs}ms, timeout: ${timeoutMs}ms`
  );
});

// ─── Validation ─────────────────────────────────────────────────────────────

documents.onDidChangeContent((change) => {
  if (validationTimeout) {
    clearTimeout(validationTimeout);
  }
  validationTimeout = setTimeout(() => {
    validateTextDocument(change.document);
  }, debounceMs);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: []
  });
});

/**
 * Validates a single text document.
 * Writes text to a temp file, calls vacuum, parses Spectral-format JSON,
 * maps to LSP diagnostics.
 */
async function validateTextDocument(textDocument) {
  const text = textDocument.getText();
  const uri = textDocument.uri;
  const filePath = uri.replace('file://', '');

  if (!isLikelySpec(text)) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  let diagnostics = [];

  try {
    const tmpFile = path.join(
      os.tmpdir(),
      `vacuum-lsp-${process.pid}-${Date.now()}.yaml`
    );
    fs.writeFileSync(tmpFile, text);

    const args = ['spectral-report', '-o', '--no-pretty'];
    if (rulesetPath) {
      args.push('-r', rulesetPath);
    }
    args.push(tmpFile);

    const stdout = execFileSync(VACUUM_BIN, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: path.dirname(filePath),
    });

    try { fs.unlinkSync(tmpFile); } catch {}

    if (stdout && stdout.trim()) {
      const results = JSON.parse(stdout);
      if (Array.isArray(results)) {
        diagnostics = results.map(vacuumResultToDiagnostic);
      }
    }
  } catch (error) {
    // vacuum exit code > 0 = has violations (this is NOT an error for us);
    // stdout still contains JSON
    if (error.stdout) {
      try {
        const results = JSON.parse(error.stdout);
        if (Array.isArray(results)) {
          diagnostics = results.map(vacuumResultToDiagnostic);
        }
      } catch (parseErr) {
        connection.console.error(`Failed to parse vacuum output: ${parseErr.message}`);
      }
    } else if (error.killed) {
      connection.console.error(`vacuum timed out (>${timeoutMs}ms)`);
    } else {
      connection.console.error(`vacuum error: ${error.message}`);
    }
  }

  connection.sendDiagnostics({ uri, diagnostics });
}

/**
 * Heuristic: does the document look like OpenAPI/AsyncAPI/JSON Schema?
 * Cheap substring check on the first 500 chars.
 */
function isLikelySpec(text) {
  const head = text.slice(0, 500).toLowerCase();
  return (
    head.includes('openapi:') ||
    head.includes('asyncapi:') ||
    head.includes('swagger:') ||
    head.includes('"openapi"') ||
    head.includes('"asyncapi"') ||
    head.includes('json schema')
  );
}

/**
 * Maps a single vacuum result (Spectral format) to an LSP Diagnostic.
 */
function vacuumResultToDiagnostic(result) {
  let severity;
  switch (result.severity) {
    case 0: severity = DiagnosticSeverity.Error; break;
    case 1: severity = DiagnosticSeverity.Warning; break;
    case 2: severity = DiagnosticSeverity.Information; break;
    default: severity = DiagnosticSeverity.Warning;
  }

  const range = result.range || {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
  };

  return {
    severity,
    range: {
      start: {
        line: Math.max(0, range.start.line || 0),
        character: Math.max(0, range.start.character || 0)
      },
      end: {
        line: Math.max(0, range.end.line || range.start.line || 0),
        character: Math.max(0, range.end.character || range.start.character + 1 || 1)
      }
    },
    message: result.message || result.code || 'Violation',
    code: result.code || 'vacuum',
    source: 'vacuum-lsp'
  };
}

// ─── Start ──────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();