// ---------------------------------------------------------------------------
// test/github-codespaces-exec.test.js
//
// Unit tests for the exec_in_codespace tool in connectors/github/codespaces.js.
// Mocks node:child_process's execFile (with a [util.promisify.custom]
// implementation attached, matching Node's real child_process.execFile) and
// connectors/github/client.js (githubRequest) to verify:
//   1. Successful command execution when codespace is already Available.
//   2. Non-zero exit code handling and structured result.
//   3. Timeout handling (command killed / exit code 124).
//   4. Auto-start-when-stopped behavior (polls until Available, then runs).
//   5. cwd is passed through execFile's argv array (no local shell
//      re-parsing possible) and is POSIX single-quoted for the remote
//      `sh -c`, so $()/backtick/$VAR substitution in cwd cannot execute
//      either locally or remotely.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

// vi.mock() factories are hoisted above all other top-level code (including
// imports and const declarations). vi.hoisted() runs its callback at that
// same hoisted point, so anything created inside it is guaranteed to exist
// by the time the vi.mock() factory below needs it. `vi` itself is safe to
// reference here -- Vitest's transform hoists the `vi` binding specifically
// so this pattern works. (Do NOT reach for require("vitest") as a workaround
// for perceived hoisting issues -- Vitest ships ESM-only and rejects
// require() unconditionally, which crashes the entire suite, not just this
// file.)
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { execFile } from "node:child_process";
import { githubRequest } from "../connectors/github/client.js";
import { register } from "../connectors/github/codespaces.js";

// Attach [util.promisify.custom] so promisify(execFile) inside the code
// under test resolves/rejects exactly like Node's real
// child_process.execFile does ({ stdout, stderr } on success; an error
// carrying .stdout/.stderr on failure).
execFile[promisify.custom] = (file, args, options) => {
  return new Promise((resolve, reject) => {
    execFile._lastFile = file;
    execFile._lastArgs = args;
    execFile._lastOptions = options;
    execFile(file, args, options, (err, stdout, stderr) => {
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
    execFile._lastFile = undefined;
    execFile._lastArgs = undefined;
    execFile._lastOptions = undefined;
    server = makeFakeServer();
    register(server);
  });

  it("executes command successfully when codespace is already Available", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    execFile.mockImplementation((file, args, opts, callback) => {
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
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile._lastFile).toBe("gh");
    expect(execFile._lastArgs).toEqual([
      "codespace", "ssh", "-c", "cs-test", "--", "sh", "-c", "echo hello",
    ]);
  });

  it("handles non-zero exit codes correctly", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    execFile.mockImplementation((file, args, opts, callback) => {
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

    execFile.mockImplementation((file, args, opts, callback) => {
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

    execFile.mockImplementation((file, args, opts, callback) => {
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

  it("never invokes a local shell, so codespace_name/command reach gh as discrete argv entries", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    execFile.mockImplementation((file, args, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "ok\n", "");
    });

    await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "echo hi",
    });

    // execFile spawns `file` directly with an argv array -- there is no
    // shell string for a local shell to re-parse, so this call shape by
    // construction cannot let $()/backticks/`;` in any argument execute
    // on the host running the MCP server.
    expect(execFile._lastFile).toBe("gh");
    expect(Array.isArray(execFile._lastArgs)).toBe(true);
  });

  it("single-quotes cwd so $(...) command substitution cannot execute", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    execFile.mockImplementation((file, args, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "ok\n", "");
    });

    const maliciousCwd = "$(touch /tmp/pwned)";
    await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "ls",
      cwd: maliciousCwd,
    });

    const fullCommandArg = execFile._lastArgs[execFile._lastArgs.length - 1];
    // Single-quoted: the literal text is preserved verbatim inside '...',
    // so a shell will NOT expand it -- unlike double-quoting, where
    // $(...) is still evaluated.
    expect(fullCommandArg).toBe(`cd '${maliciousCwd}' && ls`);
  });

  it("single-quotes cwd containing backticks and embedded single quotes safely", async () => {
    githubRequest.mockResolvedValueOnce({ name: "cs-test", state: "Available" });

    execFile.mockImplementation((file, args, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      cb(null, "ok\n", "");
    });

    const maliciousCwd = "a'; touch /tmp/pwned; echo '`whoami`";
    await server.tools.exec_in_codespace({
      codespace_name: "cs-test",
      command: "ls",
      cwd: maliciousCwd,
    });

    const fullCommandArg = execFile._lastArgs[execFile._lastArgs.length - 1];
    // Embedded ' must be closed-out and re-opened (POSIX '\'' idiom),
    // never left as a bare unescaped quote that could terminate the
    // quoted string early.
    expect(fullCommandArg).toBe(
      `cd 'a'\\''; touch /tmp/pwned; echo '\\''`+ "`whoami`" + `' && ls`
    );
  });
});
