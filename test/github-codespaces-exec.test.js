// ---------------------------------------------------------------------------
// test/github-codespaces-exec.test.js
//
// Unit tests for the exec_in_codespace tool in connectors/github/codespaces.js.
// Mocks node:child_process (exec) with [util.promisify.custom] and connectors/github/client.js (githubRequest)
// to verify:
//   1. Successful command execution when codespace is already Available.
//   2. Non-zero exit code handling and structured result.
//   3. Timeout handling (command killed / exit code 124).
//   4. Auto-start-when-stopped behavior (polls until Available, then runs).
//   5. Quoting and escaping of cwd containing shell metacharacters (command injection protection).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

const mockExec = vi.fn();
// Attach [util.promisify.custom] to mockExec so promisify(exec) correctly uses it,
// exercising the exact same code path as Node's built-in child_process.exec.
mockExec[promisify.custom] = (cmd, options) => {
  return new Promise((resolve, reject) => {
    mockExec._lastCmd = cmd;
    mockExec._lastOptions = options;
    mockExec(cmd, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

vi.mock("node:child_process", () => ({
  exec: mockExec,
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
    mockExec._lastCmd = undefined;
    mockExec._lastOptions = undefined;
    server = makeFakeServer();
    register(server);
  });

  it("executes command successfully when codespace is already Available", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
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
    expect(mockExec._lastCmd).toContain("gh codespace ssh -c \"cs-test\"");
  });

  it("handles non-zero exit codes correctly", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      const err = new Error("Command failed");
      err.code = 1;
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
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Shutdown" });
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Starting" });
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Starting" });
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
    expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/cs-test/start", { method: "POST" });
    expect(githubRequest).toHaveBeenCalledTimes(4);
  });

  it("properly quotes and escapes cwd containing shell metacharacters to prevent command injection", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    exec.mockImplementation((cmd, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "ok\n", "");
    });

    const maliciousCwd = "x; rm -rf /";
    await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "ls",
      cwd: maliciousCwd,
    });

    expect(mockExec._lastCmd).toBeDefined();
    // Verify that the command string passed to exec includes JSON.stringify(cwd)
    // so the metacharacters are safely quoted/escaped rather than breaking out of cd.
    expect(mockExec._lastCmd).toContain(JSON.stringify(maliciousCwd));
  });
});
