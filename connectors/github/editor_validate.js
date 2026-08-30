// ---------------------------------------------------------------------------
// connectors/github/editor_validate.js -- syntax validation for delegate_editor.
//
// Per plan.md: "delegate_designer's per-file-type syntax validator
// generalizes naturally to more file types (JSON, YAML, and existing JS
// lint tooling via eslint.config.js already in this repo) but not all of
// them -- define what 'validated' means per allowed file type explicitly
// rather than silently skipping validation for types outside the original
// set."
//
// Reuses connectors/frontend/validate.js's html/css/scss/jsx/tsx/vue
// validators VERBATIM for the extensions delegate_editor shares with
// delegate_designer -- not a fork/copy, so a future fix to one
// of those validators (e.g. the HTML tag-balance regex) benefits both
// tools automatically instead of drifting apart.
//
// NEW validators here, for extensions delegate_designer never needed:
//   .js / .ts   -- real parse via @babel/parser (already a dependency, see
//                  frontend/validate.js's own note on why JSX needed a real
//                  parser over regex; reused here rather than a second
//                  regex-based approach).
//   .json       -- JSON.parse, the only correct definition of "valid JSON".
//   .yml/.yaml  -- js-yaml's load(), same reasoning as JSON: a hand-rolled
//                  YAML check would be far less reliable than the real
//                  parser this repo already needs to add as a dependency
//                  for this.
//   .md / .txt  -- NOT validated (fail-open, same as validateByExtension's
//                  behavior for any extension with no registered validator
//                  below). Free-form prose has no syntax to check.
// ---------------------------------------------------------------------------

import {
  validateHtml,
  validateCss,
  validateJsx,
  validateVue,
} from "../frontend/validate.js";

// -- JSON ------------------------------------------------------------------

export function validateJson(content) {
  try {
    JSON.parse(content);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [err.message || String(err)] };
  }
}

// -- YAML --------------------------------------------------------------
// Lazily imported, same fail-open-if-missing posture as validateJsx's
// @babel/parser import in frontend/validate.js -- if js-yaml somehow isn't
// installed in a given environment, treat the file as "unvalidated" rather
// than crash the whole tool call.
export async function validateYaml(content) {
  let load;
  try {
    ({ load } = await import("js-yaml"));
  } catch {
    return { valid: true, errors: [], skipped: "'js-yaml' is not installed -- syntax check skipped." };
  }
  try {
    load(content);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [err.message || String(err)] };
  }
}

// -- JS/TS: real parse via @babel/parser (delegated to validateJsx).
export async function validateJs(content) {
  return validateJsx(content, { typescript: false });
}

export async function validateTs(content) {
  return validateJsx(content, { typescript: true });
}

const VALIDATORS = {
  ".html": async (c) => validateHtml(c),
  ".css":  async (c) => validateCss(c),
  ".scss": async (c) => validateCss(c),
  ".jsx":  (c) => validateJsx(c, { typescript: false }),
  ".tsx":  (c) => validateJsx(c, { typescript: true }),
  ".vue":  (c) => validateVue(c),
  ".js":   (c) => validateJs(c),
  ".ts":   (c) => validateTs(c),
  ".json": async (c) => validateJson(c),
  ".yml":  (c) => validateYaml(c),
  ".yaml": (c) => validateYaml(c),
  // .md / .txt: deliberately absent -- see file header.
};

// Same dispatch contract as frontend/validate.js's validateByExtension:
// fail-open (valid:true, empty errors) for any extension with no
// registered validator, async throughout for a uniform call site.
export async function validateByExtension(path, content) {
  const match = /\.[a-z0-9]+$/i.exec(path);
  const ext = match ? match[0].toLowerCase() : "";
  const validator = VALIDATORS[ext];
  if (!validator) return { valid: true, errors: [] };
  return validator(content);
}
