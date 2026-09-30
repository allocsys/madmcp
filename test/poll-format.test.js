import { describe, it, expect } from "vitest";
import { pollStepLabel, pollTranscriptBlock, pollWrittenFilesBlock } from "../connectors/delegate/poll_format.js";

describe("poll_format", () => {
  it("pollStepLabel: current step is stepsDone + 1, with ceiling when known", () => {
    expect(pollStepLabel({ stepsDone: 0, overallMaxSteps: 20 })).toBe("step 1 of 20");
    expect(pollStepLabel({ stepsDone: 4, overallMaxSteps: 20 })).toBe("step 5 of 20");
  });

  it("pollStepLabel: omits ceiling when unknown, tolerates missing checkpoint", () => {
    expect(pollStepLabel({ stepsDone: 2 })).toBe("step 3");
    expect(pollStepLabel(undefined)).toBe("step 1");
  });

  it("pollTranscriptBlock: empty unless show_transcript is truthy and transcript non-empty", () => {
    const cp = { transcript: ["a", "b"] };
    expect(pollTranscriptBlock(cp, false)).toBe("");
    expect(pollTranscriptBlock(cp, undefined)).toBe("");
    expect(pollTranscriptBlock({ transcript: [] }, true)).toBe("");
    expect(pollTranscriptBlock(cp, true)).toBe("\n\nTool calls so far:\na\nb");
  });

  it("pollWrittenFilesBlock: empty unless show_transcript is truthy and files exist", () => {
    const cp = { writtenFiles: ["x.js", "y.js"] };
    expect(pollWrittenFilesBlock(cp, false)).toBe("");
    expect(pollWrittenFilesBlock({ writtenFiles: [] }, true)).toBe("");
    expect(pollWrittenFilesBlock(cp, true)).toBe("\n\nFiles written so far: x.js, y.js");
  });
});
