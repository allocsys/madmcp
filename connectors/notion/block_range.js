// ---------------------------------------------------------------------------
// connectors/notion/block_range.js
// ---------------------------------------------------------------------------
// Pure helpers for editing a RANGE of lines/blocks by anchor, so a caller can
// delete or overwrite a block without resending its exact text (the exact
// `find` match that `edit` / `replacements` need costs tokens and fails on any
// typo). Shared by the checkpoint tool (replace_block / delete_block) and
// notion_update (block_edits). No I/O here: callers pass in the plain text of
// each line/block and get back 0-based indexes (or the edited lines).
//
// An anchor is either:
//   - a 1-based line/block number: a JS number, or a string of only digits
//     ("3"); or
//   - a short prefix of the line's text ("NEXT", "- Item B"). Leading
//     whitespace on the line is ignored. A prefix must match exactly ONE line
//     (for `end`, exactly one line at or after `start`), otherwise the edit
//     aborts and the error lists the matching line numbers.
// ---------------------------------------------------------------------------

const preview = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

function isBlankAnchor(anchor) {
  return anchor === undefined || anchor === null || (typeof anchor === "string" && !anchor.trim());
}

export function isLineNumber(anchor) {
  return typeof anchor === "number" || (typeof anchor === "string" && /^\d+$/.test(anchor.trim()));
}

// Resolves one anchor to a 0-based index into `texts`. `from` limits prefix
// matching to indexes >= from (used for `end`); numbers are always absolute.
export function resolveAnchor(texts, anchor, label = "anchor", { from = 0 } = {}) {
  if (isBlankAnchor(anchor)) throw new Error(`'${label}' is required.`);
  if (isLineNumber(anchor)) {
    const n = Number(anchor);
    if (!Number.isInteger(n) || n < 1 || n > texts.length) {
      throw new Error(`'${label}' ${anchor} is out of range (there ${texts.length === 1 ? "is 1 line" : `are ${texts.length} lines`}).`);
    }
    return n - 1;
  }
  const prefix = String(anchor).trim();
  const hits = [];
  for (let i = from; i < texts.length; i++) {
    if ((texts[i] ?? "").trimStart().startsWith(prefix)) hits.push(i);
  }
  if (hits.length === 1) return hits[0];
  const where = from > 0 ? " at or after 'start'" : "";
  if (hits.length === 0) throw new Error(`'${label}' "${preview(prefix)}" does not start any line${where}.`);
  const shown = hits.slice(0, 5).map((i) => i + 1).join(", ") + (hits.length > 5 ? ", …" : "");
  throw new Error(`'${label}' "${preview(prefix)}" starts ${hits.length} lines${where} (${shown}). Use a longer prefix or a line number.`);
}

// Resolves { start, end? } to a 0-based inclusive range. `end` defaults to
// `start` (a single line).
export function resolveRange(texts, start, end) {
  const s = resolveAnchor(texts, start, "start");
  const e = isBlankAnchor(end) ? s : resolveAnchor(texts, end, "end", { from: s });
  if (e < s) throw new Error(`'end' (line ${e + 1}) comes before 'start' (line ${s + 1}).`);
  return { start: s, end: e };
}

// Splits replacement text into lines. Empty lines are dropped, same as every
// other plain-text writer in this connector (one paragraph block per line).
export function contentToLines(content) {
  return typeof content === "string" ? content.split("\n").filter((l) => l.length > 0) : [];
}

// Replaces (or, with empty content, deletes) the lines from `start` to `end`.
// Returns the new lines plus 1-based bounds and counts for the result message.
export function applyLineEdit(lines, { start, end, content }) {
  const { start: s, end: e } = resolveRange(lines, start, end);
  const added = contentToLines(content);
  return {
    lines: [...lines.slice(0, s), ...added, ...lines.slice(e + 1)],
    from: s + 1,
    to: e + 1,
    removed: e - s + 1,
    added: added.length,
  };
}
