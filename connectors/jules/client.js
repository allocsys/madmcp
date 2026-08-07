// ---------------------------------------------------------------------------
// connectors/jules/client.js — Jules REST API (jules.googleapis.com)
// Docs: https://jules.google/docs/api/reference/
// Auth header: "x-goog-api-key: <api_key>" (required — no unauthenticated tier).
// Alpha API per Google's own docs: endpoint shapes may change without notice.
// ---------------------------------------------------------------------------

import { JULES_API_KEY, JULES_API } from "../../config.js";

export async function julesRequest(path, { method = "GET", params = {}, body } = {}) {
  if (!JULES_API_KEY) {
    throw new Error("JULES_API_KEY is not set — Jules tools are unavailable until it's configured.");
  }

  const url = new URL(`${JULES_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const headers = { "x-goog-api-key": JULES_API_KEY };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`Jules API error (${res.status}): ${message}`);
  }
  return data;
}
