// ---------------------------------------------------------------------------
// test/muse-readonly.test.js
// The limited Muse server (createMuseMcpServer, served at /mcp/muse) must
// expose exactly the read-only GitHub + Notion tools in MUSE_ALLOWED_TOOLS
// -- nothing else. A write tool, a delegate, or a new connector tool added
// later must NOT appear here until it is deliberately added to the
// allowlist in server.js. Uses the real McpServer + InMemoryTransport,
// same pattern as test/mcp-integration.test.js.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "test";

import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMuseMcpServer, createMcpServer, MUSE_ALLOWED_TOOLS } from "../server.js";

// The exact allowlist, spelled out here as well as in server.js so a
// drift between the two (or a silent widening) fails loudly.
const EXPECTED_MUSE_TOOLS = [
  "read_file",
  "list_directory",
  "get_file_tree",
  "search_code",
  "pr_read",
  "repo_inspect",
  "repo_metadata",
  "list_notifications",
  "notion_find",
  "notion_read",
  // The one write: append-only to the single configured bridge page.
  "bridge_post",
].sort();

async function connectClient(createServer) {
  const mcpServer = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-readonly-test", version: "1.0.0" });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("Muse server — tool allowlist", () => {
  let museClient;

  beforeAll(async () => {
    museClient = await connectClient(createMuseMcpServer);
  });

  it("exposes exactly the 11 tools: 10 read-only GitHub + Notion tools plus bridge_post, no more", async () => {
    const { tools } = await museClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_MUSE_TOOLS);
    expect([...MUSE_ALLOWED_TOOLS].sort()).toEqual(EXPECTED_MUSE_TOOLS);
  });

  it("exposes no write tools except bridge_post, no delegates, no termux, no other connectors", async () => {
    const { tools } = await museClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const banned of [
      // GitHub writes
      "edit_file", "create_repo_file", "delete_file", "rename_file",
      "overwrite_files", "create_branch", "pr_write", "issue_manage",
      "release_manage", "repo_lifecycle", "ci_manage", "codespace_manage",
      "exec_in_codespace", "gh_token",
      // Notion writes + mixed read/write tools
      "notion_create", "notion_update", "notion_sync_content",
      "notion_index_entries_add_batch", "notion_chart", "checkpoint",
      // Delegates (can write, and can loop around a tool filter)
      "delegate_agent", "delegate_editor", "delegate_designer",
      "delegate_research",
      // Everything else
      "termux_exec", "termux_api", "termux_result",
      "mem0_write", "mem0_delete", "sync_mem0_to_notion",
      "cf_workers_read", "cf_delete", "web_fetch", "map", "jules_write",
    ]) {
      expect(names.has(banned)).toBe(false);
    }
  });

  it("a listed read tool is callable (reaches its handler, fails only on missing GITHUB_TOKEN)", async () => {
    const result = await museClient.callTool({
      name: "repo_metadata",
      arguments: { action: "get", owner: "allocsys", repo: "madmcp" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/GITHUB_TOKEN/);
    expect(result.content[0].text).not.toMatch(/Unknown tool/i);
  });

  it("an unlisted write tool is rejected as unknown, never reaching a handler", async () => {
    const result = await museClient.callTool({
      name: "edit_file",
      arguments: { owner: "allocsys", repo: "madmcp", path: "README.md", replacements: [] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Tool edit_file not found/);
    expect(result.content[0].text).toMatch(/-32602/);
    expect(result.content[0].text).not.toMatch(/GITHUB_TOKEN/);
  });

  it("gh_token stays unknown on the Muse server (regression guard: GitHub access comes from the official GitHub MCP, not a minted write token)", async () => {
    const result = await museClient.callTool({
      name: "gh_token",
      arguments: { owner: "allocsys", repo: "madmcp" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Tool gh_token not found/);
    expect(result.content[0].text).toMatch(/-32602/);
  });
});

describe("Full server — unchanged by the Muse filter", () => {
  it("still registers the full tool set, including writes", async () => {
    const client = await connectClient(createMcpServer);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("edit_file")).toBe(true);
    expect(names.has("delegate_agent")).toBe(true);
    expect(names.has("termux_exec")).toBe(true);
    expect(tools.length).toBeGreaterThan(EXPECTED_MUSE_TOOLS.length);
  });
});
