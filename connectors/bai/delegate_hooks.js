// ---------------------------------------------------------------------------
// connectors/bai/delegate_hooks.js — bai-specific behavior for the shared
// delegate agent loop (connectors/delegate/agent/agent_delegate.js).
//
// Moved out of the neutral loop file (decouple-gemini-delegation plan,
// step 4): editing bai's own delegate-loop behavior -- whether history
// compaction is enabled for it, and its forced-final-step reasoningEffort
// override -- now means editing this file only, not the shared loop file
// every other provider's calls also run through.
//
// Looked up by connectors/delegate/provider_hooks.js's getDelegateHooks(),
// keyed on the `provider` string passed through providerChat -- NOT
// imported directly by agent_delegate.js itself. See that file's own
// header for the registry/lookup mechanism this plugs into.
// ---------------------------------------------------------------------------

import { HISTORY_COMPACTION_PROVIDERS } from "../../config.js";

export const baiDelegateHooks = {
  // History compaction (see agent_delegate.js's compactHistoryInPlace)
  // stays driven by the operator-configurable HISTORY_COMPACTION_PROVIDERS
  // env var (config.js, defaults to ["bai"]) -- this just resolves that
  // generic config down to a yes/no for bai specifically, so the neutral
  // loop no longer needs to know the env var's name or shape, or contain a
  // literal "bai" string, at all.
  historyCompactionEnabled: HISTORY_COMPACTION_PROVIDERS.includes("bai"),

  // Forced-final-step reasoningEffort gating fix: bai gets
  // "low" reasoning effort on its forced final step (no tools available,
  // must answer in plain text) to keep that turn fast and deterministic --
  // see agent_delegate.js's BAI_PREAMBLE_ADDENDUM comment for the related
  // prompt-side context this pairs with. Every other provider is left at
  // its own default (undefined, via DEFAULT_HOOKS in provider_hooks.js).
  getReasoningEffort(isFinalStep) {
    return isFinalStep ? "low" : undefined;
  },
};
