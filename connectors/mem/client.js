// ---------------------------------------------------------------------------
// connectors/mem/client.js  —  Mem0 REST API (api.mem0.ai)
// Docs: https://docs.mem0.ai/api-reference
// Auth header: "Authorization: Token <api_key>"
// ---------------------------------------------------------------------------

import { MEM0_API_KEY, MEM0_API, MEM0_MIN_REQUEST_INTERVAL_MS, MEM0_MAX_RETRIES, MEM0_RETRY_BASE_MS } from "../../config.js";
import { createThrottle, sleep, defaultRetryDelayMs } from "../shared/rate-limit.js";

// --- Throttle + retry (fix #3, 2026-07-27) ----------------------------------
// See connectors/notion/client.js's identical comment for the rationale --
// same shared queue/backoff shape, just against Mem0 instead of Notion.
const scheduleThrottled = createThrottle(MEM0_MIN_REQUEST_INTERVAL_MS);

// Mem0 doesn't document its rate-limit response shape as precisely as
// GitHub/Notion do, so this errs toward treating any 429 or 5xx as worth one
// retry (a transient overload/rate-limit signal) -- 4xx other than 429
// (bad request, auth, not found) still throws immediately, unretried.
function isRetryableMem0(res) {
  return res.status === 429 || res.status >= 500;
}

async function doMem0Fetch(path, { method, body }) {
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
  return { res, data };
}

export async function mem0Request(path, { method = "GET", body } = {}) {
  if (!MEM0_API_KEY) throw new Error("MEM0_API_KEY is not set. Add it as an environment variable on the madmcp server.");

  let lastErr;
  for (let attempt = 0; attempt <= MEM0_MAX_RETRIES; attempt++) {
    const { res, data } = await scheduleThrottled(() => doMem0Fetch(path, { method, body }));

    if (res.ok) return data;

    if (isRetryableMem0(res) && attempt < MEM0_MAX_RETRIES) {
      await sleep(defaultRetryDelayMs(res, attempt, MEM0_RETRY_BASE_MS));
      lastErr = res;
      continue;
    }

    const message = (data && (data.message || data.error || data.detail || JSON.stringify(data))) || res.statusText;
    throw new Error(`Mem0 API error (${res.status}): ${message}`);
  }

  // Exhausted retries.
  throw new Error(`Mem0 API error (${lastErr ? lastErr.status : 429}): rate limited -- exhausted ${MEM0_MAX_RETRIES} retries`);
}
