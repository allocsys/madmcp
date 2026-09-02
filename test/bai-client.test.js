import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  BAI_API_KEYS: ["key-a", "key-b"],
  BAI_API: "https://api.b.ai/v1/chat/completions",
  BAI_MODEL: "glm-5.3-flash",
  BAI_REQUEST_TIMEOUT_MS: 55000,
}));

vi.mock("../config.js", () => mockConfig);

const mockIsModelCoolingDown = vi.fn();
const mockSetModelCooldown = vi.fn();
const mockParseRetryDelaySeconds = vi.fn((message) => {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
});
vi.mock("../connectors/shared/cooldown.js", () => ({
  isModelCoolingDown: mockIsModelCoolingDown,
  setModelCooldown: mockSetModelCooldown,
  parseRetryDelaySeconds: mockParseRetryDelaySeconds,
}));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("B.AI Connector - Client and key rotation logic (client.js)", () => {
  let clientModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.BAI_API_KEYS = ["key-a", "key-b"];
    mockConfig.BAI_MODEL = "glm-5.3-flash";
    mockIsModelCoolingDown.mockResolvedValue(false);
    process.env = { ...originalEnv };
    clientModule = await import("../connectors/bai/client.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("throws if BAI_API_KEYS is empty", async () => {
    mockConfig.BAI_API_KEYS = [];
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("BAI_API_KEYS is not set");
  });

  it("succeeds on the first key and returns the raw OpenAI choice", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello from B.AI!" }, finish_reason: "stop" }],
      }),
    });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("Hello from B.AI!");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.b.ai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer key-a");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("glm-5.3-flash");
  });

  it("omits tools from the request body entirely when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("sends max_tokens when maxOutputTokens is provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }], { maxOutputTokens: 4096 });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  it("throws immediately on a non-retryable status (400)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "Invalid request" } }),
    });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI API error (400): Invalid request");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a network/abort failure to a transient error", async () => {
    global.fetch = vi.fn().mockRejectedValue({ name: "AbortError", message: "aborted" });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI request timed out after 55000ms");
  });

  it("rotates to the next key on 429 and records cooldown, with NO second model attempted (key-rotation-only cascade)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    // Exactly 2 attempts (key-a 429 -> key-b success). No model fallback cascade was attempted.
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(firstBody.model).toBe("glm-5.3-flash");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");

    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("glm-5.3-flash");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");

    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", 5, "bai:0");
  });

  it("rotates to the next key on 401/403", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Unauthorized" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");
  });

  it("skips a key recorded as cooling down", async () => {
    mockIsModelCoolingDown.mockImplementation(async (model, namespace) => model === "glm-5.3-flash" && namespace === "bai:0");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won via cooldown skip" }, finish_reason: "stop" }] }),
    });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won via cooldown skip");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-b");
  });

  it("throws the last error once all keys are exhausted", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI API error (503)");
    // 2 passes x 2 keys = 4 attempts (both keys keep failing transiently, so a second pass is attempted).
    expect(global.fetch).toHaveBeenCalledTimes(4);
    // Regression coverage for commit 27449d5: a 503 must record a cooldown
    // for BOTH keys, same as a 429 would -- previously this test exercised
    // the 503 path without ever checking cooldown behavior, which is how
    // the original gap (503s never cooling down) went uncaught.
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:1");
  });

  it("rotates to the next key on 503 and records a cooldown (fallback default duration, no Retry-After hint available)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // undefined seconds -- setModelCooldown() itself falls back to
    // DEFAULT_COOLDOWN_SECONDS since a 503 has no Retry-After-style hint to parse.
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
    expect(mockSetModelCooldown).not.toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:1");
  });

  it("rotates to the next key on a network/timeout failure and records a cooldown", async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce({ name: "AbortError", message: "aborted" })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
  });

  it("tags the all-keys-exhausted error as .transient when every key failed with a transient status (429)", async () => {
    // Reproduces the plan.md-diagnosed scenario: all configured BAI_API_KEYS
    // rate-limited simultaneously. isTransientGeminiError() in
    // agent_delegate.js reads err.transient to decide whether a resume is
    // worth suggesting -- this must be true here, not just the message text.
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("all 2 configured keys");
    expect(caught.transient).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("tags the all-keys-exhausted error as .transient when every key failed with a mix of transient statuses (429, 503)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.transient).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("does NOT tag the all-keys-exhausted error as .transient when at least one key failed for a permanent reason (401)", async () => {
    // A mixed failure (one key genuinely rate-limited, another simply bad/
    // revoked) should not be advertised as "just retry me" -- the bad key
    // will fail identically on a resume regardless of the rate limit clearing.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Unauthorized" } }) })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.transient).not.toBe(true);
  });

  it("tags the all-keys-exhausted error as .transient when every key is a recorded cooldown skip", async () => {
    mockIsModelCoolingDown.mockResolvedValue(true);
    global.fetch = vi.fn();
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("recorded cooldown");
    expect(caught.transient).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws if B.AI returns no choices", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({}) });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI returned no choices.");
  });

  it("sends reasoning_effort when provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }], { reasoningEffort: "low" });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe("low");
  });

  it("omits reasoning_effort from the request body entirely when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  describe("diagnostic logging and token usage extraction", () => {
    it("logs key attempt index, start timestamp, outcome, duration, and response usage unconditionally", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 25, reasoning_tokens: 5, total_tokens: 40 },
        }),
      });

      await clientModule.baiChat([{ role: "user", content: "hi" }]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: attempting key #0 \(startedAt=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: key #0 attempt succeeded \(status=200, durationMs=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith("bai: response finish_reason=stop reasoning_tokens=5 completion_tokens=25 total_tokens=40");
      consoleLogSpy.mockRestore();
    });

    it("logs failure reason and elapsed duration on fetch error", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      global.fetch = vi.fn().mockRejectedValue({ name: "AbortError", message: "aborted" });

      await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: attempting key #0 \(startedAt=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: key #0 attempt failed \(reason=timeout, durationMs=\d+\)$/));
      consoleLogSpy.mockRestore();
    });

    it("logs HTTP error status and elapsed duration on non-200 response", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: { message: "rate limited" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "ok from key-b" }, finish_reason: "stop" }],
            usage: { completion_tokens: 15, total_tokens: 20 },
          }),
        });

      await clientModule.baiChat([{ role: "user", content: "hi" }]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: attempting key #0 \(startedAt=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: key #0 attempt failed \(status=429, durationMs=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: attempting key #1 \(startedAt=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^bai: key #1 attempt succeeded \(status=200, durationMs=\d+\)$/));
      expect(consoleLogSpy).toHaveBeenCalledWith("bai: response finish_reason=stop reasoning_tokens=none completion_tokens=15 total_tokens=20");
      consoleLogSpy.mockRestore();
    });

    it("extractUsageDetails supports both top-level and nested reasoning_tokens shapes", () => {
      expect(clientModule.extractUsageDetails(undefined)).toEqual({
        reasoningTokens: undefined,
        completionTokens: undefined,
        totalTokens: undefined,
      });

      expect(clientModule.extractUsageDetails({
        reasoning_tokens: 10,
        completion_tokens: 50,
        total_tokens: 60,
      })).toEqual({
        reasoningTokens: 10,
        completionTokens: 50,
        totalTokens: 60,
      });

      expect(clientModule.extractUsageDetails({
        completion_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 30 },
        total_tokens: 70,
      })).toEqual({
        reasoningTokens: 30,
        completionTokens: 40,
        totalTokens: 70,
      });
    });
  });

  describe("isReasoningBudgetExhausted (plan.md Section 25 detection logic)", () => {
    it("returns true when finish_reason is 'length' and reasoning_tokens is >=90% of completion_tokens (top-level usage shape)", () => {
      const choice = { finish_reason: "length" };
      const usage = { completion_tokens: 1200, reasoning_tokens: 1150 };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(true);
    });

    it("returns true using the nested completion_tokens_details.reasoning_tokens shape", () => {
      const choice = { finish_reason: "length" };
      const usage = { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1200 } };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(true);
    });

    it("returns false when finish_reason is not 'length'", () => {
      const choice = { finish_reason: "stop" };
      const usage = { completion_tokens: 1200, reasoning_tokens: 1150 };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(false);
    });

    it("returns false when reasoning_tokens is a minority of completion_tokens (a real, mostly-complete answer that ran over budget)", () => {
      const choice = { finish_reason: "length" };
      const usage = { completion_tokens: 1200, reasoning_tokens: 100 };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(false);
    });

    it("returns false when usage is missing entirely", () => {
      const choice = { finish_reason: "length" };
      expect(clientModule.isReasoningBudgetExhausted(choice, undefined)).toBe(false);
    });

    it("returns false when reasoning_tokens is absent from usage in both shapes", () => {
      const choice = { finish_reason: "length" };
      const usage = { completion_tokens: 1200 };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(false);
    });

    it("returns false when completion_tokens is 0", () => {
      const choice = { finish_reason: "length" };
      const usage = { completion_tokens: 0, reasoning_tokens: 0 };
      expect(clientModule.isReasoningBudgetExhausted(choice, usage)).toBe(false);
    });
  });

  describe("baiChat retry-once-on-reasoning-token-exhaustion (plan.md Section 25 fix)", () => {
    it("retries once with a larger max_tokens on a detected exhaustion, keeping the same reasoning_effort", async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 1200, reasoning_tokens: 1180 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "Final answer after retry." }, finish_reason: "stop" }],
            usage: { completion_tokens: 300, reasoning_tokens: 20 },
          }),
        });

      const choice = await clientModule.baiChat([{ role: "user", content: "hi" }], { maxOutputTokens: 3000, reasoningEffort: "low" });

      expect(choice.message.content).toBe("Final answer after retry.");
      expect(global.fetch).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(firstBody.max_tokens).toBe(3000);
      expect(firstBody.reasoning_effort).toBe("low");

      const retryBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      // Doubled from 3000 (6000, which exceeds the 4096 floor, so the
      // doubling itself is what's under test here), and reasoning_effort is
      // reused unchanged -- never raised, per the fix's own constraint.
      expect(retryBody.max_tokens).toBe(6000);
      expect(retryBody.reasoning_effort).toBe("low");
    });

    it("uses the RETRY_MIN_MAX_TOKENS floor (4096) when the original call had no maxOutputTokens set", async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 500, reasoning_tokens: 500 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "ok now" }, finish_reason: "stop" }],
            usage: { completion_tokens: 50, reasoning_tokens: 5 },
          }),
        });

      const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
      expect(choice.message.content).toBe("ok now");
      const retryBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(retryBody.max_tokens).toBe(4096);
    });

    it("does NOT retry when the first response is a normal success", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "normal answer" }, finish_reason: "stop" }],
          usage: { completion_tokens: 40, reasoning_tokens: 5 },
        }),
      });
      const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
      expect(choice.message.content).toBe("normal answer");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry a second time even if the retry ALSO exhausts its budget (retry is bounded to exactly one attempt)", async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 1200, reasoning_tokens: 1180 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 4096, reasoning_tokens: 4000 },
          }),
        });

      const choice = await clientModule.baiChat([{ role: "user", content: "hi" }], { maxOutputTokens: 1200 });
      // Whatever the retry returned is accepted as final -- no third call.
      expect(choice.message.content).toBe("");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("throws a clear error if the retry itself returns no choices", async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 1200, reasoning_tokens: 1180 },
          }),
        })
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({}) });

      await expect(clientModule.baiChat([{ role: "user", content: "hi" }], { maxOutputTokens: 1200 }))
        .rejects.toThrow("B.AI returned no choices on retry");
    });
  });
});
