import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before the agent module loads, or it starts its polling loop.
process.env.TERMUX_AGENT_NO_AUTOSTART = "1";
const agent = await import("../scripts/termux-agent.mjs");
const { isSafeCommand, parseSimpleCommand, needsApproval, notificationArgv, waitForDecision, askApproval, handle } = agent;

const tmp = () => mkdtempSync(join(tmpdir(), "termux-approval-"));

describe("isSafeCommand (smart mode allowlist)", () => {
  it.each([
    "ls -la",
    "pwd",
    "echo hello",
    "git status",
    "git log --oneline",
    "ls | grep foo",
    "echo hi && ls",
    "echo hi || ls",
    "echo 'a;b'",
    "ls 2>&1",
    "ls > /dev/null",
    "ps aux",
    "tmux ls",
    "grep foo file.txt",
    "ls *.txt",
  ])("auto-runs %s", (cmd) => {
    expect(isSafeCommand(cmd)).toBe(true);
  });

  it.each([
    ["delete files", "rm -rf x"],
    ["chain into a non-safe command", "ls; rm x"],
    ["unknown program", "curl http://x"],
    ["git push", "git push"],
    ["git output flag", "git log --output=x"],
    ["command substitution", "echo $(whoami)"],
    ["backticks", "echo `whoami`"],
    ["variable", "echo $HOME"],
    ["redirect to a file", "ls > out.txt"],
    ["background job", "sleep 1 &"],
    ["newline", "ls\nrm x"],
    ["unbalanced quote", "echo 'hi"],
    ["env prefix", "FOO=1 ls"],
    ["path to program", "/bin/ls"],
    ["secret path", "cat ~/.ssh/id_rsa"],
    ["git credentials", "cat .git-credentials"],
    ["hidden glob", "ls .*"],
    ["glob on a reader", "cat *.txt"],
    ["ps shows env", "ps auxe"],
    ["ps environ", "ps -o environ"],
    ["recursive grep", "grep -r foo ."],
    ["tmux kill", "tmux kill-server"],
    ["empty command", ""],
  ])("asks for approval: %s", (_name, cmd) => {
    expect(isSafeCommand(cmd)).toBe(false);
  });

  it("parseSimpleCommand splits segments", () => {
    const segs = parseSimpleCommand("ls -la | grep x; pwd");
    expect(segs.map((s) => s.map((t) => t.text))).toEqual([["ls", "-la"], ["grep", "x"], ["pwd"]]);
  });
});

describe("needsApproval", () => {
  const safe = { kind: "exec", command: "ls" };
  const risky = { kind: "exec", command: "rm x" };

  it("smart: only non-read-only exec and private api actions", () => {
    expect(needsApproval(safe, "smart")).toBe(false);
    expect(needsApproval(risky, "smart")).toBe(true);
    expect(needsApproval({ kind: "api", action: "battery" }, "smart")).toBe(false);
    expect(needsApproval({ kind: "api", action: "location" }, "smart")).toBe(true);
    expect(needsApproval({ kind: "api", action: "clipboard_get" }, "smart")).toBe(true);
  });

  it("all: everything asks", () => {
    expect(needsApproval(safe, "all")).toBe(true);
    expect(needsApproval({ kind: "api", action: "battery" }, "all")).toBe(true);
  });

  it("off: nothing asks", () => {
    expect(needsApproval(risky, "off")).toBe(false);
    expect(needsApproval({ kind: "api", action: "location" }, "off")).toBe(false);
  });
});

describe("notificationArgv", () => {
  it("wires Approve, Deny and swipe-away to marker files", () => {
    const argv = notificationArgv({ id: "abc123", kind: "exec", command: "rm x" }, "/d");
    expect(argv[0]).toBe("termux-notification");
    expect(argv).toContain("madmcp-abc123");
    expect(argv).toContain("rm x");
    expect(argv[argv.indexOf("--button1-action") + 1]).toBe("touch '/d/abc123.ok'");
    expect(argv[argv.indexOf("--button2-action") + 1]).toBe("touch '/d/abc123.no'");
    expect(argv[argv.indexOf("--on-delete") + 1]).toBe("touch '/d/abc123.no'");
  });
});

describe("waitForDecision", () => {
  it("approved when the .ok marker appears", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "j.ok"), "");
    expect(await waitForDecision("j", { dir, timeoutMs: 1000, pollMs: 10 })).toBe("approved");
  });

  it("denied when the .no marker appears", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "j.no"), "");
    expect(await waitForDecision("j", { dir, timeoutMs: 1000, pollMs: 10 })).toBe("denied");
  });

  it("deny wins if both exist", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "j.ok"), "");
    writeFileSync(join(dir, "j.no"), "");
    expect(await waitForDecision("j", { dir, timeoutMs: 1000, pollMs: 10 })).toBe("denied");
  });

  it("times out with no answer", async () => {
    expect(await waitForDecision("j", { dir: tmp(), timeoutMs: 50, pollMs: 10 })).toBe("timeout");
  });
});

describe("askApproval (fails closed)", () => {
  const job = { id: "job1", kind: "exec", command: "rm x" };

  it("approves only on an explicit approval", async () => {
    const notify = vi.fn().mockResolvedValue({ exitCode: 0 });
    const wait = vi.fn().mockResolvedValue("approved");
    expect(await askApproval(job, { dir: tmp(), notify, wait })).toEqual({ decision: "approved" });
  });

  it("denies when denied on the phone", async () => {
    const out = await askApproval(job, {
      dir: tmp(),
      notify: async () => ({ exitCode: 0 }),
      wait: async () => "denied",
    });
    expect(out.decision).toBe("denied");
    expect(out.reason).toMatch(/denied on the phone/);
  });

  it("denies on timeout", async () => {
    const out = await askApproval(job, {
      dir: tmp(),
      timeoutMs: 1000,
      notify: async () => ({ exitCode: 0 }),
      wait: async () => "timeout",
    });
    expect(out.decision).toBe("denied");
    expect(out.reason).toMatch(/no answer/);
  });

  it("denies and never waits if the notification can't be shown", async () => {
    const wait = vi.fn();
    const out = await askApproval(job, { dir: tmp(), notify: async () => ({ exitCode: 1 }), wait });
    expect(out.decision).toBe("denied");
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects a job id that could escape the marker directory", async () => {
    const notify = vi.fn();
    const out = await askApproval({ ...job, id: "../evil" }, { dir: tmp(), notify, wait: vi.fn() });
    expect(out.decision).toBe("denied");
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses commands too long to review on a notification", async () => {
    const notify = vi.fn();
    const out = await askApproval({ ...job, command: "x".repeat(801) }, { dir: tmp(), notify, wait: vi.fn() });
    expect(out.decision).toBe("denied");
    expect(out.reason).toMatch(/too long/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("cleans up marker files", async () => {
    const dir = tmp();
    await askApproval(job, {
      dir,
      // First call shows the notification (the tap creates the marker); the
      // second call is the notification-remove and must not recreate it.
      notify: async (argv) => {
        if (argv[0] === "termux-notification") writeFileSync(join(dir, "job1.ok"), "");
        return { exitCode: 0 };
      },
      wait: async () => "approved",
    });
    expect(existsSync(join(dir, "job1.ok"))).toBe(false);
  });
});

describe("handle", () => {
  it("does not run a denied command", async () => {
    const approve = vi.fn().mockResolvedValue({ decision: "denied", reason: "denied on the phone" });
    const result = await handle({ id: "j1", kind: "exec", command: "echo SHOULD_NOT_RUN" }, { approve, mode: "all" });
    expect(approve).toHaveBeenCalledOnce();
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.error).toBe("Not run: denied on the phone");
  });

  it("does not run when the approval step throws", async () => {
    const approve = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await handle({ id: "j2", kind: "exec", command: "rm x" }, { approve, mode: "smart" });
    expect(result.error).toMatch(/approval failed: boom/);
  });

  it("runs a read-only command without asking", async () => {
    const approve = vi.fn();
    const result = await handle({ id: "j3", kind: "exec", command: "echo hi" }, { approve, mode: "smart" });
    expect(approve).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("runs a risky command once approved", async () => {
    const approve = vi.fn().mockResolvedValue({ decision: "approved" });
    const result = await handle({ id: "j4", kind: "exec", command: "echo hi; true" }, { approve, mode: "smart" });
    expect(approve).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("skips the gate entirely in off mode", async () => {
    const approve = vi.fn();
    const result = await handle({ id: "j5", kind: "exec", command: "echo hi; true" }, { approve, mode: "off" });
    expect(approve).not.toHaveBeenCalled();
    expect(result.stdout).toBe("hi\n");
  });

  it("reports an unknown api action without running anything", async () => {
    const result = await handle({ id: "j6", kind: "api", action: "nope" }, { mode: "off" });
    expect(result.error).toMatch(/unknown action/);
  });
});
