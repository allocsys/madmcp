import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Exercises config.js's REAL HISTORY_COMPACTION_PROVIDERS export (not a
// reimplemented copy of its .split(',').map().filter() logic) -- config.js
// reads process.env at module-evaluation time, so each case needs a fresh
// module import (vi.resetModules) after setting the env var, not just a
// re-invocation of some parsing helper.
describe("config.js HISTORY_COMPACTION_PROVIDERS parsing", () => {
  const ORIGINAL_ENV = process.env.HISTORY_COMPACTION_PROVIDERS;

  beforeEach(() => {
    delete process.env.HISTORY_COMPACTION_PROVIDERS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.HISTORY_COMPACTION_PROVIDERS;
    } else {
      process.env.HISTORY_COMPACTION_PROVIDERS = ORIGINAL_ENV;
    }
  });

  async function loadWithEnv(value) {
    if (value === undefined) {
      delete process.env.HISTORY_COMPACTION_PROVIDERS;
    } else {
      process.env.HISTORY_COMPACTION_PROVIDERS = value;
    }
    const modUrl = `../config.js?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ modUrl);
    return mod.HISTORY_COMPACTION_PROVIDERS;
  }

  it("parses a standard comma-separated string", async () => {
    expect(await loadWithEnv("bai,gemini")).toEqual(["bai", "gemini"]);
  });

  it("trims extra whitespace around entries", async () => {
    expect(await loadWithEnv(" bai ,  gemini , glm ")).toEqual(["bai", "gemini", "glm"]);
  });

  it("filters out empty entries from doubled/trailing commas", async () => {
    expect(await loadWithEnv("bai,,gemini, ,glm")).toEqual(["bai", "gemini", "glm"]);
  });

  it("defaults to [\"bai\"] when the env var is completely unset", async () => {
    expect(await loadWithEnv(undefined)).toEqual(["bai"]);
  });

  it("returns an empty array when the env var is set but empty", async () => {
    expect(await loadWithEnv("")).toEqual([]);
  });
});

// Same real-module-import approach as above. The regression this guards:
// `Number(env) || 0.7` treated a threshold of 0 as falsy and silently fell
// back to 0.7, so "flag every write" (EDITOR_RISK_FLAG_THRESHOLD=0) was
// impossible.
describe("config.js EDITOR_RISK_FLAG_THRESHOLD parsing", () => {
  const ORIGINAL_ENV = process.env.EDITOR_RISK_FLAG_THRESHOLD;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EDITOR_RISK_FLAG_THRESHOLD;
    } else {
      process.env.EDITOR_RISK_FLAG_THRESHOLD = ORIGINAL_ENV;
    }
  });

  async function loadWithEnv(value) {
    if (value === undefined) {
      delete process.env.EDITOR_RISK_FLAG_THRESHOLD;
    } else {
      process.env.EDITOR_RISK_FLAG_THRESHOLD = value;
    }
    const modUrl = `../config.js?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ modUrl);
    return mod.EDITOR_RISK_FLAG_THRESHOLD;
  }

  it("defaults to 0.7 when unset", async () => {
    expect(await loadWithEnv(undefined)).toBe(0.7);
  });

  it("defaults to 0.7 when set but empty", async () => {
    expect(await loadWithEnv("")).toBe(0.7);
  });

  it("defaults to 0.7 when not a number", async () => {
    expect(await loadWithEnv("high")).toBe(0.7);
  });

  it("honors an explicit 0 (flag every scored write) instead of falling back", async () => {
    expect(await loadWithEnv("0")).toBe(0);
  });

  it("honors other numeric values", async () => {
    expect(await loadWithEnv("0.5")).toBe(0.5);
    expect(await loadWithEnv("1")).toBe(1);
  });
});

// Same real-module-import approach as above, for the bridge message cap.
// Unlike EDITOR_RISK_FLAG_THRESHOLD, 0 is NOT a meaningful cap here ("no
// message may have any length"), so `Number(env) || 4000` falling back
// for 0 is intended -- this pins that, so a future refactor to the
// threshold-style parsing doesn't silently change the behaviour.
describe("config.js BRIDGE_MAX_MESSAGE_CHARS parsing", () => {
  const ORIGINAL_ENV = process.env.BRIDGE_MAX_MESSAGE_CHARS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BRIDGE_MAX_MESSAGE_CHARS;
    } else {
      process.env.BRIDGE_MAX_MESSAGE_CHARS = ORIGINAL_ENV;
    }
  });

  async function loadWithEnv(value) {
    if (value === undefined) {
      delete process.env.BRIDGE_MAX_MESSAGE_CHARS;
    } else {
      process.env.BRIDGE_MAX_MESSAGE_CHARS = value;
    }
    const modUrl = `../config.js?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ modUrl);
    return mod.BRIDGE_MAX_MESSAGE_CHARS;
  }

  it("defaults to 4000 when unset", async () => {
    expect(await loadWithEnv(undefined)).toBe(4000);
  });

  it("defaults to 4000 when set but empty", async () => {
    expect(await loadWithEnv("")).toBe(4000);
  });

  it("defaults to 4000 when not a number", async () => {
    expect(await loadWithEnv("lots")).toBe(4000);
  });

  it("honors an explicit numeric value", async () => {
    expect(await loadWithEnv("100")).toBe(100);
    expect(await loadWithEnv("8000")).toBe(8000);
  });

  it("falls back to 4000 for 0 (a zero-char cap is meaningless)", async () => {
    expect(await loadWithEnv("0")).toBe(4000);
  });
});
