// ---------------------------------------------------------------------------
// connectors/repomap/embed.js — embeds repo_map search queries via the
// Gemini API, for madmcp's direct (worker-bypassing) query path.
//
// Ported from worker/src/embed/gemini.js -- MUST stay in lockstep with it:
// same model, same outputDimensionality, or query embeddings will land in a
// different vector space than the embeddings the worker wrote for each
// chunk, and cosine distance between them becomes meaningless. If you
// change one, change the other.
// ---------------------------------------------------------------------------

import { GEMINI_API_KEYS } from "../../config.js";

const MODEL = "gemini-embedding-001";
const OUTPUT_DIMENSIONALITY = 1536; // must match chunks.embedding vector(1536) in worker/src/db/schema.sql
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Embeds a single query string. Tries each configured Gemini key in order
// (same rotation convention as GEMINI_API_KEYS elsewhere in this repo),
// moving to the next key only on an auth/quota-shaped failure (401/403/429).
export async function embedQuery(text) {
  if (!GEMINI_API_KEYS.length) {
    throw new Error("GEMINI_API_KEYS (or legacy GEMINI_API_KEY) is not set -- required to embed repo_map search queries.");
  }

  let lastErr;
  for (const apiKey of GEMINI_API_KEYS) {
    try {
      const res = await fetch(`${API_BASE}/models/${MODEL}:embedContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: OUTPUT_DIMENSIONALITY,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`Gemini embeddings request failed (${res.status}): ${body.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }

      const { embedding } = await res.json();
      return embedding.values;
    } catch (err) {
      lastErr = err;
      if (err.status === 401 || err.status === 403 || err.status === 429) continue; // try next key
      throw err; // not a key-rotation-shaped failure -- surface immediately
    }
  }
  throw lastErr;
}
