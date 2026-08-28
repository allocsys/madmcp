// ---------------------------------------------------------------------------
// test/editor-tools.test.js
//
// Coverage for connectors/github/editor_tools.js's register() (delegate_editor,
// plan.md step 7 + step 10's rollout gate). The one fact this test exists
// to pin down: register() must be a genuine no-op -- server.tool() never
// called at all -- when EDITOR_AGENT_ENABLED is false, and must register
// exactly one tool named "delegate_editor" when it's true. Everything else
// about the handler (arg validation, resume/transcript shaping) mirrors
// delegate_designer's already-tested wrapper shape closely enough that a
// full duplicate suite isn't the highest-value use of this step's time --
// the gate itself is the guardrail unique to this file.
//
// config.js's EDITOR_AGENT_ENABLED is derived once at module-eval time from
// process.env, so each block below uses vi.resetModules() + a fresh
// dynamic import after setting/deleting the env var, rather than trying to
// mutate an already-evaluated exported const.
//
// EDITOR_AGENT_ENABLED defaults ON as of 2026-08-28 (config.js:
// `!== "false"`, was `=== "true"`) -- unset or any value other than the
// literal string "false" means ON; only "false" means OFF. The gate tests
// below assert that semantics, not the old default-off behavior.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../connectors/github/editor_delegate.js", () => ({
  runEditorAgent: vi.fn(),
}));

const ORIGINAL_ENV = process.env.EDITOR_AGENT_ENABLED;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.EDITOR_AGENT_ENABLED;
  else process.env.EDITOR_AGENT_ENABLED = ORIGINAL_ENV;
  vi.resetModules();
});

function fakeServer() {
  return { tool: vi.fn() };
}

describe("register() -- EDITOR_AGENT_ENABLED gate", () => {
  it("registers the tool when the flag is unset (default on)", async () => {
    delete process.env.EDITOR_AGENT_ENABLED;
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");

    const server = fakeServer();
    register(server);

    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.tool.mock.calls[0][0]).toBe("delegate_editor");
  });

  it("registers no tool at all when the flag is the literal string \"false\"", async () => {
    process.env.EDITOR_AGENT_ENABLED = "false";
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");

    const server = fakeServer();
    register(server);

    expect(server.tool).not.toHaveBeenCalled();
  });

  it("registers the tool when the flag is any value other than the literal string \"false\" (e.g. a truthy-looking typo)", async () => {
    process.env.EDITOR_AGENT_ENABLED = "1";
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");

    const server = fakeServer();
    register(server);

    expect(server.tool).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one tool, named delegate_editor, when the flag is \"true\"", async () => {
    process.env.EDITOR_AGENT_ENABLED = "true";
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");

    const server = fakeServer();
    register(server);

    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.tool.mock.calls[0][0]).toBe("delegate_editor");
  });

  it("the registered tool's description explicitly states the non-default-branch and no-PR-merge scope limits", async () => {
    process.env.EDITOR_AGENT_ENABLED = "true";
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");

    const server = fakeServer();
    register(server);

    const description = server.tool.mock.calls[0][1];
    expect(description).toMatch(/MUST NOT be the repo's default branch/i);
    expect(description).toMatch(/CANNOT open, approve, or merge pull requests/i);
  });
});

describe("register() -- handler behavior when enabled", () => {
  async function registerAndGetHandler() {
    process.env.EDITOR_AGENT_ENABLED = "true";
    vi.resetModules();
    const { register } = await import("../connectors/github/editor_tools.js");
    const server = fakeServer();
    register(server);
    return server.tool.mock.calls[0][3];
  }

  it("rejects a call with neither task nor resume_run_id", async () => {
    const handler = await registerAndGetHandler();
    const result = await handler({ repo: "madmcp", branch: "feat/x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/task must be provided/i);
  });

  it("rejects a non-positive-integer max_steps before ever calling runEditorAgent", async () => {
    const { runEditorAgent } = await import("../connectors/github/editor_delegate.js");
    const handler = await registerAndGetHandler();
    const result = await handler({ repo: "madmcp", branch: "feat/x", task: "do it", max_steps: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid max_steps/i);
    expect(runEditorAgent).not.toHaveBeenCalled();
  });
});
