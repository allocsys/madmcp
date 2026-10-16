// ---------------------------------------------------------------------------
// connectors/termux/actions.js — allowlist + argument validation for
// termux_api's structured phone actions.
//
// The server never sends a command string for these: it sends an action name
// plus a small validated args object, and the phone agent
// (scripts/termux-agent.mjs) maps that to a fixed termux-* argv. Keep the two
// in sync -- an action added here but missing from the agent's table is
// rejected on the phone with a clear "unknown action" error.
//
// Deliberately NOT included: SMS, calls, contacts, camera, microphone. Those
// are privacy-heavy and a raw `termux_exec` already covers them for an owner
// who really wants them; they shouldn't be one enum value away.
// ---------------------------------------------------------------------------

export const API_ACTIONS = [
  "battery",
  "location",
  "clipboard_get",
  "clipboard_set",
  "notify",
  "toast",
  "vibrate",
  "wifi_info",
];

const MAX_TEXT_CHARS = 2000;
const MAX_VIBRATE_MS = 5000;

const RULES = {
  battery:       {},
  location:      {},
  clipboard_get: {},
  wifi_info:     {},
  clipboard_set: { required: ["text"] },
  toast:         { required: ["text"] },
  notify:        { required: ["content"], optional: ["title"] },
  vibrate:       { optional: ["duration_ms"] },
};

// Returns { args } on success or { error } describing what is wrong. Only
// the keys an action actually uses survive into `args`; anything else the
// caller passed is dropped, so a stray field can never reach the phone.
export function buildApiArgs(action, input = {}) {
  const rule = RULES[action];
  if (!rule) {
    return { error: `Unknown action '${action}'. Valid actions: ${API_ACTIONS.join(", ")}.` };
  }
  const args = {};
  for (const key of rule.required || []) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      return { error: `Action '${action}' requires '${key}' (a non-empty string).` };
    }
    args[key] = value.slice(0, MAX_TEXT_CHARS);
  }
  for (const key of rule.optional || []) {
    const value = input[key];
    if (value === undefined) continue;
    if (key === "duration_ms") {
      if (!Number.isFinite(value) || value < 1 || value > MAX_VIBRATE_MS) {
        return { error: `'duration_ms' must be a number between 1 and ${MAX_VIBRATE_MS}.` };
      }
      args[key] = Math.round(value);
    } else if (typeof value === "string") {
      args[key] = value.slice(0, MAX_TEXT_CHARS);
    } else {
      return { error: `'${key}' must be a string.` };
    }
  }
  return { args };
}
