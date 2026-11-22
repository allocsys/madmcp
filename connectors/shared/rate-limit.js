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

// Returns a `schedule(fn)` function that starts `fn` no sooner than
// `minIntervalMs` after the previously scheduled call STARTED, regardless of
// how many callers invoke `schedule` concurrently. Only the start gate is
// serialized: a call does not wait for earlier calls to finish, so slow
// requests overlap and throughput is ~1/minIntervalMs instead of
// 1/max(minIntervalMs, latency). This still protects against a burst of
// parallel tool calls (e.g. several Notion calls landing in the same
// delegate_agent step) hitting the upstream API all at once.
export function createThrottle(minIntervalMs) {
  let gate = Promise.resolve();
  let lastStartedAt = 0;

  function schedule(fn) {
    const turn = gate.then(async () => {
      const wait = lastStartedAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStartedAt = Date.now();
    });
    // gate never rejects, and fn's outcome never affects it, so one
    // failure can't jam the queue.
    gate = turn;
    return turn.then(fn);
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
