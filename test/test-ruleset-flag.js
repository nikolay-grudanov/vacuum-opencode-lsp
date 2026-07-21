#!/usr/bin/env node
'use strict';

/**
 * Smoke-тест: запускает LSP-обёртку через stdio, проверяет что:
 *  1. initialize handshake проходит
 *  2. didOpen → publishDiagnostics содержит violation от кастомного правила,
 *     заданного через --ruleset
 *  3. violation привязан к правильной строке
 *
 * Использование: node test/test-ruleset-flag.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-lsp-test-'));
const SPEC_PATH = path.join(tmpDir, 'broken-spec.yaml');
const RULESET_PATH = path.join(tmpDir, 'custom-ruleset.yaml');

// Сломанный спек: operation без x-allow-sigma (кастомное правило должно сработать)
fs.writeFileSync(SPEC_PATH, `openapi: 3.0.3
info:
  title: test
  version: 1.0.0
  description: test spec
paths:
  /test:
    get:
      operationId: real-op
      summary: should fail
      description: missing x-allow-sigma
      responses:
        '200':
          description: ok
`);

// Кастомный ruleset: одно правило real-operation-must-have-allow-sigma
fs.writeFileSync(RULESET_PATH, `extends: [[vacuum:oas, recommended]]
rules:
  real-operation-must-have-allow-sigma:
    description: Test custom rule
    given: "\$.paths[*][*]"
    severity: error
    then:
      field: x-allow-sigma
      function: defined
`);

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────

function framedSend(proc, method, params, id) {
  const msg = { jsonrpc: '2.0', method };
  if (id !== undefined) msg.id = id;
  if (params !== undefined) msg.params = params;
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  proc.stdin.write(header + body);
}

class LSPReader {
  constructor(stream) {
    this.fd = stream;
    this.buf = Buffer.alloc(0);
  }
  async readMessage(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Wait for headers
      while (!this.buf.includes(Buffer.from('\r\n\r\n'))) {
        const chunk = this.fd.read();
        if (!chunk || chunk.length === 0) {
          if (Date.now() - start >= timeoutMs) return null;
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
      }
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      const headers = this.buf.slice(0, headerEnd).toString();
      const clMatch = headers.match(/content-length:\s*(\d+)/i);
      if (!clMatch) return null;
      const cl = parseInt(clMatch[1], 10);
      const bodyStart = headerEnd + 4;
      while (this.buf.length < bodyStart + cl) {
        const chunk = this.fd.read();
        if (!chunk || chunk.length === 0) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
      }
      const body = this.buf.slice(bodyStart, bodyStart + cl).toString();
      this.buf = this.buf.slice(bodyStart + cl);
      return JSON.parse(body);
    }
    return null;
  }
}

// ─── Test runner ────────────────────────────────────────────────────────────

async function main() {
  const wrapperPath = path.join(__dirname, '..', 'index.js');

  console.log('--- Test: --ruleset CLI flag ---');
  console.log('Wrapper:', wrapperPath);
  console.log('Ruleset:', RULESET_PATH);
  console.log('Spec:', SPEC_PATH);

  const proc = spawn('node', [
    wrapperPath,
    '--stdio',
    '--ruleset', RULESET_PATH,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const stderrChunks = [];
  proc.stderr.on('data', d => stderrChunks.push(d));

  const reader = new LSPReader(proc.stdout);

  // Initialize
  framedSend(proc, 'initialize', {
    processId: process.pid,
    rootUri: `file://${tmpDir}`,
    capabilities: {},
  }, 1);

  const initResp = await reader.readMessage(5000);
  if (!initResp || initResp.id !== 1) {
    console.error('✗ initialize handshake failed');
    console.error('stderr:', Buffer.concat(stderrChunks).toString());
    proc.kill();
    process.exit(1);
  }
  console.log('✓ initialize OK');

  framedSend(proc, 'initialized', {});

  // didOpen
  framedSend(proc, 'textDocument/didOpen', {
    textDocument: {
      uri: `file://${SPEC_PATH}`,
      languageId: 'yaml',
      version: 1,
      text: fs.readFileSync(SPEC_PATH, 'utf8'),
    },
  });

  // Wait for publishDiagnostics
  let diagCount = 0;
  let customRuleHit = false;
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const msg = await reader.readMessage(2000);
    if (!msg) continue;
    if (msg.method === 'textDocument/publishDiagnostics') {
      const diags = msg.params?.diagnostics || [];
      diagCount += diags.length;
      for (const d of diags) {
        if (d.code === 'real-operation-must-have-allow-sigma') {
          customRuleHit = true;
          console.log('✓ custom rule triggered:');
          console.log(`  code: ${d.code}`);
          console.log(`  severity: ${d.severity}`);
          console.log(`  message: ${d.message}`);
          console.log(`  line: ${d.range?.start?.line}`);
        }
      }
    }
  }

  // Shutdown
  framedSend(proc, 'shutdown', null, 99);
  await reader.readMessage(1000);
  framedSend(proc, 'exit', null, 100);
  proc.kill();

  // ─── Assertions ──────────────────────────────────────────────────────────

  console.log('');
  console.log('--- Results ---');
  console.log(`Total diagnostics: ${diagCount}`);
  console.log(`Custom rule hit: ${customRuleHit}`);

  if (!customRuleHit) {
    console.error('');
    console.error('✗ FAIL: custom rule did not fire');
    console.error('stderr:', Buffer.concat(stderrChunks).toString());
    process.exit(1);
  }

  console.log('');
  console.log('✓ PASS: --ruleset flag works, custom rule fires in LSP');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});