import { describe, it, expect, vi } from "vitest";
import { compactHistoryInPlace } from "../connectors/gemini/agent_delegate.js";

// Helper for finding unverified claims needs to be available or test logic verified.
// For now, let's test the compaction logic improvements.

import { findUnverifiedClaims } from "../connectors/gemini/agent_delegate.js";

describe("History Compaction Feature & Verification (agent_delegate.js)", () => {
  it("compacts older bulky tool results and includes target path (BUG 2)", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompaction = new Map();
    // step 5, provider "bai"
    compactHistoryInPlace(contents, 5, preCompaction, { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(result).toContain("github_read_file");
    expect(result).toContain("src/secret.js"); // Target path included
    expect(preCompaction.get("call_1")).toBe(longText);
  });

  it("ensures claims grounded in compacted tool results verify successfully via pre-compaction capture (BUG 1)", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompaction = new Map();
    compactHistoryInPlace(contents, 5, preCompaction, { provider: "bai" });

    // Raw functionResponse text has now been replaced with the short summary placeholder
    expect(contents[2].parts[0].functionResponse.response.result).not.toContain("SECRET_TOKEN_XYZ_123");

    // Verify claim that was present in the raw result before compaction
    const claims = ["SECRET_TOKEN_XYZ_123", "FABRICATED_CLAIM_999"];
    const unverified = findUnverifiedClaims(claims, contents, preCompaction);

    // Grounded claim should verify successfully (not flagged as unverified),
    // whereas fabricated claim should be flagged as unverified.
    expect(unverified).toEqual(["FABRICATED_CLAIM_999"]);
  });
});
