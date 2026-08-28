// ---------------------------------------------------------------------------
// connectors/llm/cascade_log.js — Shared helper for Gemini multi-key/multi-model
// cascade-visibility logging.
// ---------------------------------------------------------------------------

export function formatCascadeLogLine(candidate, { step, fallbackModel } = {}) {
  if (!candidate) return null;
  if (candidate._fallbackModelUsed || candidate._fallbackKeyIndex !== undefined) {
    const keyNote = candidate._fallbackKeyIndex !== undefined ? `, key #${candidate._fallbackKeyIndex}` : "";
    return `[step ${step}] [CASCADE] served by fallback model "${candidate._fallbackModelUsed || fallbackModel}"${keyNote} -- primary model/key was unavailable (rate-limited, overloaded, or rejected).`;
  }
  return null;
}
