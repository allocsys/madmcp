import { describe, it, expect } from "vitest";
import { formatCascadeLogLine } from "../connectors/llm/cascade_log.js";

describe("formatCascadeLogLine", () => {
  it("returns null when no fallback fields are set", () => {
    const candidate = { content: { parts: [{ text: "hello" }] } };
    const line = formatCascadeLogLine(candidate, { step: 1, fallbackModel: "gemini-2.5-flash" });
    expect(line).toBeNull();
  });

  it("returns null when candidate is null or undefined", () => {
    expect(formatCascadeLogLine(null, { step: 1, fallbackModel: "gemini-2.5-flash" })).toBeNull();
    expect(formatCascadeLogLine(undefined, { step: 1, fallbackModel: "gemini-2.5-flash" })).toBeNull();
  });

  it("returns model-only message when only _fallbackModelUsed is set", () => {
    const candidate = { _fallbackModelUsed: "gemini-1.5-pro" };
    const line = formatCascadeLogLine(candidate, { step: 2, fallbackModel: "gemini-2.5-flash" });
    expect(line).toBe(
      '[step 2] [CASCADE] served by fallback model "gemini-1.5-pro" -- primary model/key was unavailable (rate-limited, overloaded, or rejected).'
    );
  });

  it("names the model via fallbackModel on a key-only fallback (model unchanged)", () => {
    const candidate = { _fallbackKeyIndex: 1 };
    const line = formatCascadeLogLine(candidate, { step: 3, fallbackModel: "gemini-2.5-flash" });
    // No model actually changed here -- only the key rotated -- so this must
    // NOT be worded as a "fallback model", unlike the model-changed cases below.
    expect(line).toBe(
      '[step 3] [CASCADE] served by fallback key #1 on model "gemini-2.5-flash" -- primary key was unavailable (rate-limited, overloaded, or rejected).'
    );
  });

  it("omits the model clause entirely on a key-only fallback when fallbackModel isn't supplied", () => {
    // Regression test: editor_delegate.js never passes fallbackModel, and
    // agent_delegate.js's effectiveModel is frequently undefined on a fresh
    // run with no explicit model requested. Previously this interpolated the
    // literal string "undefined" into the log line -- confirmed live via a
    // test run of the key-rotation fix (PR #176): "served by fallback model
    // 'undefined', key #2".
    const candidate = { _fallbackKeyIndex: 2 };
    const line = formatCascadeLogLine(candidate, { step: 5 });
    expect(line).toBe(
      '[step 5] [CASCADE] served by fallback key #2 -- primary key was unavailable (rate-limited, overloaded, or rejected).'
    );
    expect(line).not.toContain("undefined");
  });

  it("returns message with key index when both _fallbackModelUsed and _fallbackKeyIndex are set", () => {
    const candidate = { _fallbackModelUsed: "gemini-2.0-flash", _fallbackKeyIndex: 2 };
    const line = formatCascadeLogLine(candidate, { step: 4, fallbackModel: "gemini-2.5-flash" });
    expect(line).toBe(
      '[step 4] [CASCADE] served by fallback model "gemini-2.0-flash", key #2 -- primary model/key was unavailable (rate-limited, overloaded, or rejected).'
    );
  });
});
