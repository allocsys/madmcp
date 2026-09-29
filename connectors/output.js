// ---------------------------------------------------------------------------
// connectors/output.js — shared helpers that keep tool results small.
//
// Every tool result is pasted into the calling model's context, so oversized or
// pretty-printed output directly costs tokens. These helpers:
//   * serialize JSON compactly (no indentation / newlines), and
//   * cap total output size, appending an explicit notice when truncated so the
//     caller knows to narrow the request instead of assuming it saw everything.
//
// The default cap can be overridden per deployment with MADMCP_MAX_OUTPUT_CHARS
// and per call with the `maxChars` option (0 disables the cap).
// ---------------------------------------------------------------------------

const ENV_MAX = Number(process.env.MADMCP_MAX_OUTPUT_CHARS);
export const DEFAULT_MAX_OUTPUT_CHARS = Number.isFinite(ENV_MAX) && ENV_MAX > 0 ? ENV_MAX : 20000;

// Strings pass through untouched; everything else becomes compact JSON.
export function toCompactText(data) {
  if (typeof data === "string") return data;
  const text = JSON.stringify(data);
  return text === undefined ? "" : text;
}

export function capText(text, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  if (!maxChars || text.length <= maxChars) return text;
  return (
    `${text.slice(0, maxChars)}\n` +
    `…[truncated: showing ${maxChars} of ${text.length} characters. ` +
    `Narrow the request (filters, limit, fields) to see the rest.]`
  );
}

export function textResult(data, { maxChars } = {}) {
  return { content: [{ type: "text", text: capText(toCompactText(data), maxChars) }] };
}

// Truncate an array to `max` items. Returns the (possibly shortened) array and
// how many items were omitted, so callers can surface an honest notice.
export function capArray(items, max) {
  if (!Array.isArray(items) || !max || items.length <= max) {
    return { items, omitted: 0 };
  }
  return { items: items.slice(0, max), omitted: items.length - max };
}

// Keep only the listed top-level keys of each object (a cheap `fields` filter).
export function pickFields(items, fields) {
  if (!Array.isArray(items) || !Array.isArray(fields) || fields.length === 0) return items;
  return items.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const out = {};
    for (const f of fields) if (f in item) out[f] = item[f];
    return out;
  });
}
