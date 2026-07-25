// ---------------------------------------------------------------------------
// connectors/gemini/client.js — Gemini API (generativelanguage.googleapis.com)
// Docs: https://ai.google.dev/gemini-api/docs
// Auth header: "x-goog-api-key: <api_key>"
// ---------------------------------------------------------------------------

import { GEMINI_API_KEY, GEMINI_API, GEMINI_MODEL } from "../../config.js";

async function callGenerateContent(body, model) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Add it as an environment variable on the Manufact server.");

  const res = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type":   "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`Gemini API error (${res.status}): ${message}`);
  }
  return data;
}

// Single-turn text generation. Takes a plain prompt string (build any
// system/user framing into it before calling) and returns the model's text
// output. Used by web_fetch_and_ask -- a genuine one-shot "here's context,
// answer this" call with no tool use.
export async function geminiGenerate(prompt, { model = GEMINI_MODEL, maxOutputTokens } = {}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const data = await callGenerateContent(body, model);
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts = candidate?.content?.parts || [];
  const output = parts.map((p) => p.text || "").join("");

  if (!output) {
    // e.g. finishReason "SAFETY" or "RECITATION" with no text part -- surface
    // the reason rather than silently returning an empty string.
    throw new Error(`Gemini returned no text output (finishReason: ${finishReason || "unknown"}).`);
  }
  return output;
}

// Multi-turn call WITH function-calling support -- used by
// connectors/gemini/delegate.js's investigation loop. Unlike geminiGenerate,
// this takes/returns the raw `contents` conversation array and the raw
// candidate, since the caller (delegate.js) needs to inspect whether the
// response is a functionCall (keep looping) or plain text (done), which a
// single flattened string can't represent.
//
// `contents` follows Gemini's REST shape: an array of
// { role: "user"|"model"|"function", parts: [...] } turns. Function-call
// results are fed back as a "function" role turn containing a
// functionResponse part -- see delegate.js for how a turn is built.
export async function geminiChat(contents, { model = GEMINI_MODEL, tools, maxOutputTokens } = {}) {
  const body = { contents };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const data = await callGenerateContent(body, model);
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini returned no candidates.");
  }
  return candidate; // { content: { role, parts }, finishReason, ... }
}
