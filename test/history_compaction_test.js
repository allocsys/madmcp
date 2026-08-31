import { describe, it, expect, vi } from "vitest";
import { compactHistoryInPlace } from "../connectors/gemini/agent_delegate.js";

// Helper for finding unverified claims needs to be available or test logic verified.
// For now, let's test the compaction logic improvements.

describe("History Compaction Feature (agent_delegate.js)", () => {
  it("compacts older bulky tool results and includes target path", () => {
    const longText = "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "bar.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompaction = new Map();
    // step 5, provider "bai"
    compactHistoryInPlace(contents, 5, preCompaction, { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(result).toContain("bar.js"); // Target path included (BUG 2)
    expect(preCompaction.get("call_1")).toBe(longText); // Evidence preserved for verification (BUG 1)
  });
});
