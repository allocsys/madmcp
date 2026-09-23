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

const MODEL = 'gemini-embedding-001';
const OUTPUT_DIMENSIONALITY = 1536;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Gemini's batchEmbedContents caps at 100 requests per call.
const BATCH_SIZE = 100;

function getApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  return key;
}

// Embeds a list of chunk texts and returns embeddings in the same order as
// the input (so callers can zip results back onto their chunk objects by
// index). Returns [] for an empty input without making a network call.
export async function embedTexts(texts) {
  if (!texts.length) return [];

  const apiKey = getApiKey();
  const embeddings = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
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

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini embeddings request failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const { embeddings: batchEmbeddings } = await res.json();
    for (let j = 0; j < batchEmbeddings.length; j++) {
      embeddings[i + j] = batchEmbeddings[j].values;
    }
  }

  return embeddings;
}
