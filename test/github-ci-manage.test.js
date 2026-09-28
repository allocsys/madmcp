import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register as registerCiManage } from "../connectors/github/ci_manage.js";
import { DEFAULT_OWNER } from "../config.js";

function makeFakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

const run = (over = {}) => ({
  run_number: 12, name: "CI", head_branch: "main", head_sha: "abcdef1234567",
  status: "completed", conclusion: "success", event: "push",
  created_at: "2026-08-01T10:00:00Z", html_url: "https://github.com/o/r/actions/runs/1",
  ...over,
});

describe("ci_manage", () => {
  let server;
  beforeEach(() => {
    vi.clearAllMocks();
    githubRequest.mockReset();
    server = makeFakeServer();
    registerCiManage(server);
  });
  afterEach(() => { vi.useRealTimers(); });
  const call = (args) => server.tools.ci_manage(args);

  it("registers a single ci_manage tool and none of the old names", () => {
    expect(Object.keys(server.tools)).toEqual(["ci_manage"]);
  });

  describe("validation", () => {
    it.each(["list", "run_logs", "job_logs", "trigger", "rerun", "cancel", "checks", "status"])(
      "requires repo for %s", async (action) => {
        const r = await call({ action, run_id: 1, job_id: 1, workflow_id: "ci.yml", ref: "main" });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain("requires repo");
        expect(githubRequest).not.toHaveBeenCalled();
      }
    );

    it.each(["run_logs", "rerun", "cancel"])("requires run_id for %s", async (action) => {
      const r = await call({ action, repo: "r" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires run_id");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("trigger requires workflow_id and ref", async () => {
      const a = await call({ action: "trigger", repo: "r", ref: "main" });
      expect(a.isError).toBe(true);
      expect(a.content[0].text).toContain("requires workflow_id");
      const b = await call({ action: "trigger", repo: "r", workflow_id: "ci.yml" });
      expect(b.isError).toBe(true);
      expect(b.content[0].text).toContain("requires ref");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["checks", "status"])("%s requires ref", async (action) => {
      const r = await call({ action, repo: "r" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires ref");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("job_logs without job_id or run_id still throws (original behavior)", async () => {
      await expect(call({ action: "job_logs", repo: "r" })).rejects.toThrow(/Provide either job_id, or run_id/);
      expect(githubRequest).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("hits the repo-wide runs endpoint with default per_page and owner", async () => {
      githubRequest.mockResolvedValueOnce({ workflow_runs: [run()] });
      const r = await call({ action: "list", repo: "r" });
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/actions/runs?per_page=20`);
      expect(r.content[0].text).toContain("✅ #12 — CI (main)");
      expect(r.content[0].text).toContain("Status: completed / success | Triggered: push | 2026-08-01");
    });

    it("uses the workflow endpoint and filters when given", async () => {
      githubRequest.mockResolvedValueOnce({ workflow_runs: [run({ status: "in_progress", conclusion: null })] });
      const r = await call({ action: "list", owner: "o", repo: "r", workflow_id: "ci.yml", branch: "dev", status: "in_progress", per_page: 5 });
      const url = githubRequest.mock.calls[0][0];
      expect(url).toContain("/repos/o/r/actions/workflows/ci.yml/runs?");
      expect(url).toContain("per_page=5");
      expect(url).toContain("branch=dev");
      expect(url).toContain("status=in_progress");
      expect(r.content[0].text).toContain("🔄");
    });

    it("reports when there are no runs", async () => {
      githubRequest.mockResolvedValueOnce({ workflow_runs: [] });
      const r = await call({ action: "list", repo: "r" });
      expect(r.content[0].text).toBe("No workflow runs found.");
    });
  });

  describe("run_logs", () => {
    it("summarizes the run and only non-successful steps", async () => {
      githubRequest
        .mockResolvedValueOnce(run({ conclusion: "failure" }))
        .mockResolvedValueOnce({
          jobs: [{
            name: "test", status: "completed", conclusion: "failure",
            steps: [
              { number: 1, name: "checkout", status: "completed", conclusion: "success" },
              { number: 2, name: "vitest", status: "completed", conclusion: "failure" },
            ],
          }],
        });
      const r = await call({ action: "run_logs", repo: "r", run_id: 99 });
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/actions/runs/99`);
      expect(githubRequest.mock.calls[1][0]).toBe(`/repos/${DEFAULT_OWNER}/r/actions/runs/99/jobs`);
      const text = r.content[0].text;
      expect(text).toContain("Run #12: CI");
      expect(text).toContain("Commit: abcdef1");
      expect(text).toContain("Jobs (1):");
      expect(text).toContain("Step 2: vitest [failure]");
      expect(text).not.toContain("checkout");
      expect(text).toContain("Full logs: https://github.com/o/r/actions/runs/1");
    });
  });

  describe("job_logs", () => {
    const jobs = { jobs: [
      { id: 1, name: "lint", conclusion: "success" },
      { id: 2, name: "Windows test", conclusion: "failure" },
    ] };

    it("uses job_id directly and skips the jobs lookup", async () => {
      githubRequest.mockResolvedValueOnce("ok line\nError: boom\nafter");
      const r = await call({ action: "job_logs", repo: "r", job_id: 5 });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/actions/jobs/5/logs`);
      expect(githubRequest.mock.calls[0][1]).toEqual({ accept: "application/vnd.github+json" });
      expect(r.content[0].text).toContain("Job ID: 5 | Total log lines: 3");
      expect(r.content[0].text).toContain("Matched 1 error block(s)");
      expect(r.content[0].text).toContain("Error: boom");
    });

    it("defaults to the first failed job in the run", async () => {
      githubRequest.mockResolvedValueOnce(jobs).mockResolvedValueOnce("x");
      await call({ action: "job_logs", repo: "r", run_id: 10 });
      expect(githubRequest.mock.calls[1][0]).toContain("/actions/jobs/2/logs");
    });

    it("matches job_name case-insensitively by substring", async () => {
      githubRequest.mockResolvedValueOnce(jobs).mockResolvedValueOnce("x");
      await call({ action: "job_logs", repo: "r", run_id: 10, job_name: "LINT" });
      expect(githubRequest.mock.calls[1][0]).toContain("/actions/jobs/1/logs");
    });

    it("throws listing available jobs when nothing matches", async () => {
      githubRequest.mockResolvedValueOnce(jobs);
      await expect(call({ action: "job_logs", repo: "r", run_id: 10, job_name: "nope" }))
        .rejects.toThrow(/No matching job found in run 10 for job_name "nope"\. Available jobs: lint, Windows test/);
    });

    it("throws when the run has no failed job and no job_name given", async () => {
      githubRequest.mockResolvedValueOnce({ jobs: [{ id: 1, name: "lint", conclusion: "success" }] });
      await expect(call({ action: "job_logs", repo: "r", run_id: 10 }))
        .rejects.toThrow(/with a failure conclusion/);
    });

    it("falls back to the last 150 lines when nothing matches", async () => {
      const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
      githubRequest.mockResolvedValueOnce(log);
      const r = await call({ action: "job_logs", repo: "r", job_id: 5 });
      expect(r.content[0].text).toContain("No lines matched");
      expect(r.content[0].text).toContain("line 199");
      expect(r.content[0].text).toContain("line 50");
      expect(r.content[0].text).not.toContain("line 49\n");
    });

    it("honors custom grep and max_matches", async () => {
      githubRequest.mockResolvedValueOnce("a\nfoo 1\nb\nc\nd\ne\nf\nfoo 2\ng");
      const r = await call({ action: "job_logs", repo: "r", job_id: 5, grep: "FOO", max_matches: 1 });
      expect(r.content[0].text).toContain("Matched 1 error block(s) for /FOO/");
      expect(r.content[0].text).toContain("foo 1");
      expect(r.content[0].text).not.toContain("foo 2");
    });
  });

  describe("trigger", () => {
    it("dispatches then returns the run URL when GitHub lists it", async () => {
      githubRequest
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ workflow_runs: [run({ run_number: 7, html_url: "https://x/7" })] });
      const r = await call({ action: "trigger", repo: "r", workflow_id: "ci.yml", ref: "feat/x", inputs: { a: "1" } });
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/actions/workflows/ci.yml/dispatches`);
      expect(githubRequest.mock.calls[0][1]).toEqual({ method: "POST", body: { ref: "feat/x", inputs: { a: "1" } } });
      expect(githubRequest.mock.calls[1][0]).toContain("event=workflow_dispatch&branch=feat%2Fx&per_page=1");
      expect(r.content[0].text).toBe("Triggered workflow 'ci.yml' on feat/x. Run #7: https://x/7");
    });

    it("retries the runs lookup up to 4 times, then reports the run isn't listed", async () => {
      vi.useFakeTimers();
      githubRequest.mockResolvedValue({ workflow_runs: [] });
      githubRequest.mockResolvedValueOnce(undefined);
      const p = call({ action: "trigger", repo: "r", workflow_id: "ci.yml", ref: "main" });
      await vi.advanceTimersByTimeAsync(1500 * 4);
      const r = await p;
      // 1 dispatch + 4 polls
      expect(githubRequest).toHaveBeenCalledTimes(5);
      expect(r.content[0].text).toContain("hasn't listed the new run yet");
      expect(r.content[0].text).toContain("ci_manage 'list'");
    });
  });

  describe("rerun / cancel", () => {
    it("reruns the whole run by default", async () => {
      githubRequest.mockResolvedValueOnce(undefined);
      const r = await call({ action: "rerun", repo: "r", run_id: 3 });
      expect(githubRequest).toHaveBeenCalledWith(`/repos/${DEFAULT_OWNER}/r/actions/runs/3/rerun`, { method: "POST" });
      expect(r.content[0].text).toContain("Requested rerun of run 3.");
    });

    it("reruns only failed jobs when asked", async () => {
      githubRequest.mockResolvedValueOnce(undefined);
      const r = await call({ action: "rerun", repo: "r", run_id: 3, failed_jobs_only: true });
      expect(githubRequest).toHaveBeenCalledWith(`/repos/${DEFAULT_OWNER}/r/actions/runs/3/rerun-failed-jobs`, { method: "POST" });
      expect(r.content[0].text).toContain("Requested rerun of failed jobs in run 3.");
    });

    it("cancels a run", async () => {
      githubRequest.mockResolvedValueOnce(undefined);
      const r = await call({ action: "cancel", owner: "o", repo: "r", run_id: 4 });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/actions/runs/4/cancel", { method: "POST" });
      expect(r.content[0].text).toBe("Cancellation requested for run 4.");
    });
  });

  describe("checks", () => {
    it("lists check runs with default per_page and encoded ref", async () => {
      githubRequest.mockResolvedValueOnce({
        total_count: 2,
        check_runs: [
          { name: "verify", status: "completed", conclusion: "success", html_url: "https://c/1" },
          { name: "lint", status: "in_progress", conclusion: null, html_url: "https://c/2" },
        ],
      });
      const r = await call({ action: "checks", repo: "r", ref: "feat/x" });
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/commits/feat%2Fx/check-runs?per_page=30`);
      expect(r.content[0].text).toContain("2 check run(s) for feat/x:");
      expect(r.content[0].text).toContain("✅ verify — completed/success");
      expect(r.content[0].text).toContain("🔄 lint — in_progress");
    });

    it("reports when there are no check runs", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 0, check_runs: [] });
      const r = await call({ action: "checks", repo: "r", ref: "abc" });
      expect(r.content[0].text).toBe("No check runs found for abc.");
    });
  });

  describe("status", () => {
    it("renders the combined status and each context", async () => {
      githubRequest.mockResolvedValueOnce({
        state: "pending", total_count: 2,
        statuses: [
          { state: "success", context: "ci/a", description: "ok" },
          { state: "error", context: "ci/b", description: null },
        ],
      });
      const r = await call({ action: "status", repo: "r", ref: "main" });
      expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${DEFAULT_OWNER}/r/commits/main/status`);
      expect(r.content[0].text).toContain("Overall state: ⏳ pending (2 status(es))");
      expect(r.content[0].text).toContain("✅ ci/a — success (ok)");
      expect(r.content[0].text).toContain("❌ ci/b — error");
    });

    it("handles no individual statuses", async () => {
      githubRequest.mockResolvedValueOnce({ state: "success", total_count: 0, statuses: [] });
      const r = await call({ action: "status", repo: "r", ref: "main" });
      expect(r.content[0].text).toContain("(no individual statuses reported)");
    });
  });
});
