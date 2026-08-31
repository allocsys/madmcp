import { describe, it, expect } from "vitest";
import { compactHistoryInPlace, HISTORY_FULL_DETAIL_STEPS } from "../connectors/gemini/agent_delegate.js";

describe("History Compaction Feature (agent_delegate.js)", () => {
  it("leaves history completely untouched when provider is not in HISTORY_COMPACTION_PROVIDERS (default 'gemini')", () => {
    const longText = "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "bar.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    // step 5, provider "gemini" (which is NOT in default ["bai"])
    compactHistoryInPlace(contents, 5, { provider: "gemini" });

    // Should remain 100% unchanged
    expect(contents[2].parts[0].functionResponse.response.result).toBe(longText);
  });

  it("compacts older bulky tool results when provider is 'bai' (compaction enabled)", () => {
    const longText = "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      // step 1 turn
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "bar.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
      // step 2 turn (recent)
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "baz.js" }, id: "call_2" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_2", response: { result: longText } } }] },
    ];

    // currentStep = 5. HISTORY_FULL_DETAIL_STEPS = 3.
    // Step 1 is older than (5 - 3) = 2, so Step 1's bulky result should be compacted.
    // Step 2 is within the recent window (2 > 2 is false), so Step 2's result stays full.
    compactHistoryInPlace(contents, 5, { provider: "bai" });

    const step1Result = contents[2].parts[0].functionResponse.response.result;
    const step2Result = contents[4].parts[0].functionResponse.response.result;

    expect(step1Result).toContain("Earlier tool result compacted");
    expect(step1Result).toContain("github_read_file");
    expect(step2Result).toBe(longText);
  });

  it("never compacts non-bulky tool results regardless of age", () => {
    const longText = "B".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_get_commit", args: { repo: "foo", sha: "abc" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_get_commit", id: "call_1", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 5, { provider: "bai" });

    expect(contents[2].parts[0].functionResponse.response.result).toBe(longText);
  });

  it("preserves role alternation and id pairing invariants (does not remove turns or change roles)", () => {
    const longText = "C".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "bar.js" }, id: "call_123" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_123", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 10, { provider: "bai" });

    expect(contents.length).toBe(3);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
    expect(contents[1].parts[0].functionCall.id).toBe("call_123");
    expect(contents[2].parts[0].functionResponse.id).toBe("call_123");
  });
});
