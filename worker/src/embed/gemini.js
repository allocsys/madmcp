// Embeds chunk text via the Gemini API (gemini-embedding-001), replacing
// the previous OpenAI text-embedding-3-small integration. Uses plain
// fetch (Node 20 ships a global fetch) rather than a new SDK dependency.
//
// outputDimensionality is pinned to 1536 via Gemini's Matryoshka
// Representation Learning support (the model's native output is 3072,
// truncatable to 768/1536/3072, or any value 128-3072) specifically to
// match the existing `chunks.embedding vector(1536)` column in
// db/schema.sql -- this avoids an otherwise-required migration + re-embed
// of anything already scanned. If that column's dimension ever changes,
// update OUTPUT_DIMENSIONALITY here to match.
//
// MULTI-KEY ROTATION: mirrors connectors/gemini/client.js's key-rotation
// cascade (and connectors/repomap/embed.js's simpler single-key-fallback
// sibling for the direct query-embed path) -- see getApiKeys() and
// embedBatchWithRotation() below. Deliberately NOT Redis-backed like
// connectors/shared/cooldown.js: this worker runs as one long-lived
// Railway container (not a Vercel serverless function that loses state
// between invocations), so an in-process Map already gives cross-call
// memory for free within this process. Revisit if this worker is ever
// scaled to multiple replicas, since cooldown state wouldn't be shared
// across them.

const MODEL = 'gemini-embedding-001';
const OUTPUT_DIMENSIONALITY = 1536;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Gemini's batchEmbedContents caps at 100 requests per call.
const BATCH_SIZE = 100;
// Used only when a 429's message doesn't contain a parseable "retry in Ns"
// hint -- Google's actual responses observed so far always include one,
// so this is a conservative fallback, not the common case. Mirrors
// connectors/shared/cooldown.js's DEFAULT_COOLDOWN_SECONDS.
const DEFAULT_COOLDOWN_SECONDS = 60;

// Parses GEMINI_API_KEYS (comma-separated) if set, falling back to the
// legacy singular GEMINI_API_KEY -- same shape/precedence as config.js's
// own GEMINI_API_KEYS parsing, duplicated here rather than imported since
// this worker is a separate package (its own package.json/deploy) and
// doesn't import from the root app's connectors/ or config.js.
function getApiKeys() {
  const multi = process.env.GEMINI_API_KEYS;
  if (multi) {
    const keys = multi.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length) return keys;
  }
  const single = process.env.GEMINI_API_KEY;
  if (single) return [single];
  throw new Error('GEMINI_API_KEYS (or GEMINI_API_KEY) is not set');
}

// keyIndex -> epoch ms until which that key is considered cooling down.
// Module-scoped so it persists across embedTexts() calls within this
// process (see file header for why that's safe/useful here but wouldn't
// be on a serverless deploy).
const cooldownUntil = new Map();
// Rotates which key each embedTexts() call starts its batch loop on, same
// load-spreading rationale as connectors/gemini/client.js's
// keyRotationCounter -- otherwise key 0 would absorb every single call's
// first attempt.
let keyRotationCounter = 0;

// Extracts a retry delay in whole seconds from a Gemini 429 error message,
// e.g. "...Please retry in 52.395004654s." Returns null if not found.
// Duplicated from connectors/shared/cooldown.js's parseRetryDelaySeconds
// (worker is a separate package and doesn't import root connectors/).
function parseRetryDelaySeconds(message) {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || '');
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

function isCoolingDown(keyIndex) {
  const until = cooldownUntil.get(keyIndex);
  return until !== undefined && until > Date.now();
}

function setCooldown(keyIndex, seconds) {
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
  cooldownUntil.set(keyIndex, Date.now() + ttl * 1000);
}

// Embeds one batch (<=BATCH_SIZE texts), rotating through all configured
// keys. A 429 on a key records a cooldown (parsed from the error message,
// or DEFAULT_COOLDOWN_SECONDS) and moves to the next key. A 401/403 (bad
// or revoked key) moves to the next key with no cooldown recorded -- it's
// not a quota signal, so there's nothing to time out. Any other failure
// (5xx, network error) is NOT key-rotation-shaped: it throws immediately
// rather than burning through the remaining keys on an error that isn't
// going to be fixed by switching credentials.
async function embedBatchWithRotation(batch, apiKeys) {
  const startOffset = keyRotationCounter++ % apiKeys.length;
  let lastErr;

  for (let k = 0; k < apiKeys.length; k++) {
    const keyIndex = (startOffset + k) % apiKeys.length;

    if (isCoolingDown(keyIndex)) {
      lastErr = lastErr || new Error(`Gemini embeddings: key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
      continue;
    }

    const apiKey = apiKeys[keyIndex];
    const res = await fetch(`${API_BASE}/models/${MODEL}:batchEmbedContents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        requests: batch.map((text) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: OUTPUT_DIMENSIONALITY,
        })),
      }),
    });

    if (res.ok) {
      const { embeddings } = await res.json();
      return embeddings.map((e) => e.values);
    }

    const body = await res.text().catch(() => '');
    const err = new Error(`Gemini embeddings request failed (${res.status}): ${body.slice(0, 500)}`);
    err.status = res.status;
    lastErr = err;

    const isBadKey = res.status === 401 || res.status === 403;
    const isRateLimited = res.status === 429;

    if (isBadKey) continue; // no cooldown -- not a quota signal, just a dead key
    if (isRateLimited) {
      setCooldown(keyIndex, parseRetryDelaySeconds(err.message));
      continue;
    }
    // 5xx / anything else: not key-rotation-shaped, don't burn remaining keys.
    throw err;
  }

  throw lastErr;
}

// Embeds a list of chunk texts and returns embeddings in the same order as
// the input (so callers can zip results back onto their chunk objects by
// index). Returns [] for an empty input without making a network call.
export async function embedTexts(texts) {
  if (!texts.length) return [];

  const apiKeys = getApiKeys();
  const embeddings = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await embedBatchWithRotation(batch, apiKeys);
    for (let j = 0; j < batchEmbeddings.length; j++) {
      embeddings[i + j] = batchEmbeddings[j];
    }
  }

  return embeddings;
}
