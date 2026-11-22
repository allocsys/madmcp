// Test helper: replays the write calls recorded on a mocked notionRequest
// against a page's original blocks and returns the resulting note lines
// (the blocks between the checkpoint start and end markers).
const textOf = (b) => (b.paragraph?.rich_text || []).map((t) => t.text?.content ?? t.plain_text ?? "").join("");

export function finalNoteTexts(calls, pageId, originalBlocks) {
  const inner = originalBlocks.filter((b) => b.id.startsWith("note-"));
  let list = inner.map((b) => ({ id: b.id, text: textOf(b) }));
  const startId = originalBlocks.find((b) => b.id.startsWith("start-"))?.id;
  let n = 0;
  for (const [path, opts = {}] of calls) {
    const method = opts.method || "GET";
    if (path === `/blocks/${pageId}/children` && method === "PATCH") {
      const created = (opts.body.children || []).map((c) => ({ id: `new-${n++}`, text: textOf(c) }));
      const after = opts.body.after;
      const at = !after || after === startId ? 0 : list.findIndex((x) => x.id === after) + 1;
      list = [...list.slice(0, at), ...created, ...list.slice(at)];
    } else if (/^\/blocks\/[\w-]+$/.test(path) && method === "PATCH" && opts.body?.paragraph) {
      const id = path.replace("/blocks/", "");
      const item = list.find((x) => x.id === id);
      if (item) item.text = textOf(opts.body);
    } else if (/^\/blocks\/[\w-]+$/.test(path) && method === "DELETE") {
      const id = path.replace("/blocks/", "");
      list = list.filter((x) => x.id !== id);
    }
  }
  return list.map((x) => x.text);
}
