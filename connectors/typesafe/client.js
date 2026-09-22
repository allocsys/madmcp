// ---------------------------------------------------------------------------
// connectors/typesafe/client.js — TypeSafe AI (api.typesafe.ai) client for "Jev"
// classification and decision model.
// ---------------------------------------------------------------------------

import { TYPESAFE_API_KEY, JEV_MODEL } from "../../config.js";
import { toOpenAIMessages } from "../openai_shape/adapter.js";

const DEFAULT_TIMEOUT_MS = 30000;

export async function jevChat(messages, { tools, maxOutputTokens, responseFormat, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!TYPESAFE_API_KEY) {
    throw new Error("No TypeSafe API key available. Set TYPESAFE_API_KEY as an environment variable.");
  }

  const formattedMessages = Array.isArray(messages) && messages[0]?.parts
    ? toOpenAIMessages(messages)
    : messages;

  const body = {
    model: JEV_MODEL,
    messages: formattedMessages,
  };
  if (tools) body.tools = tools;
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
    const wrapped = new Error(isAbort ? `TypeSafe request timed out after ${timeoutMs}ms` : `TypeSafe request failed (network error): ${err.message}`);
    wrapped.transient = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    const err = new Error(`TypeSafe API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }

  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("TypeSafe returned no choices.");
  }

  return choice;
}

function parseJsonFromContent(text) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();
  }
  return JSON.parse(cleaned);
}

export async function scoreTaskComplexity(task) {
  try {
    const choice = await jevChat([
      {
        role: "system",
        content: "You are a fast task complexity classifier. Classify the given task into one of: 'trivial', 'simple', 'moderate', 'complex' and provide a confidence score from 0.0 to 1.0. Output valid JSON only with keys 'complexity' and 'confidence'."
      },
      {
        role: "user",
        content: task
      }
    ], { responseFormat: { type: "json_object" } });

    const content = choice?.message?.content;
    const parsed = parseJsonFromContent(content);
    const validComplexities = ["trivial", "simple", "moderate", "complex"];
    const complexity = validComplexities.includes(parsed?.complexity) ? parsed.complexity : null;
    const confidence = typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { complexity, confidence };
  } catch {
    return { complexity: null, confidence: 0 };
  }
}

export async function scoreEditRisk(task, diff) {
  try {
    const choice = await jevChat([
      {
        role: "system",
        content: "You are an edit risk analyzer. Judge whether the given diff matches the user task ('yes' | 'partially' | 'no'), compute a risk score from 0.0 to 1.0, and provide a confidence score from 0.0 to 1.0. Output valid JSON only with keys 'matchesTask', 'risk', and 'confidence'."
      },
      {
        role: "user",
        content: `Task:\n${task}\n\nDiff:\n${diff}`
      }
    ], { responseFormat: { type: "json_object" } });

    const content = choice?.message?.content;
    const parsed = parseJsonFromContent(content);
    const validMatches = ["yes", "partially", "no"];
    const matchesTask = validMatches.includes(parsed?.matchesTask) ? parsed.matchesTask : null;
    const risk = typeof parsed?.risk === "number" ? Math.max(0, Math.min(1, parsed.risk)) : null;
    const confidence = typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    return { matchesTask, risk, confidence };
  } catch {
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
