// ---------------------------------------------------------------------------
// connectors/github/editor_policy.js -- guardrails #3 and #4 from plan.md
// ("Limited GitHub write access for delegate_agent (non-default-branch
// only)"), as plain, dependency-free functions. Deliberately built and
// tested in isolation before any tool-layer or agent-loop code exists (plan
// step 2), mirroring how designer_tool_functions.js's extension check was
// built/tested independently of connectors/frontend/designer_delegate.js's
// loop.
//
// NOT YET WIRED UP anywhere -- no tool, no agent loop, no MCP registration.
// This file only decides "is this path/content allowed", it does not read
// or write any file itself.
//
// Two independent layers, per guardrail #4 ("independent of and layered on
// top of any allowlist"):
//   1. isPathAllowed()   -- the allowlist (extension AND/OR path prefix).
//   2. isPathDenied()    -- the deny list. Checked SEPARATELY, and wins
//      even if isPathAllowed() would have said yes. A caller should always
//      check both, in either order, and refuse the write if either check
//      fails -- see isWriteAllowed() below, which does exactly that and is
//      the one function real tool-layer code should actually call.
// ---------------------------------------------------------------------------

function extensionOf(path) {
  const match = /\.[a-z0-9]+$/i.exec(path);
  return match ? match[0].toLowerCase() : "";
}

// Normalizes a path for comparison: strips a leading "./" or "/", since
// GitHub Contents API paths are always repo-root-relative without a leading
// slash, but callers/config might include one out of habit.
function normalize(path) {
  return path.replace(/^\.?\/+/, "");
}

// Path-prefix/glob-lite matcher, deliberately NOT a full glob engine (see
// config.js's comment on EDITOR_DENY_PATH_PATTERNS): supports exactly two
// shapes --
//   "foo/bar/**"  -> matches "foo/bar" itself and anything under it.
//   "foo/bar.js"  -> exact path match only.
// Nothing else (no `*` mid-segment, no `?`, no character classes). Keeping
// the matcher this narrow is intentional: a deny-list matcher is itself
// part of the trust boundary, and a hand-rolled full glob engine is exactly
// the kind of thing that grows subtle bypass bugs. If a future pattern
// genuinely needs more than these two shapes, that's a reason to add a
// well-tested glob dependency deliberately, not to extend this ad hoc.
function matchesPattern(path, pattern) {
  const p = normalize(path);
  const pat = normalize(pattern);
  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3);
    return p === base || p.startsWith(base + "/");
  }
  return p === pat;
}

// Guardrail #3, allowlist side. `allowedExtensions` and `allowedPathPrefixes`
// are arrays (already parsed/split by the caller, e.g. from config.js).
//
// Semantics: extension check is ALWAYS enforced if allowedExtensions is
// non-empty. Path-prefix check is enforced only if allowedPathPrefixes is
// non-empty (an empty prefix list means "no additional path restriction
// beyond extension + the deny list", matching config.js's documented
// default). Both conditions must pass when both lists are non-empty --
// this is a narrowing AND, not an OR, so a caller can't widen access by
// satisfying only one of the two lists.
export function isPathAllowed(path, { allowedExtensions = [], allowedPathPrefixes = [] } = {}) {
  if (allowedExtensions.length > 0) {
    const ext = extensionOf(path);
    if (!allowedExtensions.includes(ext)) {
      return { allowed: false, reason: `extension "${ext || "(none)"}" is not in the allowed list (${allowedExtensions.join(", ")})` };
    }
  }
  if (allowedPathPrefixes.length > 0) {
    const p = normalize(path);
    const matches = allowedPathPrefixes.some((prefix) => p === normalize(prefix) || p.startsWith(normalize(prefix) + "/"));
    if (!matches) {
      return { allowed: false, reason: `path is not under any allowed prefix (${allowedPathPrefixes.join(", ")})` };
    }
  }
  return { allowed: true };
}

// Guardrail #4, deny-list side. Independent of isPathAllowed() -- callers
// must check both (see isWriteAllowed()). `denyPatterns` is an array of
// patterns in the two shapes matchesPattern() understands.
export function isPathDenied(path, { denyPatterns = [] } = {}) {
  const hit = denyPatterns.find((pattern) => matchesPattern(path, pattern));
  if (hit) {
    return { denied: true, reason: `path matches deny pattern "${hit}" (see config.js EDITOR_DENY_PATH_PATTERNS)` };
  }
  return { denied: false };
}

// Guardrail #4's content-level case: package.json's scripts/dependencies/
// devDependencies fields specifically, called out in plan.md as a
// supply-chain risk that can't be expressed as a path pattern (the whole
// file isn't denied, just those fields). `beforeContent`/`afterContent` are
// raw file text; if either fails to parse as JSON this returns denied=true
// rather than silently skipping the check -- an unparseable "package.json"
// write is itself suspicious enough to refuse by default.
export function touchesPackageJsonRiskyFields(path, beforeContent, afterContent) {
  if (normalize(path) !== "package.json") return { denied: false };

  const RISKY_FIELDS = ["scripts", "dependencies", "devDependencies"];
  let before, after;
  try {
    before = beforeContent === undefined ? {} : JSON.parse(beforeContent);
    after = JSON.parse(afterContent);
  } catch {
    return { denied: true, reason: "package.json content does not parse as JSON -- refusing rather than guessing whether risky fields changed" };
  }

  for (const field of RISKY_FIELDS) {
    if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
      return { denied: true, reason: `package.json "${field}" field would change -- requires an explicit override flag (not yet implemented; see plan.md guardrail #4)` };
    }
  }
  return { denied: false };
}

// The one function real tool-layer code should call: combines allowlist +
// deny-list (+ optional package.json content check) into a single
// allow/deny decision, deny-list always winning. Mirrors
// designer_tool_functions.js's assertAllowedExtension in spirit (fail with
// a clear reason) but returns a result object instead of throwing, so the
// eventual tool layer can decide how to surface the failure (thrown Error
// vs. a structured tool-result) without this module taking that decision
// for it.
export function isWriteAllowed(path, options = {}) {
  const denyResult = isPathDenied(path, options);
  if (denyResult.denied) return { allowed: false, reason: denyResult.reason };

  const allowResult = isPathAllowed(path, options);
  if (!allowResult.allowed) return { allowed: false, reason: allowResult.reason };

  if (options.beforeContent !== undefined || options.afterContent !== undefined) {
    const pkgResult = touchesPackageJsonRiskyFields(path, options.beforeContent, options.afterContent);
    if (pkgResult.denied) return { allowed: false, reason: pkgResult.reason };
  }

  return { allowed: true };
}
