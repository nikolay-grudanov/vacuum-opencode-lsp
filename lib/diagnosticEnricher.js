'use strict';

/**
 * lib/diagnosticEnricher.js
 *
 * Wrapper-side diagnostic enrichment for OpenCode-style LSP clients.
 *
 * OpenCode 1.18.8 (measured on 2026-08-07) renders each Diagnostic via:
 *
 *   const severity = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }[d.severity || 1];
 *   return `${severity} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
 *
 * Diagnostic.code, Diagnostic.source, Diagnostic.data, relatedInformation,
 * and codeDescription are NOT included in the agent-visible text. The
 * only field guaranteed to reach the coding agent is Diagnostic.message.
 *
 * ADR-0007 captures the full design and rationale; this module is
 * the executable core.
 *
 * Public API:
 *   enrich(result, dialect) -> { message: string, data?: object }
 *
 *   result:  one element of the JSON array vacuum spectral-report emits.
 *            Has at minimum { code?, severity, message, source?, range? }.
 *   dialect: optional OpenAPI family hint ('openapi-3.0.x',
 *            'openapi-3.1.x', 'swagger-2.0', 'unknown'). If absent, the
 *            enricher picks a conservative wording that does not lie
 *            about which OAS family applies.
 *
 * Returns the original `result.message` in `message` if:
 *   - `result.message` is empty or missing
 *   - the enricher for `result.code` throws (fail-open)
 *
 * The returned `data` object is opaque to the agent-visible formatter
 * but should always include `vacuum.originalMessage` so consumers with
 * structured-diagnostics tooling (or a future OpenCode improvement) can
 * recover the raw vacuum text.
 */

const MAX_VISIBLE_LENGTH = 700;
const UNKNOWN_RULE_PREFIX = (code) => `[${code}]`;

// ─── Rule-specific enrichers ──────────────────────────────────────────────

/**
 * OpenAPI 2.0 / 3.0.x do not allow sibling properties next to a `$ref`
 * inside the same Schema Object. OpenAPI 3.1 (JSON Schema 2020-12) does.
 *
 * The raw vacuum message is technically correct but tells the agent
 * nothing about the OAS family, the violated sibling, or the repair
 * pattern. We give the agent a one-line explanation with the dialect
 * hint, the standard repair (`allOf` composition), and the explicit
 * "OpenAPI 3.0.x" framing so the agent does not infer Swagger 2.0.
 */
function enrichNoRefSiblings(result, dialect) {
  // Conservative wording: never claim a specific sibling field (the YAML
  // AST pipeline does not currently give us that). The repair pattern
  // (`allOf` composition or moving the sibling into the referenced
  // schema) is the same regardless of which sibling is at fault.
  const familyWord =
    dialect === 'openapi-3.1.x'
      ? 'OpenAPI 3.1'
      : dialect === 'swagger-2.0'
      ? 'Swagger 2.0'
      : 'OpenAPI 3.0.x'; // default for the OAS3 family; 'unknown' falls through
  const hint =
    'Use `allOf` to compose the reference, or move sibling fields into the referenced schema.';
  const text = `${familyWord} does not allow sibling properties next to \`$ref\` in the same schema object. ${hint}`;
  // Keep the raw vacuum message as a fallback for structured clients.
  return {
    message: text,
    data: {
      vacuum: {
        originalMessage: result.message,
        originalSource: result.source || null,
        path: Array.isArray(result.path) ? result.path : [],
        rule: result.code || 'no-$ref-siblings',
      },
    },
  };
}

// Registry. Each entry is a (result, dialect) -> { message, data }.
// If a rule throws or returns invalid output, the fallback enricher
// emits the rule-code prefix plus the original vacuum message and
// captures the failure in `data.vacuum.enricherError` so a future
// structured-diagnostics tool can surface it.
const ENRICHERS = {
  'no-$ref-siblings': enrichNoRefSiblings,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Detect OAS family from the document text if the caller did not pass
 * a dialect hint. Cheap regex on the first 500 chars is enough for the
 * few rules we currently enrich. The result is best-effort: 'unknown'
 * is a valid input — it just means the enricher uses conservative wording.
 *
 * @param {string|undefined} docText — full document text (passed through
 *                                     the LSP didOpen/didChange cycle; the
 *                                     wrapper always has it on hand).
 */
function detectDialect(docText) {
  if (!docText || typeof docText !== 'string') return 'unknown';
  const head = docText.slice(0, 500).toLowerCase();
  if (head.includes('openapi: 3.1') || head.includes('"openapi": "3.1')) return 'openapi-3.1.x';
  if (head.includes('openapi: 3.0') || head.includes('"openapi": "3.0')) return 'openapi-3.0.x';
  if (head.includes('openapi: 2') || head.includes('"openapi": "2')) return 'openapi-3.0.x'; // mis-tagged but treat as 3.0 family
  if (head.includes('swagger: "2.0"') || head.includes('swagger: 2.0')) return 'swagger-2.0';
  if (head.includes('openapi:') || head.includes('"openapi"')) return 'openapi-3.0.x';
  if (head.includes('swagger:') || head.includes('"swagger"')) return 'swagger-2.0';
  return 'unknown';
}

/**
 * Strip newlines / control characters so the visible message stays on
 * one line. Defensive — vacuum messages are already single-line but
 * a third-party rule could emit a multi-line message; OpenCode's
 * formatter does not collapse them.
 */
function collapseToOneLine(s) {
  return String(s).replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * The fallback enricher — runs for unknown codes and as a safety net
 * if a registered enricher throws. Always emits at minimum the rule
 * code prefix + the original vacuum message, preserving lossless
 * information for the agent.
 */
function fallback(result) {
  const original = String(result.message || '').trim() || (result.code ? `vacuum rule ${result.code} fired` : 'vacuum diagnostic');
  const code = typeof result.code === 'string' && result.code.length > 0 ? result.code : null;
  const prefix = code ? `${UNKNOWN_RULE_PREFIX(code)} ` : '';
  const text = `${prefix}${original}`;
  return {
    message: text,
    data: {
      vacuum: {
        originalMessage: original,
        originalSource: result.source || null,
        path: Array.isArray(result.path) ? result.path : [],
        rule: code,
      },
    },
  };
}

/**
 * Cap the visible message at MAX_VISIBLE_LENGTH. Truncation is rare
 * (vacuum messages are short) but a future Stage 2 plugin could
 * emit arbitrarily long text.
 */
function clampLength(text) {
  if (text.length <= MAX_VISIBLE_LENGTH) return text;
  return text.slice(0, MAX_VISIBLE_LENGTH - 1).trimEnd() + '…';
}

/**
 * Public entry point.
 *
 * @param {object} result — one element of vacuum spectral-report's JSON output.
 * @param {object} [opts]
 * @param {string} [opts.dialect] — OAS family hint. If absent, `detectDialect`
 *                                  is called with `opts.docText` (or 'unknown').
 * @param {string} [opts.docText] — full document text for dialect detection.
 * @returns {{ message: string, data?: object }}
 */
function enrich(result, opts) {
  if (!result || typeof result !== 'object') {
    return { message: 'vacuum diagnostic' };
  }
  const dialect = (opts && opts.dialect) || detectDialect(opts && opts.docText);
  const code = typeof result.code === 'string' ? result.code : null;
  const enricher = code && ENRICHERS[code];
  let entry;
  try {
    entry = enricher ? enricher(result, dialect) : fallback(result);
  } catch (e) {
    // Fail-open: never let an enricher crash publishDiagnostics. Capture
    // the error in `data.vacuum.enricherError` for structured consumers.
    entry = fallback(result);
    if (!entry.data) entry.data = {};
    entry.data.vacuum = entry.data.vacuum || {};
    entry.data.vacuum.enricherError = String(e && e.message || e);
  }
  // Defensive: ensure data shape, collapse multi-line, clamp length.
  const message = clampLength(collapseToOneLine(entry.message || fallback(result).message));
  const data = (entry.data && typeof entry.data === 'object') ? entry.data : { vacuum: { rule: code } };
  return { message, data };
}

module.exports = {
  enrich,
  detectDialect,
  fallback,
  collapseToOneLine,
  clampLength,
  MAX_VISIBLE_LENGTH,
};
