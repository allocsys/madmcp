import { describe, it, expect } from "vitest";
import {
  stripQualifiers,
  extractRepoQualifier,
  parsePaxHeader,
  parseTar,
} from "../connectors/github/search.js";

describe("stripQualifiers", () => {
  it("removes repo:/filename:/extension: qualifiers, leaving free text", () => {
    expect(stripQualifiers("VLESS filename:worker.js user:dumbCodesOnly")).toBe("VLESS");
  });

  it("removes negated qualifiers", () => {
    expect(stripQualifiers("foo -language:python bar")).toBe("foo bar");
  });

  it("returns an empty string for a qualifier-only query", () => {
    expect(stripQualifiers("repo:owner/name filename:x.js")).toBe("");
  });
});

describe("extractRepoQualifier", () => {
  it("parses a repo: qualifier into owner/repo", () => {
    expect(extractRepoQualifier("foo repo:allocsys/madmcp bar")).toEqual({
      owner: "allocsys",
      repo: "madmcp",
    });
  });

  it("returns null when no repo: qualifier is present", () => {
    expect(extractRepoQualifier("just some terms")).toBeNull();
  });
});

// Builds a single PAX record string ("<len> key=value\n") with the
// self-referential length PAX requires (the length must include its own
// digit count), matching what real tar writers produce.
function buildPaxRecord(kv) {
  const withoutLen = ` ${kv}\n`;
  let len = withoutLen.length + 1;
  while (String(len).length + withoutLen.length !== len) len++;
  return `${len}${withoutLen}`;
}

describe("parsePaxHeader", () => {
  it("parses a single path record", () => {
    const record = buildPaxRecord("path=some/very/long/nested/file.js");
    expect(parsePaxHeader(record)).toEqual({ path: "some/very/long/nested/file.js" });
  });

  it("parses multiple concatenated records", () => {
    const text = buildPaxRecord("path=a/b.txt") + buildPaxRecord("size=123");
    expect(parsePaxHeader(text)).toEqual({ path: "a/b.txt", size: "123" });
  });

  it("returns an empty object for malformed input", () => {
    expect(parsePaxHeader("not a pax header")).toEqual({});
  });
});

// --- tar archive builder for tests ------------------------------------------
function buildTarHeader({ name, size, typeFlag = "0", prefix = "" }) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf-8");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write(typeFlag, 156, "ascii");
  if (prefix) header.write(prefix.slice(0, 155), 345, "utf-8");
  return header;
}

function padTo512(buf) {
  const remainder = buf.length % 512;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - remainder)]);
}

function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const contentBuf = Buffer.from(entry.content ?? "", "utf-8");
    parts.push(buildTarHeader({
      name: entry.name,
      size: contentBuf.length,
      typeFlag: entry.typeFlag ?? "0",
    }));
    parts.push(padTo512(contentBuf));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks mark end-of-archive
  return Buffer.concat(parts);
}

describe("parseTar", () => {
  it("parses a simple regular-file entry", () => {
    const tar = buildTar([{ name: "repo-abc123/README.md", content: "hello world" }]);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("repo-abc123/README.md");
    expect(entries[0].content.toString("utf-8")).toBe("hello world");
  });

  it("parses multiple entries and skips directories", () => {
    const tar = buildTar([
      { name: "repo-abc123/src/", content: "", typeFlag: "5" },
      { name: "repo-abc123/src/index.js", content: "console.log(1)" },
      { name: "repo-abc123/src/util.js", content: "console.log(2)" },
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => e.name)).toEqual([
      "repo-abc123/src/index.js",
      "repo-abc123/src/util.js",
    ]);
  });

  it("applies a GNU 'L' long-name header to the following entry", () => {
    const longName = "repo-abc123/" + "deeply/".repeat(20) + "nested-file.txt";
    const longNameBuf = Buffer.from(longName, "utf-8");
    const parts = [
      buildTarHeader({ name: "", size: longNameBuf.length, typeFlag: "L" }),
      padTo512(longNameBuf),
      buildTarHeader({ name: "ignored-short-name", size: 5, typeFlag: "0" }),
      padTo512(Buffer.from("hello", "utf-8")),
      Buffer.alloc(1024),
    ];
    const entries = parseTar(Buffer.concat(parts));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longName);
    expect(entries[0].content.toString("utf-8")).toBe("hello");
  });

  it("applies a PAX 'x' extended header's path to the following entry", () => {
    const longPath = "repo-abc123/" + "nested/".repeat(15) + "file.txt";
    const paxBuf = Buffer.from(buildPaxRecord(`path=${longPath}`), "utf-8");
    const parts = [
      buildTarHeader({ name: "PaxHeaders/file.txt", size: paxBuf.length, typeFlag: "x" }),
      padTo512(paxBuf),
      buildTarHeader({ name: "short-name.txt", size: 3, typeFlag: "0" }),
      padTo512(Buffer.from("hi!", "utf-8")),
      Buffer.alloc(1024),
    ];
    const entries = parseTar(Buffer.concat(parts));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longPath);
    expect(entries[0].content.toString("utf-8")).toBe("hi!");
  });

  it("returns an empty array for an archive with only the end marker", () => {
    expect(parseTar(Buffer.alloc(1024))).toEqual([]);
  });
});
