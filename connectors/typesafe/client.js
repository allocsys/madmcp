// ---------------------------------------------------------------------------
// connectors/typesafe/client.js — TypeSafe AI (api.typesafe.ai) client for
// Jev classification and decision models (OpenAI-compatible chat completions).
// ---------------------------------------------------------------------------

import { TYPESAFE_API_KEY, JEV_MODEL } from "../../config.js";

const DEFAULT_TIMEOUT_MS = 30000;

function parseJsonContent(text) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export async function jevChat(messages, { maxOutputTokens, responseFormat, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!TYPESAFE_API_KEY) {
    throw new Error("No TypeSafe API key available. Set TYPESAFE_API_KEY as an environment variable on the madmcp server.");
  }

  const body = {
    model: JEV_MODEL,
    messages,
  };
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (responseFormat) body.response_format = responseFormat;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch("https://api.typesafe.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(isAbort ? `TypeSafe/Jev request timed out after ${timeoutMs}ms` : `TypeSafe/Jev request failed (network error): ${err.message}`);
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`TypeSafe/Jev API error (${res.status}): ${message}`);
  }

  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("TypeSafe/Jev returned no choices.");
  }
  return choice.message?.content || "";
}

export async function scoreTaskComplexity(task) {
  try {
    const content = await jevChat([
      {
        role: "system",
        content: "You are a task complexity classifier. Classify the given task into one of: 'trivial', 'simple', 'moderate', 'complex'. Respond ONLY with a valid JSON object containing keys: 'complexity' (one of the strings above) and 'confidence' (number between 0 and 1)."
      },
      {
        role: "user",
        content: task
      }
    ], { responseFormat: { type: "json_object" } });

    const parsed = parseJsonContent(content);
    const complexity = ["trivial", "simple", "moderate", "complex"].includes(parsed?.complexity) ? parsed.complexity : null;
    const confidence = typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { complexity, confidence };
  } catch (err) {
    return { complexity: null, confidence: 0 };
  }
}

export async function scoreEditRisk(task, diff) {
  try {
    const content = await jevChat([
      {
        role: "system",
        content: "You are an AI code reviewer. Judge whether the given code diff matches the user task and rate the risk. Respond ONLY with a valid JSON object containing keys: 'matchesTask' ('yes' | 'partially' | 'no'), 'risk' (number 0 to 1), and 'confidence' (number 0 to 1)."
      },
      {
        role: "user",
        content: `Task:\n${task}\n\nDiff/Content:\n${diff}`
      }
    ], { responseFormat: { type: "json_object" } });

    const parsed = parseJsonContent(content);
    const matchesTask = ["yes", "partially", "no"].includes(parsed?.matchesTask) ? parsed.matchesTask : null;
    const risk = typeof parsed?.risk === "number" ? Math.max(0, Math.min(1, parsed.risk)) : null;
    const confidence = typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { matchesTask, risk, confidence };
  } catch (err) {
    return { matchesTask: null, risk: null, confidence: 0 };
  }
}

export function stepBudgetForComplexity(complexity) {
  switch (complexity) {
    case "trivial": return 3;
    case "simple": return 8;
    case "moderate": return 20;
    case "complex": return 30;
    default: return null;
  }
}
