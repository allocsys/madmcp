// ---------------------------------------------------------------------------
// connectors/delegate/poll_format.js -- shared formatting for mid-run polls of
// async delegate_agent / delegate_editor runs.
//
// A poll of a still-running run reports ONLY that it is running and which
// step it is on -- no transcript, no per-call or per-file detail -- until the
// run finishes. Extra detail is opt-in via show_transcript, same as it
// already is for final/failed results.
// ---------------------------------------------------------------------------

// "step N of M" (or just "step N" if the checkpoint has no known ceiling).
// N is the step currently in progress: steps completed + 1.
export function pollStepLabel(checkpoint) {
  const current = (checkpoint?.stepsDone || 0) + 1;
  const max = checkpoint?.overallMaxSteps;
  return max ? `step ${current} of ${max}` : `step ${current}`;
}

// Tool-call transcript, only when the caller explicitly asked for it.
export function pollTranscriptBlock(checkpoint, showTranscript) {
  return showTranscript && checkpoint?.transcript?.length
    ? `\n\nTool calls so far:\n${checkpoint.transcript.join("\n")}`
    : "";
}

// Files-written note (delegate_editor), only when the caller explicitly
// asked for detail.
export function pollWrittenFilesBlock(checkpoint, showTranscript) {
  return showTranscript && checkpoint?.writtenFiles?.length
    ? `\n\nFiles written so far: ${checkpoint.writtenFiles.join(", ")}`
    : "";
}
