// ---------------------------------------------------------------------------
// test/github-codespaces-exec.test.js
//
// Unit tests for the exec_in_codespace tool in connectors/github/codespaces.js.
// Mocks node:child_process (exec) and connectors/github/client.js (githubRequest)
// to verify:
//   1. Successful command execution when codespace is already Available.
//   2. Non-zero exit code handling and structured result.
//   3. Timeout handling (command killed / exit code 124).
//   4. Auto-start-when-stopped behavior (polls until Available, then runs).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { exec } from "node:child_process";
import { githubRequest } from "../connectors/github/client.js";
import { register } from "../connectors/github/codespaces.js";

// Minimal fake MCP server
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("connectors/github/codespaces.js — exec_in_codespace", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    register(server);
  });

  it("executes command successfully when codespace is already Available", async () => {
    // 1. Initial get codespace check
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    // 2. exec resolves with stdout
    exec.mockImplementation((cmd, opts, callback) => {
      // promisify(exec) expects a callback (err, { stdout, stderr }) or similar,
      // but child_process.exec callback receives (error, stdout, stderr).
      // node:util.promisify maps (err, stdout, stderr) to a fulfilled promise with { stdout, stderr }
      // or a rejected error object with properties { stdout, stderr, code, killed }.
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "hello from codespace\n", "");
    });

    const result = await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "echo hello",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Exit code: 0");
    expect(result.content[0].text).toContain("Stdout:\nhello from codespace");
    expect(githubRequest).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toContain("gh codespace ssh -c \"cs-test\"");
  });

  it("handles non-zero exit codes correctly", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      const err = new Error("Command failed");
      err.code = 1;
      err.stdout = "";
      err.stderr = "command not found\n";
      cb(err, "", "command not found\n");
    });

    const result = await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "bad-cmd",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Exit code: 1");
    expect(result.content[0].text).toContain("Stderr:\ncommand not found");
  });

  it("handles timeout handling (killed = true)", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      const err = new Error("Command timed out");
      err.killed = true;
      err.code = null;
      err.stdout = "partial\n";
      err.stderr = "";
      cb(err, "partial\n", "");
    });

    const result = await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "sleep 999",
      timeout_seconds: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Exit code: 124");
    expect(result.content[0].text).toContain("[Command timed out after 5s]");
  });

  it("auto-starts a stopped codespace and polls until Available", async () => {
    // 1. Initial check: Shutdown
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Shutdown" });
    // 2. POST start call
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Starting" });
    // 3. First poll: still Starting
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Starting" });
    // 4. Second poll: Available!
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "started successfully\n", "");
    });

    const result = await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "pwd",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Exit code: 0");
    expect(result.content[0].text).toContain("Stdout:\nstarted successfully");

    // Verify start was called and polling happened
    expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/cs-test/start", { method: "POST" });
    expect(githubRequest).toHaveBeenCalledTimes(4); // initial get + start post + 2 polls
  });
});
