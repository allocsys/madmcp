import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

vi.mock("../connectors/github/code_search.js", () => ({
  runSearchCode: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { runSearchCode } from "../connectors/github/code_search.js";
import { register as registerCreateBranch } from "../connectors/github/create_branch.js";
import { register as registerSearchCode } from "../connectors/github/search_code.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("GitHub Connector - create_branch (standalone, split from repo_inspect)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerCreateBranch(server);
  });

  it("registers exactly one tool named create_branch", () => {
    expect(Object.keys(server.tools)).toEqual(["create_branch"]);
  });

  it("requires repo", async () => {
    const result = await server.tools.create_branch({ owner: "allocsys", branch: "b" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires repo");
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("requires an explicit owner (matches the original tool)", async () => {
    const result = await server.tools.create_branch({ repo: "madmcp", branch: "b" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires owner");
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("requires the new branch name", async () => {
    const result = await server.tools.create_branch({ owner: "allocsys", repo: "madmcp" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires branch");
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("creates a branch from an explicit from_branch source", async () => {
    githubRequest
      .mockResolvedValueOnce({ object: { sha: "abc123sha" } }) // get ref
      .mockResolvedValueOnce({}); // post branch ref

    const result = await server.tools.create_branch({
      owner: "allocsys",
      repo: "madmcp",
      branch: "new-feature",
      from_branch: "main",
    });

    expect(result.content[0].text).toContain("Created branch 'new-feature'");
    expect(result.content[0].text).toContain("abc123s");
    expect(githubRequest).toHaveBeenCalledTimes(2);
    expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/git/ref/heads/main");
    expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/git/refs");
    expect(githubRequest.mock.calls[1][1].body).toEqual({
      ref: "refs/heads/new-feature",
      sha: "abc123sha",
    });
  });

  it("creates a branch from the repo default branch if from_branch is omitted", async () => {
    githubRequest
      .mockResolvedValueOnce({ default_branch: "develop" }) // get repo data
      .mockResolvedValueOnce({ object: { sha: "def456sha" } }) // get develop ref
      .mockResolvedValueOnce({}); // post branch ref

    const result = await server.tools.create_branch({
      owner: "allocsys",
      repo: "madmcp",
      branch: "new-feature",
    });

    expect(result.content[0].text).toContain("Created branch 'new-feature' in allocsys/madmcp from def456s");
    expect(githubRequest).toHaveBeenCalledTimes(3);
    expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp");
    expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/git/ref/heads/develop");
  });
});

describe("GitHub Connector - search_code (standalone, split from repo_inspect)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerSearchCode(server);
  });

  it("registers exactly one tool named search_code", () => {
    expect(Object.keys(server.tools)).toEqual(["search_code"]);
  });

  it("requires query", async () => {
    const result = await server.tools.search_code({ ref: "main" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires query");
    expect(runSearchCode).not.toHaveBeenCalled();
  });

  it("requires ref", async () => {
    const result = await server.tools.search_code({ query: "foo repo:allocsys/madmcp" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires ref");
    expect(runSearchCode).not.toHaveBeenCalled();
  });

  it("delegates to runSearchCode with per_page defaulting to 20", async () => {
    runSearchCode.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const result = await server.tools.search_code({ query: "foo repo:allocsys/madmcp", ref: "main" });
    expect(result.content[0].text).toBe("ok");
    expect(runSearchCode).toHaveBeenCalledWith({ query: "foo repo:allocsys/madmcp", per_page: 20, ref: "main" });
  });

  it("passes an explicit per_page through", async () => {
    runSearchCode.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    await server.tools.search_code({ query: "foo repo:allocsys/madmcp", ref: "dev", per_page: 5 });
    expect(runSearchCode).toHaveBeenCalledWith({ query: "foo repo:allocsys/madmcp", per_page: 5, ref: "dev" });
  });
});
