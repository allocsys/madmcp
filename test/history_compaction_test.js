import { describe, it, expect, vi } from "vitest";
import { compactHistoryInPlace, findUnverifiedClaims, BULKY_TOOL_NAMES } from "../connectors/gemini/agent_delegate.js";

describe("History Compaction Feature & Verification (agent_delegate.js)", () => {
  it("compacts older bulky tool results and uses dedicated store", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompactionResults = new Map();
    // step 5, provider "bai"
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(preCompactionResults.get("call_1")).toBe(longText);
  });

  it("ensures claims grounded in compacted tool results verify successfully via pre-compaction capture", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    // Raw functionResponse text has now been replaced
    expect(contents[2].parts[0].functionResponse.response.result).not.toContain("SECRET_TOKEN_XYZ_123");

    // Verify claim
    const claims = ["SECRET_TOKEN_XYZ_123", "FABRICATED_CLAIM_999"];
    const unverified = findUnverifiedClaims(claims, contents, preCompactionResults);

    expect(unverified).toEqual(["FABRICATED_CLAIM_999"]);
  });

  it("test round-trip serialization pattern for preCompactionResults", () => {
    const preCompactionResults = new Map([
        ["id1", "content1"],
        ["id2", "content2"]
    ]);

    // Save pattern
    const savedObj = Object.fromEntries(preCompactionResults);
    
    // Restore pattern
    const restoredMap = new Map(Object.entries(savedObj));

    expect(restoredMap.size).toBe(2);
    expect(restoredMap.get("id1")).toBe("content1");
    expect(restoredMap.get("id2")).toBe("content2");
  });

  it("leaves contents completely untouched when provider is gemini (default, compaction disabled)", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(contents));

    compactHistoryInPlace(contents, 10, new Map(), { provider: "gemini" });

    expect(contents).toEqual(snapshot);
  });

  it("never compacts non-bulky tool results regardless of turn age", () => {
    expect(BULKY_TOOL_NAMES.has("github_get_commit")).toBe(false);
    const longText = "COMMIT_DATA_ABC " + "B".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_get_commit", args: { repo: "foo", sha: "abc1234" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_get_commit", id: "call_1", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 10, new Map(), { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("COMMIT_DATA_ABC");
    expect(result).not.toContain("Earlier tool result compacted");
  });

  it("includes the target file path argument in the compacted summary text", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 5, new Map(), { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(result).toContain("src/secret.js");
  });

  it("Window-boundary contract test", () => {
    const contents = [];
    for (let i = 1; i <= 4; i++) {
        contents.push({ role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "file" + i }, id: "c" + i } }] });
        contents.push({ role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c" + i, response: { result: `PAYLOAD_${i}_` + "X".repeat(600) } } }] });
    }
    
    // Call with 3 completed steps (currentStep 3) - nothing compacted (3 steps full)
    const map1 = new Map();
    compactHistoryInPlace(contents, 3, map1, { provider: "bai" });
    for (let i = 1; i <= 4; i++) {
        expect(contents[i*2-1].parts[0].functionResponse.response.result).toContain(`PAYLOAD_${i}_`);
    }

    // Call with 4 completed steps (currentStep 4) - step 1 compacted
    const map2 = new Map();
    compactHistoryInPlace(contents, 4, map2, { provider: "bai" });
    expect(contents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted"); // Step 1
    for (let i = 2; i <= 4; i++) {
        expect(contents[i*2-1].parts[0].functionResponse.response.result).toContain(`PAYLOAD_${i}_`);
    }
  });

  it("Id-collision safety test", () => {
    const contents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "1" }, id: "call_1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: "TEXT_A" + "X".repeat(600) } } }] },
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "2" }, id: "call_1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: "TEXT_B" + "X".repeat(600) } } }] },
    ];
    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 10, preCompactionResults, { provider: "bai" });

    const values = Array.from(preCompactionResults.values());
    expect(values).toContain(contents[1].parts[0].functionResponse.response.result); // Not directly, check values
    expect(values.length).toBe(2);
    expect(values).toContain("TEXT_A" + "X".repeat(600));
    expect(values).toContain("TEXT_B" + "X".repeat(600));
  });

  it("Checkpoint-round-trip recompaction test", () => {
    const originalText = "BULKY_TEXT_" + "X".repeat(600);
    const contents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "f" }, id: "c1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c1", response: { result: originalText } } }] },
    ];

    // Compact once
    const map1 = new Map();
    compactHistoryInPlace(contents, 10, map1, { provider: "bai" });
    expect(contents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted");

    // Reconstruct round-tripped
    const roundTrippedContents = JSON.parse(JSON.stringify(contents));
    // The bug: roundTrippedContents would be full text
    // Simulate what happens in Redis (the original text IS in the round-tripped version)
    // Actually, in the code, JSON.parse(JSON.stringify(contents)) results in the compacted text.
    // The requirement says: simulate what loadCheckpoint reconstructs - original, never-recompacted turn.
    const restoredContents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "f" }, id: "c1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c1", response: { result: originalText } } }] },
    ];
    
    // Compact again
    const map2 = new Map();
    compactHistoryInPlace(restoredContents, 10, map2, { provider: "bai" });
    expect(restoredContents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted");
    expect(map2.get("c1")).toBe(originalText);
  });
});
