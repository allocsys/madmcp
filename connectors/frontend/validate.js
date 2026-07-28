// ---------------------------------------------------------------------------
// connectors/frontend/validate.js — lightweight, per-extension syntax
// validation for delegate_designer's generate -> validate -> fix loop.
//
// SCOPE: syntax only, not visual/rendering correctness (see the Notion plan
// page "madmcp-delegate-designer-frontend-tool-2026-07-28" for why: real
// visual checking needs a headless browser or a rendering API, which is a
// genuine infra addition, not something this stateless serverless tool
// takes on in v1).
//
// Each validator returns { valid: boolean, errors: string[] } -- errors are
// short, human-readable strings meant to be fed straight back into a
// follow-up LLM prompt asking it to fix them, not a structured AST diff.
// ---------------------------------------------------------------------------

// -- HTML: tag-balance check --------------------------------------------
// Deliberately NOT a full HTML parser (no new dependency needed for this --
// mismatched/unclosed tags are the dominant real-world failure mode from
// LLM-generated markup, and a regex-based stack check catches those without
// the weight of a real parser). Void elements never need a closing tag.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function validateHtml(content) {
  const errors = [];
  const stack = [];
  // Strip comments and content inside <script>/<style> first -- tag-like
  // text inside those (e.g. a JS string containing "<div>") would otherwise
  // produce false positives; scripts/styles get their own validators when
  // relevant (e.g. a Vue SFC's <script> block).
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "<style></style>");

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let match;
  while ((match = tagRe.exec(stripped))) {
    const [full, tagName, selfClose] = match;
    const lower = tagName.toLowerCase();
    const isClosing = full.startsWith("</");
    if (VOID_ELEMENTS.has(lower) || selfClose === "/") continue;
    if (isClosing) {
      if (stack.length === 0) {
        errors.push(`Unexpected closing tag </${tagName}> with no matching open tag.`);
      } else if (stack[stack.length - 1] !== lower) {
        errors.push(`Mismatched tag: expected </${stack[stack.length - 1]}> but found </${tagName}>.`);
        // Best-effort recovery: pop anyway so one mismatch doesn't cascade
        // into dozens of downstream false positives.
        stack.pop();
      } else {
        stack.pop();
      }
    } else {
      stack.push(lower);
    }
  }
  if (stack.length) {
    errors.push(`Unclosed tag(s): <${stack.join(">, <")}> never closed.`);
  }
  return { valid: errors.length === 0, errors };
}

// -- CSS/SCSS: brace-balance + basic structure check ---------------------
// Also not a full CSS parser -- unbalanced braces are the dominant failure
// mode for LLM-generated CSS/SCSS (SCSS nesting is fine under a pure
// brace-count check, it doesn't need to understand selectors).
export function validateCss(content) {
  const errors = [];
  // Strip comments and string literals first, so a brace/quote inside a
  // comment or a content: "..." value can't desync the counts below.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) {
        errors.push("Unexpected closing brace '}' with no matching '{'.");
        depth = 0; // recover, same reasoning as the HTML validator above
      }
    }
  }
  if (depth > 0) errors.push(`${depth} unclosed brace(s) '{' -- missing matching '}'.`);
  return { valid: errors.length === 0, errors };
}

// -- JSX/TSX: real parse via @babel/parser --------------------------------
// Unlike HTML/CSS, JSX genuinely isn't valid plain JS syntax -- a regex
// approach can't reliably validate it, so this is the one case that
// warrants an actual parser dependency.
export async function validateJsx(content, { typescript = false } = {}) {
  let parse;
  try {
    ({ parse } = await import("@babel/parser"));
  } catch {
    // Dependency missing for some reason (shouldn't happen once package.json
    // is updated, but fail open rather than crash the whole tool call --
    // treat as "unvalidated" rather than "invalid").
    return { valid: true, errors: [], skipped: "‘@babel/parser’ is not installed -- syntax check skipped." };
  }
  try {
    // errorRecovery: true means @babel/parser does NOT throw for most
    // syntax errors -- it instead returns an AST with an `errors` array
    // attached, so it can keep parsing past the first mistake. That's
    // useful for tools that want a best-effort AST despite bad input, but
    // it means a bare try/catch here would silently treat recoverable
    // syntax errors as valid. Check ast.errors explicitly rather than
    // relying on parse() to throw.
    const ast = parse(content, {
      sourceType: "module",
      plugins: typescript ? ["jsx", "typescript"] : ["jsx"],
      errorRecovery: true,
    });
    if (ast.errors && ast.errors.length) {
      return { valid: false, errors: ast.errors.map((e) => e.message || String(e)) };
    }
    return { valid: true, errors: [] };
  } catch (err) {
    // Non-recoverable errors (parser gives up entirely) still throw.
    return { valid: false, errors: [err.message || String(err)] };
  }
}

// -- Vue SFC: block-balance + parse the <script> block if present --------
export async function validateVue(content) {
  const errors = [];
  for (const tag of ["template", "script", "style"]) {
    const openCount  = (content.match(new RegExp(`<${tag}\\b`, "gi")) || []).length;
    const closeCount = (content.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (openCount !== closeCount) {
      errors.push(`Mismatched <${tag}> blocks: ${openCount} opening vs ${closeCount} closing.`);
    }
  }
  const scriptMatch = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(content);
  if (scriptMatch) {
    const isTs = /lang=["']ts["']/i.test(scriptMatch[0]);
    const scriptResult = await validateJsx(scriptMatch[1], { typescript: isTs });
    if (!scriptResult.valid) errors.push(...scriptResult.errors.map((e) => `<script> block: ${e}`));
  }
  const templateMatch = /<template[^>]*>([\s\S]*?)<\/template>/i.exec(content);
  if (templateMatch) {
    const templateResult = validateHtml(templateMatch[1]);
    if (!templateResult.valid) errors.push(...templateResult.errors.map((e) => `<template> block: ${e}`));
  }
  return { valid: errors.length === 0, errors };
}

const VALIDATORS = {
  ".html": async (c) => validateHtml(c),
  ".css":  async (c) => validateCss(c),
  ".scss": async (c) => validateCss(c),
  ".jsx":  (c) => validateJsx(c, { typescript: false }),
  ".tsx":  (c) => validateJsx(c, { typescript: true }),
  ".vue":  (c) => validateVue(c),
};

// Dispatches to the right validator based on file extension. Returns
// { valid: true, errors: [] } for an extension with no validator registered
// (fail-open -- an unrecognized-but-allowlisted extension shouldn't block a
// write, it just doesn't get a syntax check). Async throughout (even the
// HTML/CSS branches, which don't need to be) so callers have one uniform
// `await validateByExtension(...)` regardless of which file type they hit.
export async function validateByExtension(path, content) {
  const match = /\.[a-z0-9]+$/i.exec(path);
  const ext = match ? match[0].toLowerCase() : "";
  const validator = VALIDATORS[ext];
  if (!validator) return { valid: true, errors: [] };
  return validator(content);
}
