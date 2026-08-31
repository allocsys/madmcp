import { describe, it, expect } from "vitest";

describe("Env var parsing in config.js", () => {
  function parseEnvVar(val) {
    return (val || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("parses standard comma-separated string", () => {
    expect(parseEnvVar("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles extra whitespace", () => {
    expect(parseEnvVar(" a ,  b , c ")).toEqual(["a", "b", "c"]);
  });

  it("filters empty entries", () => {
    expect(parseEnvVar("a,,b, ,c")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for completely unset/empty string", () => {
    expect(parseEnvVar("")).toEqual([]);
    expect(parseEnvVar(undefined)).toEqual([]);
  });
});
