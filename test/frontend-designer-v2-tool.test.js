// ---------------------------------------------------------------------------
// test/frontend-designer-v2-tool.test.js
//
// Coverage for delegate_designer_v2's registration in
// connectors/frontend/tools.js (issue #61, rollout step 5): the tool must
// be registered ONLY when FRONTEND_DESIGNER_V2_ENABLED="true" (config.js),
// alongside -- never instead of -- v1's existing delegate_designer, and its
// handler must wrap runDesignAgent (agent.js) the same way delegate_agent
// wraps runInvestigation in connectors/gemini/tools.js (validation,
// resume_run_id/max_steps/show_transcript conventions, error shaping).
//
// FRONTEND_DESIGNER_V2_ENABLED is read once at config.js module-load time,
// so each test that needs a specific flag value sets process.env BEFORE
// calling vi.resetModules() + a dynamic import of tools.js -- a plain
// top-of-file import can't be toggled per test the way the other
// frontend-*.test.js files' static imports can.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("../connectors/frontend/agent.js", () => ({ runDesignAgent: vi.fn() }));
vi.mock("../connectors/frontend/client.js", () => ({ frontendGenerate: vi.fn(), currentProvider: () => "test-provider" }));
vi.mock("../connectors/frontend/validate.js", () => ({ validateByExtension: vi.fn() }));
vi.mock("../connectors/frontend/checkpoint.js", () => ({
  saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), deleteCheckpoint: vi.fn(),
}));
vi.mock("../connectors/gemini/cooldown.js", () => ({ isRedisConfigured: vi.fn(() => true) }));
vi.mock("../connectors/github/client.js", () => ({ githubRequest: vi.fn(), toBase64: vi.fn() }));
vi.mock("../connectors/github/helpers.js", () => ({ readFileViaBlob: vi.fn() }));

const ORIGINAL_FLAG = process.env.FRONTEND_DESIGNER_V2_ENABLED;

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.FRONTEND_DESIGNER_V2_ENABLED;
  else process.env.FRONTEND_DESIGNER_V2_ENABLED = ORIGINAL_FLAG;
});

function fakeServer() {
  const tools = new Map();
  return {
    tool: (name, description, schema, handler) => tools.set(name, { description, schema, handler }),
    tools,
  };
}

// vi.resetModules() clears the module registry so config.js (and
// tools.js/agent.js, which import from it) get re-evaluated against
// whatever process.env.FRONTEND_DESIGNER_V2_ENABLED is set to at the time
// of THIS call -- vi.mock registrations above survive the reset (Vitest
// tracks those independently of the module cache), so the mocked
// dependencies (runDesignAgent etc.) still apply to the freshly reloaded
// tools.js.
async function loadToolsWithFlag(enabled) {
  process.env.FRONTEND_DESIGNER_V2_ENABLED = enabled ? "true" : "false";
  vi.resetModules();
  return import("../connectors/frontend/tools.js");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("delegate_designer_v2 registration (feature flag, issue #61 step 5)", () => {
  it("is NOT registered when the flag is unset/false -- dark launch off by default", async () => {
    const { register } = await loadToolsWithFlag(false);
    const server = fakeServer();
    register(server);

    expect(server.tools.has("delegate_designer_v2")).toBe(false);
    // v1 must be completely unaffected by the flag being off.
    expect(server.tools.has("delegate_designer")).toBe(true);
  });

  it("IS registered when the flag is enabled, ADDITIVELY alongside v1 (not replacing it)", async () => {
    const { register } = await loadToolsWithFlag(true);
    const server = fakeServer();
    register(server);

    expect(server.tools.has("delegate_designer_v2")).toBe(true);
    expect(server.tools.has("delegate_designer")).toBe(true);
  });
});

describe("delegate_designer_v2 handler (flag enabled)", () => {
  it("rejects a fresh call with neither task nor resume_run_id, without calling runDesignAgent", async () => {
    const { register } = await loadToolsWithFlag(true);
    const { runDesignAgent } = await import("../connectors/frontend/agent.js");
    const server = fakeServer();
    register(server);

    const result = await server.tools.get("delegate_designer_v2").handler({ repo: "madmcp", branch: "feature" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/task must be provided/i);
    expect(runDesignAgent).not.toHaveBeenCalled();
  });

  it("rejects a non-positive-integer max_steps before calling runDesignAgent", async () => {
    const { register } = await loadToolsWithFlag(true);
    const { runDesignAgent } = await import("../connectors/frontend/agent.js");
    const server = fakeServer();
    register(server);

    const result = await server.tools.get("delegate_designer_v2").handler({ repo: "madmcp", branch: "feature", task: "x", max_steps: 0 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid max_steps/i);
    expect(runDesignAgent).not.toHaveBeenCalled();
  });

  it("on success, reports written files and omits the transcript unless requested", async () => {
    const { register } = await loadToolsWithFlag(true);
    const { runDesignAgent } = await import("../connectors/frontend/agent.js");
    runDesignAgent.mockResolvedValueOnce({
      answer: "Updated the hero section.", steps: 3, writtenFiles: ["index.html"],
      transcript: ["[step 1] read_file(...) -> ..."], runId: "run-1",
    });
    const server = fakeServer();
    register(server);

    const result = await server.tools.get("delegate_designer_v2").handler({ owner: "allocsys", repo: "madmcp", branch: "feature", task: "Update the hero" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Updated the hero section\./);
    expect(result.content[0].text).toMatch(/Files written: index\.html/);
    expect(result.content[0].text).not.toMatch(/read_file/); // transcript withheld on success without show_transcript
  });

  it("on failure, includes the transcript and marks isError, and surfaces a thrown error as a tool error rather than throwing", async () => {
    const { register } = await loadToolsWithFlag(true);
    const { runDesignAgent } = await import("../connectors/frontend/agent.js");
    const server = fakeServer();
    register(server);

    runDesignAgent.mockResolvedValueOnce({
      answer: "(Gemini call failed on step 2: rate limited)", steps: 1, writtenFiles: [],
      transcript: ["[step 1] read_file(...) -> ..."], runId: "run-2", failed: true,
    });
    const failedResult = await server.tools.get("delegate_designer_v2").handler({ owner: "allocsys", repo: "madmcp", branch: "feature", task: "x" });
    expect(failedResult.isError).toBe(true);
    expect(failedResult.content[0].text).toMatch(/read_file/); // transcript shown on failure even without show_transcript

    runDesignAgent.mockRejectedValueOnce(new Error("boom"));
    const thrownResult = await server.tools.get("delegate_designer_v2").handler({ owner: "allocsys", repo: "madmcp", branch: "feature", task: "x" });
    expect(thrownResult.isError).toBe(true);
    expect(thrownResult.content[0].text).toMatch(/delegate_designer_v2 failed: boom/);
  });
});
