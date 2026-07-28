import { describe, it, expect } from "vitest";
import { validateHtml, validateCss, validateJsx, validateVue, validateByExtension } from "../connectors/frontend/validate.js";

describe("validateHtml", () => {
  it("accepts well-formed, properly nested markup", () => {
    const result = validateHtml("<div class=\"card\"><h1>Title</h1><p>Body <strong>text</strong>.</p></div>");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts void elements without closing tags", () => {
    const result = validateHtml('<div><img src="x.png"><br><input type="text"></div>');
    expect(result.valid).toBe(true);
  });

  it("accepts self-closing tags", () => {
    const result = validateHtml('<svg><path d="M0 0" /></svg>');
    expect(result.valid).toBe(true);
  });

  it("flags an unclosed tag", () => {
    const result = validateHtml("<div><p>Hello</div>");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /mismatched|unclosed/i.test(e))).toBe(true);
  });

  it("flags a stray closing tag with no matching open tag", () => {
    const result = validateHtml("<div>Hello</div></div>");
    expect(result.valid).toBe(false);
  });

  it("does not false-positive on tag-like text inside <script>/<style> blocks", () => {
    const result = validateHtml(
      "<div><script>const s = \"<div>\";</script><style>.x::before { content: \"<span>\"; }</style></div>"
    );
    expect(result.valid).toBe(true);
  });

  it("ignores tags inside HTML comments", () => {
    const result = validateHtml("<div><!-- <span> --></div>");
    expect(result.valid).toBe(true);
  });
});

describe("validateCss", () => {
  it("accepts well-formed CSS", () => {
    const result = validateCss(".card { color: red; padding: 4px; } .card:hover { color: blue; }");
    expect(result.valid).toBe(true);
  });

  it("accepts nested SCSS", () => {
    const result = validateCss(".card { .title { font-weight: bold; } &:hover { color: red; } }");
    expect(result.valid).toBe(true);
  });

  it("flags an unclosed brace", () => {
    const result = validateCss(".card { color: red;");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unclosed/i);
  });

  it("flags a stray closing brace", () => {
    const result = validateCss(".card { color: red; } }");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unexpected closing brace/i);
  });

  it("does not false-positive on braces inside string values or comments", () => {
    const result = validateCss('.card::before { content: "{ not real }"; } /* { also not real */');
    expect(result.valid).toBe(true);
  });
});

describe("validateJsx", () => {
  it("accepts a well-formed function component", async () => {
    const result = await validateJsx('function Card({ title }) { return <div className="card"><h1>{title}</h1></div>; }');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags invalid JSX syntax", async () => {
    const result = await validateJsx("function Card() { return <div><h1>Title</div>; }");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts TypeScript + JSX when typescript: true", async () => {
    const result = await validateJsx(
      "interface Props { title: string; }\nfunction Card({ title }: Props) { return <div>{title}</div>; }",
      { typescript: true }
    );
    expect(result.valid).toBe(true);
  });

  it("rejects TypeScript-only syntax when typescript: false", async () => {
    const result = await validateJsx("interface Props { title: string; }\nfunction Card() { return <div />; }", { typescript: false });
    expect(result.valid).toBe(false);
  });
});

describe("validateVue", () => {
  it("accepts a well-formed single-file component", async () => {
    const result = await validateVue(
      '<template><div class="card">{{ title }}</div></template>\n' +
      "<script>export default { props: [\"title\"] };</script>\n" +
      "<style>.card { color: red; }</style>"
    );
    expect(result.valid).toBe(true);
  });

  it("flags a mismatched top-level block", async () => {
    const result = await validateVue('<template><div>{{ title }}</div></template>\n<script>export default {};');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /script/i.test(e))).toBe(true);
  });

  it("flags invalid syntax inside the <script> block", async () => {
    const result = await validateVue(
      "<template><div /></template>\n<script>export default { data() { return { x: } } };</script>"
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("<script> block:"))).toBe(true);
  });
});

describe("validateByExtension", () => {
  it("dispatches .html to validateHtml", async () => {
    const result = await validateByExtension("index.html", "<div><p>ok</div>");
    expect(result.valid).toBe(false);
  });

  it("dispatches .css and .scss to validateCss", async () => {
    expect((await validateByExtension("a.css", ".x { color: red; }")).valid).toBe(true);
    expect((await validateByExtension("a.scss", ".x { .y { color: red; } }")).valid).toBe(true);
  });

  it("dispatches .jsx/.tsx to validateJsx with the right typescript flag", async () => {
    expect((await validateByExtension("a.jsx", "function A() { return <div />; }")).valid).toBe(true);
    expect((await validateByExtension("a.tsx", "const A: () => JSX.Element = () => <div />;")).valid).toBe(true);
  });

  it("dispatches .vue to validateVue", async () => {
    const result = await validateByExtension("A.vue", "<template><div /></template><script>export default {};</script>");
    expect(result.valid).toBe(true);
  });

  it("fails open (valid: true) for an extension with no registered validator", async () => {
    const result = await validateByExtension("a.txt", "anything at all { [ unbalanced");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
