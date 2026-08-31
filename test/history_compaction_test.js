import { describe, it, expect, vi } from "vitest";
import { compactHistoryInPlace, findUnverifiedClaims } from "../connectors/gemini/agent_delegate.js";

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
});
