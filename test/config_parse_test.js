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
