// ---------------------------------------------------------------------------
// test/mcp-integration.test.js
// Exercises a real tool (get_repo) through the actual mcpServer instance and
// real Zod schema validation, over an InMemoryTransport pair -- not a mock
// of server.tool() or a hand-rolled call to the handler function directly.
// This is the thing that would actually catch a zod 3->4 regression: a
// breaking change in how zod parses/coerces args would surface here as
// either a validation error on VALID input, or a non-validation error on
// INVALID input, not as a normal Vitest assertion mismatch elsewhere.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "test";

import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpServer } from "../server.js";

describe("MCP tool call — real Zod validation path (get_repo)", () => {
  let client;

  beforeAll(async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mcp-integration-test", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  it("VALID args pass Zod and reach the handler (fails downstream on missing GITHUB_TOKEN, not on validation)", async () => {
    // No GITHUB_TOKEN is set in this test run (it's a CI secret, not assumed
    // available here), so the handler itself throws once it tries to call
    // out. That's the point: reaching that error at all proves { owner,
    // repo } passed Zod parsing/coercion and were handed to the handler.
    const result = await client.callTool({
      name: "get_repo",
      arguments: { owner: "allocsys", repo: "madmcp" },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/GITHUB_TOKEN/);
    // Must NOT look like a schema/validation rejection.
    expect(text).not.toMatch(/Invalid arguments/i);
    expect(text).not.toMatch(/-32602/);
  });

  it("INVALID args (missing required `repo`) are rejected at the validation layer, never reaching the handler", async () => {
    const result = await client.callTool({
      name: "get_repo",
      arguments: { owner: "allocsys" }, // `repo` omitted -- required by the schema
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Must look like a schema/validation rejection...
    expect(text).toMatch(/Invalid arguments/i);
    expect(text).toMatch(/-32602/);
    // ...and must NOT be the downstream GITHUB_TOKEN error -- if it were,
    // that would mean bad input reached the handler instead of being
    // stopped by Zod.
    expect(text).not.toMatch(/GITHUB_TOKEN/);
  });
});
