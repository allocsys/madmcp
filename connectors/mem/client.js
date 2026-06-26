// ---------------------------------------------------------------------------
// connectors/mem/client.js  —  Mem0 REST API (api.mem0.ai)
// Docs: https://docs.mem0.ai/api-reference
// Auth header: "Authorization: Token <api_key>"
// ---------------------------------------------------------------------------

import { MEM0_API_KEY, MEM0_API } from "../../config.js";

export async function mem0Request(path, { method = "GET", body } = {}) {
  if (!MEM0_API_KEY) throw new Error("MEM0_API_KEY is not set. Add it as an environment variable on the Manufact server.");
  const res = await fetch(`${MEM0_API}${path}`, {
    method,
    headers: {
      Authorization:  `Token ${MEM0_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = (data && (data.message || data.error || data.detail || JSON.stringify(data))) || res.statusText;
    throw new Error(`Mem0 API error (${res.status}): ${message}`);
  }
  return data;
}
