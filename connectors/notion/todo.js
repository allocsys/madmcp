// ---------------------------------------------------------------------------
// connectors/notion/todo.js
// ---------------------------------------------------------------------------
// Pure helpers for the todo section kept inside checkpoint notes. No I/O:
// callers pass the notes as an array of lines and get edited lines back.
//
// Item line format: "#<id> [ ] text" (open), "#<id> [~] text" (doing),
// "#<id> [x] text" (done). Items sit under a "TODO" heading line. IDs are
// stable: a new item gets max(existing id) + 1, so ticking or clearing items
// never renumbers the rest.
// ---------------------------------------------------------------------------

export const TODO_HEADER = "TODO";
const ITEM_RE = /^#(\d+) \[([ ~x])\] (.*)$/;
const MARK = { open: " ", doing: "~", done: "x" };

export function parseTodos(lines) {
  const items = [];
  lines.forEach((line, idx) => {
    const m = ITEM_RE.exec(line.trim());
    if (m) items.push({ idx, id: Number(m[1]), mark: m[2], text: m[3] });
  });
  return items;
}

const fmt = (id, mark, text) => `#${id} [${mark}] ${text}`;

// Adds items (already split into lines). Returns { lines, ids }.
export function addTodos(lines, texts) {
  const clean = texts.map((t) => t.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  if (!clean.length) throw new Error("todo_add requires 'notes' (one todo per line).");
  const items = parseTodos(lines);
  let next = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const ids = [];
  const added = clean.map((t) => { ids.push(next); return fmt(next++, MARK.open, t); });
  const out = [...lines];
  if (items.length) {
    const last = items[items.length - 1].idx;
    out.splice(last + 1, 0, ...added);
  } else {
    out.push(TODO_HEADER, ...added);
  }
  return { lines: out, ids };
}

// Sets the state of the given ids. Returns { lines, changed, missing }.
export function setTodoState(lines, ids, state) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("'ids' is required (an array of todo numbers).");
  const items = parseTodos(lines);
  const out = [...lines];
  const changed = [];
  const missing = [];
  for (const id of ids) {
    const item = items.find((i) => i.id === id);
    if (!item) { missing.push(id); continue; }
    out[item.idx] = fmt(item.id, MARK[state], item.text);
    changed.push(id);
  }
  return { lines: out, changed, missing };
}

// Open and doing items only, one per line.
export function listOpenTodos(lines) {
  return parseTodos(lines).filter((i) => i.mark !== MARK.done).map((i) => fmt(i.id, i.mark, i.text));
}

export function openTodoCount(lines) {
  return parseTodos(lines).filter((i) => i.mark !== MARK.done).length;
}

// Removes done items (and the TODO heading when no items are left).
export function clearDoneTodos(lines) {
  const drop = new Set(parseTodos(lines).filter((i) => i.mark === MARK.done).map((i) => i.idx));
  let out = lines.filter((_, i) => !drop.has(i));
  if (!parseTodos(out).length) out = out.filter((l) => l.trim() !== TODO_HEADER);
  return { lines: out, removed: drop.size };
}
