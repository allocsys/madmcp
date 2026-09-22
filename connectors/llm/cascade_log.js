// ---------------------------------------------------------------------------
// connectors/llm/cascade_log.js — Shared helper for Gemini multi-key/multi-model
// cascade-visibility logging.
// ---------------------------------------------------------------------------

export function formatCascadeLogLine(candidate, { step, fallbackModel } = {}) {
  if (!candidate) return null;
  const modelChanged = Boolean(candidate._fallbackModelUsed);
  const keyChanged = candidate._fallbackKeyIndex !== undefined;
  if (!modelChanged && !keyChanged) return null;

  if (modelChanged) {
    // A real model fallback occurred -- client.js only ever sets
    // _fallbackModelUsed when the model itself actually changed from the
    // primary/requested one, so this is always a concrete string, never
    // undefined.
    const keyNote = keyChanged ? `, key #${candidate._fallbackKeyIndex}` : "";
    return `[step ${step}] [CASCADE] served by fallback model "${candidate._fallbackModelUsed}"${keyNote} -- primary model/key was unavailable (rate-limited, overloaded, or rejected).`;
  }

  // Key-only fallback: the model never changed, so calling this a "fallback
  // MODEL" would misrepresent what happened -- only the API key rotated.
  // `fallbackModel` (when a caller supplies an explicit model, e.g.
  // agent_delegate.js's effectiveModel) names which model this was on;
  // most callers don't pass one (editor_delegate.js never does, and
  // agent_delegate.js's effectiveModel is frequently undefined on a fresh
  // run with no explicit model requested) -- omit the model clause
  // entirely in that case rather than ever interpolating the literal
  // string "undefined" into the log line.
  const modelNote = fallbackModel ? ` on model "${fallbackModel}"` : "";
  return `[step ${step}] [CASCADE] served by fallback key #${candidate._fallbackKeyIndex}${modelNote} -- primary key was unavailable (rate-limited, overloaded, or rejected).`;
}
