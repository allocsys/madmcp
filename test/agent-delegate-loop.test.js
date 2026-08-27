import { describe, it, expect, vi, beforeEach } from "vitest";

// Net-new test file (plan.md step 8): nothing in test/ previously exercised
// runInvestigation/agent_delegate.js's loop itself (stuck-loop detection,
// step-budget nudges, checkpoint resume) -- only client.js/cooldown.js were
// covered (test/gemini-client.test.js). Parametrized against BOTH providers
// via a mocked providerChat, since these loop behaviors must be
// provider-invariant by construction (agent_delegate.js never branches on
// provider itself -- see plan.md step 6).
//
// Redis is deliberately left unconfigured (no UPSTASH_*/KV_* env vars set)
// so checkpoint.js/cooldown.js fail open exactly as they do in any
// environment without Redis provisioned -- no need to mock them, and this
// also lets the "resume with no live checkpoint" error path be exercised
// for real rather than through a mock.
//
// VERIFICATION PASS (2026-08-27, updated 2026-08-27 -- see plan.md "Gemini
// harness fix -- self-verification pass" and the later "Live verification
// test" runs 2-3): any draft final answer produced with tool budget still
// remaining (i.e. NOT already a forced no-tools turn, and at least one step
// left after it) triggers one extra self-verification providerChat call
// before the answer is returned. This is provider-agnostic (lives in the
// loop body, not gemini-specific code), so every test below that reaches a
// draft answer with steps to spare needs a second (or third) mocked
// providerChat response for that verification round-trip, with step/call
// counts bumped by one accordingly. Tests that reach their draft answer on
// an already-withheld-tools turn (the final allowed step, or the stuck-loop
// force) are unaffected -- withholdTools being true is exactly what skips
// the verification pass.
//
// IMPORTANT: unlike the original version, the verification-pass call is NOT
// tool-withheld -- it receives the same `tools: FUNCTION_DECLARATIONS` as a
// normal step. A no-tools verification pass was found live to sometimes
// confidently re-assert a wrong mechanical detail from memory instead of
// catching it (plan.md "Live verification test", runs 2-3); giving it tool
// access lets the model re-fetch instead of guessing. So `opts.tools` on the
// verification call should be asserted as defined (truthy), not undefined.
// A `!pendingVerification` guard (new) still keeps this to exactly one
// verification round per draft answer even though tools are available.

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

// github_get_repo_topics's execute() calls githubRequest -- mocked here so
// the "executes a function call" test below doesn't make a real network
// request. Every FUNCTIONS[].execute() is already wrapped in its own
// try/catch by agent_delegate.js's loop (a thrown error becomes a result
// string, not a loop failure), so this is only needed to keep the test
// hermetic, not to avoid a crash.
const mockGithubRequest = vi.fn();
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: mockGithubRequest,
}));

// github_read_file/github_get_file_at_commit's execute() calls
// readFileViaBlob (not githubRequest) -- mocked here for the gap-2 dedup
// test below, same hermetic-test reasoning as mockGithubRequest above.
const mockReadFileViaBlob = vi.fn();
vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: mockReadFileViaBlob,
}));

const originalEnv = { ...process.env };

describe.each(["gemini", "glm", "groq"])("agent_delegate.js — runInvestigation (provider: %s)", (provider) => {
  let runInvestigation;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    ({ runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
  });

  it("returns a plain-text answer after the mandatory verification pass, threading the provider through", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "The answer is 42." }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "The answer is 42." }] },
        finishReason: "STOP",
      });

    const result = await runInvestigation({ task: "what is the answer", max_steps: 5, provider });

    expect(result.answer).toBe("The answer is 42.");
    expect(result.steps).toBe(2);
    expect(result.failed).toBeUndefined();
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
    const [, opts] = mockProviderChat.mock.calls[0];
    expect(opts.provider).toBe(provider);
    const [, verifyOpts] = mockProviderChat.mock.calls[1];
    expect(verifyOpts.provider).toBe(provider);
    // Verification pass keeps tool access (2026-08-27 fix) so the model can
    // re-fetch instead of recalling a mechanical detail from memory.
    expect(verifyOpts.tools).toBeDefined();
  });

  it("runs a self-verification pass that can correct the draft answer before returning it", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "The file is unused." }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Correction: the file IS used, per the full file read." }] },
        finishReason: "STOP",
      });

    const result = await runInvestigation({ task: "check whether the file is used", max_steps: 5, provider });

    expect(result.answer).toBe("Correction: the file IS used, per the full file read.");
    expect(result.steps).toBe(2);
    expect(mockProviderChat).toHaveBeenCalledTimes(2);

    const [verifyContents, verifyOpts] = mockProviderChat.mock.calls[1];
    expect(verifyOpts.tools).toBeDefined();
    const lastMessage = verifyContents[verifyContents.length - 1];
    expect(lastMessage.parts[0].text).toMatch(/verification pass/i);
  });

  it("does not trigger a second verification round when the verification pass itself returns a draft answer", async () => {
    // Regression test for the !pendingVerification guard added alongside
    // the tool-access fix: since the verification turn now keeps tools, a
    // text-only response FROM that turn would otherwise satisfy the same
    // "draft answer with budget left" condition again and loop into a
    // second verification round indefinitely.
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "draft answer" }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "confirmed final answer" }] },
        finishReason: "STOP",
      });

    const result = await runInvestigation({ task: "single verification round only", max_steps: 10, provider });

    expect(result.answer).toBe("confirmed final answer");
    expect(result.steps).toBe(2);
    // Exactly 2 calls: the draft, then one verification pass. No third call.
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
  });

  it("executes a function call, feeds the result back, runs the verification pass, and returns the final answer", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "allocsys", repo: "madmcp" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Topics: mcp, ai" }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Topics: mcp, ai" }] },
        finishReason: "STOP",
      });

    mockGithubRequest.mockResolvedValueOnce({ names: ["mcp", "ai"] });

    const result = await runInvestigation({ task: "list topics", max_steps: 5, provider });

    expect(result.answer).toBe("Topics: mcp, ai");
    expect(result.steps).toBe(3);
    expect(mockProviderChat).toHaveBeenCalledTimes(3);
    // All three steps (call, draft answer, verification) used the same
    // provider throughout a single run.
    expect(mockProviderChat.mock.calls[0][1].provider).toBe(provider);
    expect(mockProviderChat.mock.calls[1][1].provider).toBe(provider);
    expect(mockProviderChat.mock.calls[2][1].provider).toBe(provider);
    // The verification-pass call (3rd) keeps tool access (2026-08-27 fix).
    expect(mockProviderChat.mock.calls[2][1].tools).toBeDefined();
    // The transcript recorded the call, whatever its result (error or not).
    expect(result.transcript[0]).toMatch(/^\[step 1\] github_get_repo_topics/);
  });

  // Regression test for the structural line-quote check (2026-08-27, see
  // plan.md "Run 5" and CONDITIONAL_CLAIM_PATTERN/lineIsVerbatimInToolResults'
  // comments in agent_delegate.js): extractMechanicalClaims/
  // findUnverifiedClaims alone check whether each individual identifier
  // TOKEN appears verbatim in raw tool output -- not whether the specific
  // RELATIONSHIP asserted between two real tokens matches the source. A
  // draft claiming `step < max_steps - 1` when the real line is
  // `step < cappedSteps` would pass a token-level check (both `step` and
  // `max_steps` are real identifiers present in fetched source) even though
  // the composed expression is fabricated. This test confirms the
  // structural line-quote mechanism catches that shape of error where the
  // token-level check alone would not, and that it is bounded to exactly
  // one corrective round.
  it("catches a plausible-but-wrong composed conditional via the structural line-quote check, even though a token-level check alone would pass it", async () => {
    const realSourceLine = "if (answer && !withholdTools && step < cappedSteps) {";

    mockProviderChat
      // Step 1: reads the file containing the real conditional.
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { owner: "a", repo: "b", path: "agent_delegate.js" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      // Step 2: draft answer asserts a wrong relationship between two real
      // identifiers (`step`, `max_steps`) -- both tokens are individually
      // real/verifiable, but the composed expression is fabricated.
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "The verification pass is skipped once `step < max_steps - 1` is false." }] },
        finishReason: "STOP",
      })
      // Step 3 (round 1 of verification): the model "confirms" its own
      // wrong claim with a fabricated LINE_QUOTE that does not match the
      // real source verbatim -- this is exactly the miscalibrated-
      // confidence failure mode the structural check exists to route
      // around instead of trusting the model's own say-so.
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Confirmed.\nLINE_QUOTE: if (answer && !withholdTools && step < max_steps - 1) {" }] },
        finishReason: "STOP",
      })
      // Step 4 (round 2, the bounded corrective round): the model finally
      // quotes the real line verbatim and corrects its answer.
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Corrected: the pass is skipped when `step < cappedSteps`.\nLINE_QUOTE: if (answer && !withholdTools && step < cappedSteps) {" }] },
        finishReason: "STOP",
      });

    mockReadFileViaBlob.mockResolvedValueOnce(`...\n${realSourceLine}\n...`);

    const result = await runInvestigation({ task: "what gates the verification pass", max_steps: 10, provider });

    // Exactly 4 calls: the read, the draft, the failed line-quote round,
    // and the one bounded corrective round -- never a second corrective
    // round even though the mechanism could in principle loop.
    expect(mockProviderChat).toHaveBeenCalledTimes(4);

    // The third call (round 1's response) must have been challenged with
    // the structural failure note, not silently accepted.
    const [round2Contents] = mockProviderChat.mock.calls[3];
    const correctionMessage = round2Contents[round2Contents.length - 1];
    expect(correctionMessage.parts[0].text).toMatch(/STRUCTURAL LINE-QUOTE CHECK FAILED/);

    // Final answer is the corrected one, with internal LINE_QUOTE markers
    // stripped before ever being returned to a caller.
    expect(result.answer).toBe("Corrected: the pass is skipped when `step < cappedSteps`.");
    expect(result.answer).not.toMatch(/LINE_QUOTE/);
    expect(result.steps).toBe(4);
  });

  it("recognizes repeat calls despite different key order in args (dedup fix gap 1)", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        // Same values as step 1, but keys written in a different order --
        // the raw `JSON.stringify(args)` signature this fix replaces would
        // treat this as a brand-new call.
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { repo: "b", owner: "a" }, id: "call_2" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "done" }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "done" }] },
        finishReason: "STOP",
      });

    mockGithubRequest.mockResolvedValueOnce({ names: ["mcp", "ai"] });

    const result = await runInvestigation({ task: "check key order dedup", max_steps: 5, provider });

    expect(result.transcript[0]).not.toMatch(/\[CACHED/);
    expect(result.transcript[1]).toMatch(/\[CACHED/);
    // The underlying API was only actually hit once -- the second call,
    // despite different key order, was served from the repeat cache.
    expect(mockGithubRequest).toHaveBeenCalledTimes(1);
  });

  it("recognizes github_read_file and github_get_file_at_commit(commit: \"HEAD\") on the same path as equivalent (dedup fix gap 2)", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { owner: "a", repo: "b", path: "x.js" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        // Different tool, different parameter name (commit vs ref), but the
        // same effective content: commit "HEAD" on the same path resolves
        // to the same tip-of-default-branch read as step 1's omitted ref.
        content: { role: "model", parts: [{ functionCall: { name: "github_get_file_at_commit", args: { owner: "a", repo: "b", path: "x.js", commit: "HEAD" }, id: "call_2" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "done" }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "done" }] },
        finishReason: "STOP",
      });

    mockReadFileViaBlob.mockResolvedValueOnce("file contents here");

    const result = await runInvestigation({ task: "check ref/commit equivalence dedup", max_steps: 5, provider });

    expect(result.transcript[0]).not.toMatch(/\[CACHED/);
    expect(result.transcript[1]).toMatch(/\[CACHED/);
    // readFileViaBlob only actually ran once -- the second, differently-
    // expressed call was served from the repeat cache instead of re-fetching.
    expect(mockReadFileViaBlob).toHaveBeenCalledTimes(1);
  });

  it("withholds tools on the final allowed step", async () => {
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ text: "final answer" }] },
      finishReason: "STOP",
    });

    await runInvestigation({ task: "one step only", max_steps: 1, provider });

    expect(mockProviderChat).toHaveBeenCalledTimes(1);
    const [, opts] = mockProviderChat.mock.calls[0];
    expect(opts.tools).toBeUndefined();
  });

  it("skips the verification pass when it is itself the final allowed step", async () => {
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "final answer, no budget to verify" }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "one step only, no room to verify", max_steps: 1, provider });

    expect(result.answer).toBe("final answer, no budget to verify");
    expect(result.steps).toBe(1);
    // No budget left after the draft answer arrives (it IS the final
    // allowed step), so no second, verification-pass call is made.
    expect(mockProviderChat).toHaveBeenCalledTimes(1);
  });

  it("forces a text-only answer after 3 consecutive all-repeat steps (stuck-loop guard)", async () => {
    const repeatedCall = {
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_x" } }] },
      finishReason: "STOP",
    };
    mockProviderChat
      .mockResolvedValueOnce(repeatedCall) // step 1
      .mockResolvedValueOnce(repeatedCall) // step 2 (1st repeat)
      .mockResolvedValueOnce(repeatedCall) // step 3 (2nd repeat)
      .mockResolvedValueOnce(repeatedCall) // step 4 (3rd repeat -> next step forced text-only)
      .mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "giving up, here's what I found" }] }, finishReason: "STOP" }); // step 5

    const result = await runInvestigation({ task: "keep repeating", max_steps: 10, provider });

    expect(result.answer).toBe("giving up, here's what I found");
    // Step 5 (index 4) must have been called with tools withheld -- and,
    // because that turn was already a forced no-tools turn (the stuck-loop
    // guard), it also skips the verification pass, so no 6th call is made.
    const step5Opts = mockProviderChat.mock.calls[4][1];
    expect(step5Opts.tools).toBeUndefined();
    expect(mockProviderChat).toHaveBeenCalledTimes(5);
  });

  it("stops after the hard step cap without a final answer", async () => {
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_never_ends" } }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "never finishes", max_steps: 2, provider });

    expect(result.answer).toMatch(/reaching the step cap of 2/);
    expect(result.steps).toBe(2);
  });

  it("returns a resumable failure (with runId) when providerChat throws a transient error", async () => {
    const transientErr = new Error("API error (503): overloaded");
    transientErr.status = 503;
    mockProviderChat.mockRejectedValueOnce(transientErr);

    const result = await runInvestigation({ task: "will fail", max_steps: 5, provider });

    expect(result.failed).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(result.answer).toMatch(/call failed on step 1/);
  });

  it("throws a clear error when resume_run_id has no live checkpoint and no task is given", async () => {
    await expect(runInvestigation({ resume_run_id: "nonexistent-run-id", provider })).rejects.toThrow(/has no live checkpoint/);
  });

  it("falls through to a fresh run when resume_run_id's checkpoint is missing but a task is supplied", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "fresh run answer" }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "fresh run answer" }] },
        finishReason: "STOP",
      });

    const result = await runInvestigation({ task: "fallback task", resume_run_id: "nonexistent-run-id", max_steps: 5, provider });

    expect(result.answer).toBe("fresh run answer");
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
    // A fresh run gets its own new runId, not the (nonexistent) resume target.
    expect(result.runId).not.toBe("nonexistent-run-id");
  });
});
