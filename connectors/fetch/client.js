// ---------------------------------------------------------------------------
// connectors/fetch/client.js — simple HTTP fetch helper
// ---------------------------------------------------------------------------

export async function fetchUrl(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": "manufact-mcp-server/2.0",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
  });
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  return { status: res.status, ok: res.ok, contentType, text };
}
