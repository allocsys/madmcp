// ---------------------------------------------------------------------------
// connectors/shared/rate-limit.js -- reusable request throttling + retry
// building blocks, used by connectors whose upstream API doesn't have its
// own bespoke rate-limit handling (currently Notion and Mem0; GitHub's
// connectors/github/client.js keeps its own independent, unit-tested
// implementation -- see the commit message / this file's header for why).
//
// Each connector that uses this should call createThrottle() ONCE at module
// load time and keep the returned `schedule` function for the lifetime of
// the process -- a fresh throttle per request would defeat the whole point
// (there'd be nothing to serialize against).
// ---------------------------------------------------------------------------

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns a `schedule(fn)` function that runs `fn` no sooner than
// `minIntervalMs` after the previously scheduled call started, regardless of
// how many callers invoke `schedule` concurrently -- a shared promise chain
// serializes them. This is what actually protects against a burst of
// parallel tool calls (e.g. several Notion calls landing in the same
// delegate_agent step, see connectors/delegate/agent/agent_delegate.js's 2026-07-26
// parallelization) hitting the upstream API all at once.
export function createThrottle(minIntervalMs) {
  let chain = Promise.resolve();
  let lastStartedAt = 0;

  function schedule(fn) {
    const run = async () => {
      const wait = lastStartedAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStartedAt = Date.now();
      return fn();
    };
    // Chain onto the shared queue regardless of whether prior requests
    // succeeded or failed, so one failure doesn't jam the whole queue.
    const result = chain.then(run, run);
    // Keep the chain alive without leaking rejections into unrelated callers.
    chain = result.then(() => {}, () => {});
    return result;
  }

  return schedule;
}

// Generic Retry-After-aware backoff: honors a numeric `retry-after` header
// (seconds) if the response provides one, otherwise falls back to
// exponential backoff with jitter. `res` only needs a `headers.get(name)`
// method (matches both the Fetch API's Headers object and the test mocks in
// test/github-client.test.js's style, though this function itself isn't
// used by that test file -- see this file's header).
export function defaultRetryDelayMs(res, attempt, baseMs) {
  const retryAfter = res.headers?.get?.("retry-after");
  if (retryAfter && !Number.isNaN(Number(retryAfter))) {
    return Number(retryAfter) * 1000;
  }
  const jitter = Math.random() * 250;
  return baseMs * 2 ** attempt + jitter;
}
