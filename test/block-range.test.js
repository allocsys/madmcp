// ---------------------------------------------------------------------------
// test/block-range.test.js
// ---------------------------------------------------------------------------
// Pure anchor/range logic shared by checkpoint replace_block/delete_block and
// notion_update block_edits (connectors/notion/block_range.js). No I/O.

import { describe, it, expect } from "vitest";
import { resolveAnchor, resolveRange, applyLineEdit, contentToLines, isLineNumber } from "../connectors/notion/block_range.js";

const LINES = ["REPO: demo", "STATE", "- Item A", "- Item B", "NEXT", "1. one", "2. two", "NOTES: tail"];

describe("isLineNumber", () => {
  it("treats numbers and digit-only strings as line numbers, not prefixes", () => {
    expect(isLineNumber(3)).toBe(true);
    expect(isLineNumber("3")).toBe(true);
    expect(isLineNumber("1. one")).toBe(false);
    expect(isLineNumber("NEXT")).toBe(false);
  });
});

describe("resolveAnchor", () => {
  it("resolves 1-based line numbers", () => {
    expect(resolveAnchor(LINES, 1)).toBe(0);
    expect(resolveAnchor(LINES, "8")).toBe(7);
  });

  it("rejects out-of-range numbers", () => {
    expect(() => resolveAnchor(LINES, 9, "start")).toThrow(/out of range/);
    expect(() => resolveAnchor(LINES, 0, "start")).toThrow(/out of range/);
  });

  it("resolves a unique prefix", () => {
    expect(resolveAnchor(LINES, "NEXT")).toBe(4);
    expect(resolveAnchor(LINES, "- Item B")).toBe(3);
  });

  it("ignores leading whitespace on the line", () => {
    expect(resolveAnchor(["  indented", "x"], "indent")).toBe(0);
  });

  it("errors on a missing prefix", () => {
    expect(() => resolveAnchor(LINES, "ZZZ", "start")).toThrow(/does not start any line/);
  });

  it("errors on an ambiguous prefix and lists the line numbers", () => {
    expect(() => resolveAnchor(LINES, "- Item", "start")).toThrow(/starts 2 lines \(3, 4\)/);
  });

  it("requires a non-blank anchor", () => {
    expect(() => resolveAnchor(LINES, "  ", "start")).toThrow(/required/);
    expect(() => resolveAnchor(LINES, undefined, "start")).toThrow(/required/);
  });

  it("limits prefix matching to lines at or after `from`", () => {
    const lines = ["- a", "x", "- b"];
    expect(() => resolveAnchor(lines, "- ", "end")).toThrow(/starts 2 lines/);
    expect(resolveAnchor(lines, "- ", "end", { from: 1 })).toBe(2);
  });
});

describe("resolveRange", () => {
  it("defaults end to start", () => {
    expect(resolveRange(LINES, "NEXT")).toEqual({ start: 4, end: 4 });
  });

  it("resolves end after start, so a prefix shared with an earlier line is fine", () => {
    expect(resolveRange(["- a", "x", "- b"], "x", "- ")).toEqual({ start: 1, end: 2 });
  });

  it("rejects end before start", () => {
    expect(() => resolveRange(LINES, 5, 2)).toThrow(/comes before/);
  });
});

describe("contentToLines", () => {
  it("splits on newlines and drops empty lines", () => {
    expect(contentToLines("a\n\nb\n")).toEqual(["a", "b"]);
  });
  it("returns [] for empty or non-string content", () => {
    expect(contentToLines("")).toEqual([]);
    expect(contentToLines(undefined)).toEqual([]);
  });
});

describe("applyLineEdit", () => {
  it("deletes a range when content is empty", () => {
    const r = applyLineEdit(LINES, { start: "NEXT", end: "2. two" });
    expect(r.lines).toEqual(["REPO: demo", "STATE", "- Item A", "- Item B", "NOTES: tail"]);
    expect(r).toMatchObject({ from: 5, to: 7, removed: 3, added: 0 });
  });

  it("overwrites a range with new lines", () => {
    const r = applyLineEdit(LINES, { start: 3, end: 4, content: "- Item X\n- Item Y\n- Item Z" });
    expect(r.lines.slice(2, 5)).toEqual(["- Item X", "- Item Y", "- Item Z"]);
    expect(r).toMatchObject({ removed: 2, added: 3 });
  });

  it("does not mutate the input", () => {
    const copy = [...LINES];
    applyLineEdit(LINES, { start: 1, content: "changed" });
    expect(LINES).toEqual(copy);
  });
});
