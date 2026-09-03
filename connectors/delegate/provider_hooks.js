// ---------------------------------------------------------------------------
// connectors/delegate/provider_hooks.js — per-provider hook lookup for the
// shared delegate agent loop (connectors/delegate/agent/agent_delegate.js).
//
// Decouple-gemini-delegation plan, step 4: the neutral loop file used to
// contain bai-specific branches directly (a HISTORY_COMPACTION_PROVIDERS
// check, a `provider === "bai"` reasoningEffort branch) -- editing either
// one meant editing the SAME file every other provider's calls also run
// through. This module is the one place that maps a provider name to its
// own hooks module, so the loop itself only ever calls
// getDelegateHooks(provider).<hook> and never branches on a provider name
// directly.
//
// Only providers with actual non-default delegate-loop behavior get a
// registry entry here (and a corresponding connectors/<provider>/
// delegate_hooks.js file) -- currently just bai. gemini/glm/groq have no
// delegate-loop-specific behavior of their own, so they fall through to
// DEFAULT_HOOKS below rather than each needing a trivial no-op file.
// ---------------------------------------------------------------------------

import { baiDelegateHooks } from "../bai/delegate_hooks.js";

const DEFAULT_HOOKS = {
  historyCompactionEnabled: false,
  getReasoningEffort: () => undefined,
};

const REGISTRY = {
  bai: baiDelegateHooks,
};

export function getDelegateHooks(provider) {
  return REGISTRY[provider] || DEFAULT_HOOKS;
}
