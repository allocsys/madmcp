import OpenAI from 'openai';

const MODEL = 'text-embedding-3-small';
// Batch size per API call — keeps well under OpenAI's per-request token/item
// limits while amortizing request overhead across a scan's many chunks.
const BATCH_SIZE = 200;

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

// Embeds a list of chunk texts and returns embeddings in the same order as
// the input (so callers can zip results back onto their chunk objects by
// index). Returns [] for an empty input without making a network call.
export async function embedTexts(texts) {
  if (!texts.length) return [];

  const openai = getClient();
  const embeddings = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({ model: MODEL, input: batch });
    for (let j = 0; j < res.data.length; j++) {
      embeddings[i + j] = res.data[j].embedding;
    }
  }

  return embeddings;
}
