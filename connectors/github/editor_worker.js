// ---------------------------------------------------------------------------
// connectors/github/editor_worker.js -- QStash-invoked HTTP endpoint that
// advances a delegate_editor run one step at a time in the background,
// same self-chaining pattern as connectors/gemini/agent_worker.js (see that
// file's own header for the full singleStep-vs-max_steps rationale --
// unchanged here, just against runEditorAgent instead of runInvestigation).
//
// SECURITY: this endpoint is PUBLICLY reachable (QStash calls it over the
// open internet), and unlike agent_worker.js's read-only investigation
// loop, runEditorAgent is WRITE-CAPABLE (it commits to a real branch) --
// so failing CLOSED on signature verification here is a strictly worse
// risk to get wrong than agent_worker.js's own read-only case. Every
// request's signature is verified via qstash_client.js's
// verifyQStashSignature BEFORE any checkpoint is touched.
//
// IDEMPOTENCY: same afterStep/stepsDone guard as agent_worker.js -- QStash
// may redeliver the same {runId, afterStep} message more than once.
// `afterStep` records the checkpoint's stepsDone at the moment THIS
// message was published -- if the live checkpoint has already moved past
// that, this invocation no-ops instead of double-executing a step that's
// already done.
//
// WHOLE-BLOB CHECKPOINT CAVEAT: unlike agent_checkpoint.js (which splits
// `contents` into its own Redis LIST, untouched by a meta-only write),
// editor_checkpoint.js is a whole-blob overwrite (see its own header,
// plan.md Step 1). A meta-shaped heartbeat/dead-letter write here -- naming
// only a few fields, the way agent_worker.js's own heartbeat write does --
// would silently ERASE contents/writtenFiles/writesPerFile/validateCounts/
// owner/repo/branch on the very first worker invocation, before
// runEditorAgent is even called. Both writes below therefore spread the
// ENTIRE loaded checkpoint object and override only the field(s) that
// actually change.
//
// DEAD-LETTER / RETRY BOUND: same shape as agent_worker.js's dead-letter
// step -- EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES bounds consecutive
// same-step failures (a step that completes without advancing stepsDone)
// before the chain gives up and finalizes the checkpoint as "failed"
// instead of silently retrying at QStash's expense indefinitely.
// ---------------------------------------------------------------------------

import { runEditorAgent } from "./editor_delegate.js";
import { loadCheckpoint, saveCheckpoint } from "./editor_checkpoint.js";
import { publishEditorStep, verifyQStashSignature } from "../delegate/qstash_client.js";
import { EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES } from "../../config.js";

// Express handler for POST /api/editor-worker (registered in server.js,
// plan.md Step 5). Always responds 200 for a request that was validly
// signed and reached a definite outcome (no-op, chained, dead-lettered,
// rechain-failed) -- QStash treats any non-2xx as a delivery failure and
// retries, which is only wanted for genuine transient failures INSIDE
// runEditorAgent (already handled by the re-chain-with-same-afterStep path
// below, not by asking QStash's own retry to redeliver this HTTP call).
// Only signature failures and a missing runId return non-2xx, since those
// are the two cases where nothing meaningful was done.
export async function handleEditorWorker(req, res) {
  const signature = req.get("Upstash-Signature");
  // Same rawBody rationale as agent_worker.js: server.js's express.json()
  // is configured with a `verify` callback that stashes the raw request
  // body buffer on req.rawBody specifically so this handler can verify
  // QStash's signature against the EXACT bytes QStash signed --
  // re-serializing req.body (already JSON.parsed) is not guaranteed to
  // byte-for-byte match what QStash originally sent. Falling back to a
  // re-stringified body only protects against req.rawBody being
  // unexpectedly absent; it will simply fail verification (fail closed)
  // rather than silently accept in that case.
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});

  const verified = await verifyQStashSignature({ signature, body: rawBody });
  if (!verified) {
    console.warn("editor-worker: rejected request with missing/invalid QStash signature");
    return res.status(401).json({ error: "invalid or missing QStash signature" });
  }

  const { runId, afterStep = 0, retryCount = 0 } = req.body || {};
  if (!runId) {
    return res.status(400).json({ error: "missing runId" });
  }

  const checkpoint = await loadCheckpoint(runId);
  if (!checkpoint) {
    // Expired past the 1-hour TTL, never existed, or Redis is unreachable
    // (editor_checkpoint.js fails open on reads) -- nothing to advance. Not
    // an error from QStash's point of view (it did its job delivering the
    // message); the run itself is just gone.
    console.warn(`editor-worker: no live checkpoint for runId ${runId} -- dropping message`);
    return res.status(200).json({ status: "no-op", reason: "checkpoint missing or expired" });
  }

  if (checkpoint.status !== "running") {
    // Already finished ("done" via a genuine answer, or "failed" via this
    // same file's dead-letter path below) by a prior invocation -- do not
    // touch it again. Also covers a duplicate/late redelivery of a message
    // whose run has since completed.
    return res.status(200).json({ status: "no-op", reason: `checkpoint status is "${checkpoint.status}", not "running"` });
  }

  if (checkpoint.stepsDone !== afterStep) {
    // Idempotency guard: this message's view of the world (afterStep) no
    // longer matches the live checkpoint -- another invocation (a QStash
    // redelivery racing this one, most likely) already advanced it.
    // Re-executing here would double-take a step already taken.
    return res.status(200).json({ status: "no-op", reason: `stepsDone (${checkpoint.stepsDone}) != afterStep (${afterStep}) -- already advanced by another invocation` });
  }

  // Heartbeat write, INSIDE the idempotency guard above: spread the ENTIRE
  // loaded checkpoint (see file header) and override only stepStartedAt,
  // so nothing else -- contents, writtenFiles, writesPerFile,
  // validateCounts, owner/repo/branch, etc. -- is silently dropped.
  await saveCheckpoint(runId, {
    ...checkpoint,
    stepStartedAt: Date.now(),
  });

  let result;
  try {
    result = await runEditorAgent({ resume_run_id: runId, singleStep: true });
  } catch (err) {
    // Belt-and-suspenders: runEditorAgent is designed to catch its own
    // failures internally and return a `{ failed: true }` result rather
    // than throw -- but if something still escapes it (a bug, an exotic
    // error shape), treat it exactly like an ordinary same-step failure
    // below instead of letting it crash this endpoint, which would strand
    // the chain with no re-chain AND no dead-letter finalization either.
    result = { steps: checkpoint.stepsDone, failed: true, answer: `(editor-worker: unexpected error advancing runId ${runId}: ${err?.message ?? String(err)})` };
  }

  const advanced = result.steps > afterStep;
  const newRetryCount = advanced ? 0 : retryCount + 1;

  const latest = await loadCheckpoint(runId);
  if (!latest || latest.status !== "running") {
    // Finished this step -- runEditorAgent's own completion path already
    // persists status "done" itself (see plan.md Step 2). Nothing more to
    // chain.
    return res.status(200).json({ status: latest?.status || "gone", steps: result.steps });
  }

  if (!advanced && newRetryCount >= EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES) {
    // Dead-letter: this exact step has now failed
    // EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES times in a row without ever
    // advancing stepsDone. A genuinely transient error succeeds well
    // before this many attempts, so this is treated as a permanent
    // failure. Finalize the checkpoint as "failed" so a poller gets a
    // definitive answer instead of a chain that silently stopped
    // re-publishing with no record of why. Same whole-object spread
    // caveat as the heartbeat write above -- override only
    // status/finalAnswer/stepStartedAt, don't reconstruct a meta-shaped
    // subset.
    await saveCheckpoint(runId, {
      ...latest,
      status: "failed",
      finalAnswer: `Run stopped after ${EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES} consecutive failures on step ${latest.stepsDone + 1}: ${result.answer}`,
      stepStartedAt: null,
    });
    console.error(`editor-worker: runId ${runId} dead-lettered after ${newRetryCount} consecutive failures on step ${latest.stepsDone + 1}`);
    return res.status(200).json({ status: "dead-lettered", steps: latest.stepsDone });
  }

  // Still running and under the retry cap (whether this step succeeded and
  // there's more work to do, or it failed but hasn't hit the dead-letter
  // threshold yet) -- re-chain: publish the next worker invocation with the
  // FRESH stepsDone/retryCount so the next message's idempotency/dead-letter
  // checks are accurate.
  try {
    await publishEditorStep({ runId, afterStep: latest.stepsDone, retryCount: newRetryCount });
  } catch (err) {
    // The step itself either succeeded or failed-but-still-under-the-cap --
    // only the re-chain PUBLISH failed here. The checkpoint is left in a
    // perfectly valid "running" state with a fresh lastStepAt (saved by
    // runEditorAgent's own per-step checkpoint write, not by this file), so
    // a stale-lastStepAt fallback in editor_tools.js's polling branch
    // (plan.md Step 7) can detect this as a broken chain and resume
    // synchronously on the next poll -- a failed publish here is not a
    // silent stranding, just a slower recovery path than the chain
    // continuing on its own.
    console.error(`editor-worker: failed to re-chain runId ${runId} after step ${latest.stepsDone}: ${err?.message ?? String(err)}`);
    return res.status(200).json({ status: "step-ok-rechain-failed", steps: latest.stepsDone });
  }

  return res.status(200).json({ status: "chained", steps: latest.stepsDone });
}

// ---------------------------------------------------------------------------
// handleEditorWorkerFailure (plan.md Section 13) -- Express handler for
// POST /api/editor-worker-failure, the QStash failureCallback target
// configured in publishEditorStep (../gemini/qstash_client.js). Mirrors
// connectors/gemini/agent_worker.js's handleAgentWorkerFailure -- see that
// function's own header comment for the full reasoning (why this exists:
// a step that hard-times-out on every QStash delivery attempt means no
// further worker invocation ever arrives to run the in-process dead-letter
// check, once publishEditorStep's retries budget, now QSTASH_STEP_RETRIES,
// is exhausted). Only difference here: editor_checkpoint.js is a
// whole-blob overwrite (see this file's own header), so the save below
// spreads the loaded checkpoint rather than naming each field explicitly
// the way agent_worker.js's split-contents checkpoint requires.
export async function handleEditorWorkerFailure(req, res) {
  const signature = req.get("Upstash-Signature");
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
  const verified = await verifyQStashSignature({ signature, body: rawBody });
  if (!verified) {
    console.warn("editor-worker-failure: rejected request with missing/invalid QStash signature");
    return res.status(401).json({ error: "invalid or missing QStash signature" });
  }

  const { retried, maxRetries } = req.body || {};
  let sourcePayload;
  try {
    sourcePayload = JSON.parse(Buffer.from(req.body?.sourceBody || "", "base64").toString("utf8"));
  } catch (err) {
    console.error(`editor-worker-failure: could not decode/parse sourceBody: ${err?.message ?? err}`);
    return res.status(200).json({ status: "no-op", reason: "unparseable sourceBody" });
  }

  const { runId, afterStep = 0 } = sourcePayload || {};
  if (!runId) {
    return res.status(200).json({ status: "no-op", reason: "sourceBody missing runId" });
  }

  const checkpoint = await loadCheckpoint(runId);
  if (!checkpoint || checkpoint.status !== "running" || checkpoint.stepsDone !== afterStep) {
    // Stale callback -- the run already finished or moved on via some other
    // recovery path before QStash's own delivery attempt to the ORIGINAL
    // message finally gave up. Not authoritative; no-op.
    return res.status(200).json({ status: "no-op", reason: "checkpoint not in the stalled state this callback describes" });
  }

  await saveCheckpoint(runId, {
    ...checkpoint,
    status: "failed",
    finalAnswer: `Run stopped: QStash exhausted its own delivery budget (retried ${retried ?? "?"}/${maxRetries ?? "?"}) on step ${checkpoint.stepsDone + 1} without ever getting a response -- almost always a platform-level execution timeout repeating on the same oversized step. Reported via QStash's failureCallback, since a step that times out on every delivery attempt means no further worker invocation ever arrives to run this file's own in-process dead-letter check.`,
    stepStartedAt: null,
  });
  console.error(`editor-worker-failure: runId ${runId} dead-lettered via QStash failureCallback (retried=${retried}, maxRetries=${maxRetries}) on step ${checkpoint.stepsDone + 1}`);
  return res.status(200).json({ status: "dead-lettered", reason: "qstash-failure-callback", steps: checkpoint.stepsDone });
}
