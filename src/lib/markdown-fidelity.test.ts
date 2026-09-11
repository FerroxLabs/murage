// F4-T2 / adopted U-06: the committed round-trip corpus decides which token
// classes may be edited in rich mode. Every assertion reads the exact corpus
// bytes; a failure here means Source mode, never a weaker check.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Editor } from "@tiptap/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  EMPTY_MARKDOWN_DOC,
  MARKDOWN_RICH_EDIT_MAX_BYTES,
  SUPPORTED_MARKDOWN_TOKEN_CLASSES,
  analyzeMarkdownFidelity,
  composeMarkdownDocument,
  createMarkdownExtensions,
  detectNewline,
  markdownTokenClasses,
  roundTripMarkdownBody,
  splitMarkdownDocument,
  type MarkdownFidelityReason,
} from "./markdown-fidelity";

const corpusDir = fileURLToPath(new URL("./__fixtures__/markdown-corpus/", import.meta.url));
interface CorpusEntry { file: string; expect: "rich" | "source"; reasons?: MarkdownFidelityReason[]; note: string }
const manifest = JSON.parse(readFileSync(`${corpusDir}manifest.json`, "utf8")) as { files: CorpusEntry[] };
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

/** What the F4-T1 read contract hands the editor: strict UTF-8, BOM removed. */
function readCorpus(file: string): { bytes: Buffer; bom: boolean; text: string } {
  const bytes = readFileSync(`${corpusDir}${file}`);
  const bom = bytes.subarray(0, 3).equals(BOM_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  return { bytes, bom, text };
}
/** What the F4-T1 write contract puts on disk for `content` + `bom`. */
function writtenBytes(text: string, bom: boolean): Buffer {
  return Buffer.concat([bom ? BOM_BYTES : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}

describe("committed Markdown corpus", () => {
  it("lists every corpus file exactly once and keeps its bytes un-normalized", () => {
    const onDisk = readdirSync(corpusDir).filter(name => name.endsWith(".md")).sort();
    const listed = manifest.files.map(entry => entry.file).sort();
    expect(listed).toEqual(onDisk);
    expect(new Set(listed).size).toBe(listed.length);
    expect(readFileSync(`${corpusDir}.gitattributes`, "utf8")).toMatch(/^\* -text$/m);
    // The byte-level cases the design names are really present.
    expect(readCorpus("rich-crlf-frontmatter-bom.md").bytes.includes("\r\n")).toBe(true);
    expect(readCorpus("rich-crlf-frontmatter-bom.md").bom).toBe(true);
    expect(readCorpus("rich-bom.md").bom).toBe(true);
    expect(detectNewline(readCorpus("source-mixed-newlines.md").text)).toBe("mixed");
    expect(readCorpus("empty.md").bytes.byteLength).toBe(0);
  });

  for (const entry of manifest.files) {
    it(`${entry.file} opens in ${entry.expect} mode (${entry.note})`, () => {
      const { bytes, bom, text } = readCorpus(entry.file);
      const report = analyzeMarkdownFidelity(text);
      expect(report.richEditable).toBe(entry.expect === "rich");
      expect(report.reasons).toEqual(entry.expect === "rich" ? [] : entry.reasons);
      expect(report.bytes).toBe(bytes.byteLength - (bom ? 3 : 0));
      if (entry.expect === "rich") {
        expect(report.unsupportedTokenClasses).toEqual([]);
        const parts = report.parts!;
        // parse -> serialize -> compose reproduces the file byte for byte.
        const { markdown } = roundTripMarkdownBody(parts.body);
        expect(markdown).toBe(parts.body);
        expect(writtenBytes(composeMarkdownDocument(parts, markdown), bom).equals(bytes)).toBe(true);
      } else if (report.parts) {
        // Opening in Source mode without an edit is also byte-identical.
        expect(writtenBytes(composeMarkdownDocument(report.parts, report.parts.body), bom).equals(bytes)).toBe(true);
      } else {
        expect(entry.reasons).toEqual(["mixed-newlines"]);
        expect(writtenBytes(text, bom).equals(bytes)).toBe(true);
      }
      if (entry.reasons?.includes("unsupported-syntax")) expect(report.unsupportedTokenClasses.length).toBeGreaterThan(0);
    });
  }

  it("proves every supported token class on a rich corpus file, and nothing more", () => {
    const seen = new Set<string>();
    for (const entry of manifest.files.filter(item => item.expect === "rich")) {
      for (const name of analyzeMarkdownFidelity(readCorpus(entry.file).text).tokenClasses) seen.add(name);
    }
    expect([...seen].sort()).toEqual([...SUPPORTED_MARKDOWN_TOKEN_CLASSES].sort());
  });

  it("names the class that forced Source mode", () => {
    const unsupported = (file: string) => analyzeMarkdownFidelity(readCorpus(file).text).unsupportedTokenClasses;
    expect(unsupported("source-table.md")).toContain("table");
    expect(unsupported("source-reference-links.md")).toContain("def");
    expect(unsupported("source-html-comment.md")).toContain("html");
    expect(unsupported("source-directive.md")).toEqual(["directive"]);
    expect(unsupported("source-footnote.md")).toContain("footnote");
    expect(unsupported("source-math.md")).toEqual(["math"]);
    expect(unsupported("source-image.md")).toContain("image");
    expect(unsupported("source-tilde-fence.md")).toEqual(["code:tilde"]);
    expect(unsupported("source-indented-code.md")).toEqual(["code:indented"]);
    expect(unsupported("source-setext.md")).toEqual(["heading:setext"]);
    expect(unsupported("source-loose-list.md")).toContain("list:bullet:loose");
    expect(unsupported("source-autolink.md")).toEqual(expect.arrayContaining(["link:autolink", "link:bare"]));
  });
});

describe("opaque parts", () => {
  it("detects newline styles, and a lone CR is mixed", () => {
    expect(detectNewline("")).toBe("none");
    expect(detectNewline("one line")).toBe("none");
    expect(detectNewline("a\nb")).toBe("lf");
    expect(detectNewline("a\r\nb\r\n")).toBe("crlf");
    expect(detectNewline("a\r\nb\n")).toBe("mixed");
    expect(detectNewline("a\rb")).toBe("mixed");
  });

  it("splits frontmatter, blank lines and body losslessly and restores CRLF on compose", () => {
    const text = "---\r\ntitle: x\r\n...\r\n\r\n# Body\r\n\r\ntext\r\n\r\n";
    const parts = splitMarkdownDocument(text)!;
    expect(parts).toEqual({ newline: "crlf", frontmatter: "---\ntitle: x\n...\n", leading: "\n", body: "# Body\n\ntext", trailing: "\n\n" });
    expect(composeMarkdownDocument(parts, parts.body)).toBe(text);
    expect(composeMarkdownDocument(parts, "# Body\n\nedited")).toBe("---\r\ntitle: x\r\n...\r\n\r\n# Body\r\n\r\nedited\r\n\r\n");
    expect(splitMarkdownDocument("a\r\nb\n")).toBeNull();
  });

  it("does not mistake a leading thematic break or an unclosed fence of dashes for frontmatter", () => {
    expect(splitMarkdownDocument("---\n\nprose\n\n---\n")!.frontmatter).toBe("");
    expect(splitMarkdownDocument("---\ntitle: never closed\n\nprose\n")!.frontmatter).toBe("");
    expect(splitMarkdownDocument("---\n---\nbody")!.frontmatter).toBe("---\n---\n");
  });

  it("treats a leading `---` block only as frontmatter when it starts with a YAML key", () => {
    // Prose between two `---` lines is Markdown (a thematic break and a
    // setext heading), not metadata to hide from the rich editor.
    const prose = "---\nIntro paragraph\n\n## Section\ntext\n---\n\nmore";
    expect(splitMarkdownDocument(prose)).toMatchObject({ frontmatter: "", body: prose });
    expect(analyzeMarkdownFidelity(prose)).toMatchObject({ richEditable: false, reasons: ["unsupported-syntax"] });
    expect(splitMarkdownDocument("---\n- a\n- b\n---\nbody")!.frontmatter).toBe("");
    expect(splitMarkdownDocument("---\ntitle: Report\ntags: [a, b]\n---\n\n# Body")).toMatchObject({ frontmatter: "---\ntitle: Report\ntags: [a, b]\n---\n", leading: "\n", body: "# Body" });
    expect(splitMarkdownDocument("---\n\"quoted key\":\n  nested: 1\n...\nbody")!.frontmatter).toBe("---\n\"quoted key\":\n  nested: 1\n...\n");
  });
});

describe("gate limits", () => {
  it("opens an oversized file in Source mode without lexing it, keeping its bytes", () => {
    const paragraph = "A supported paragraph with **strong** text.\n\n";
    const text = paragraph.repeat(Math.ceil((MARKDOWN_RICH_EDIT_MAX_BYTES + 1) / paragraph.length));
    const report = analyzeMarkdownFidelity(text);
    expect(report.bytes).toBeGreaterThan(MARKDOWN_RICH_EDIT_MAX_BYTES);
    // Oversized text is not even split: the size check ends the analysis.
    expect(report).toMatchObject({ richEditable: false, reasons: ["too-large"], tokenClasses: [], parts: null });
    const parts = splitMarkdownDocument(text)!;
    expect(composeMarkdownDocument(parts, parts.body)).toBe(text);
    expect(analyzeMarkdownFidelity(paragraph, { maxRichBytes: 10 }).reasons).toEqual(["too-large"]);
    expect(analyzeMarkdownFidelity(paragraph).richEditable).toBe(true);
  });

  // Regression: `/\n*$/` restarted at every newline of an internal blank-line
  // run (quadratic), and the split ran before the size check, so a bot-written
  // file of blank lines froze the renderer on open. At the lane's measured
  // quadratic rate the 2 MiB case took minutes; linear code takes a few ms.
  it("analyzes long internal blank-line runs in linear time, under and over the size cap", () => {
    const underCap = `# Title\n${"\n".repeat(30_000)}end\n`;
    const twoMiB = `# Title\n${"\n".repeat(2 * 1024 * 1024 - 20)}end\n`;
    const startedAt = performance.now();
    const split = splitMarkdownDocument(twoMiB)!;
    const big = analyzeMarkdownFidelity(twoMiB);
    const small = analyzeMarkdownFidelity(underCap);
    const elapsed = performance.now() - startedAt;
    expect(split).toMatchObject({ frontmatter: "", leading: "", trailing: "\n" });
    expect(split.body).toBe(twoMiB.slice(0, -1));
    expect(big).toMatchObject({ reasons: ["too-large"], parts: null, tokenClasses: [] });
    expect(small.parts!.body).toBe(underCap.slice(0, -1));
    expect(composeMarkdownDocument(small.parts!, small.parts!.body)).toBe(underCap);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(analyzeMarkdownFidelity("👋").bytes).toBe(4);
    expect(analyzeMarkdownFidelity("é").bytes).toBe(2);
  });

  it("lexes with the editor's own tokenizers", () => {
    expect(markdownTokenClasses("- [ ] a")).toEqual(["taskItem", "taskList", "text"]);
    expect(markdownTokenClasses("")).toEqual([]);
    // Blocks nested under a task item live in `nestedTokens`; they are checked too.
    expect(markdownTokenClasses("- [ ] task\n\n  <div>x</div>")).toContain("html");
    expect(analyzeMarkdownFidelity("- [ ] task\n\n  <div>x</div>")).toMatchObject({ richEditable: false, reasons: ["unsupported-syntax"], unsupportedTokenClasses: ["html"] });
    expect(roundTripMarkdownBody("").doc).toEqual(EMPTY_MARKDOWN_DOC);
  });
});

describe("editor extension set", () => {
  const editors: Editor[] = [];
  afterAll(() => { for (const editor of editors) editor.destroy(); });

  it("has no image node, no underline mark and links that never open or auto-create", () => {
    const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions(), content: EMPTY_MARKDOWN_DOC });
    editors.push(editor);
    expect(editor.schema.nodes.image).toBeUndefined();
    expect(editor.schema.marks.underline).toBeUndefined();
    const link = editor.extensionManager.extensions.find(extension => extension.name === "link");
    expect(link?.options).toMatchObject({ openOnClick: false, autolink: false, linkOnPaste: false });
    expect(editor.extensionManager.extensions.some(extension => extension.name === "trailingNode")).toBe(false);
  });

  it("serializes a rich edit of a CRLF + frontmatter + BOM file back into the file's own conventions", () => {
    const { text } = readCorpus("rich-crlf-frontmatter-bom.md");
    const parts = analyzeMarkdownFidelity(text).parts!;
    const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions(), content: parts.body, contentType: "markdown" });
    editors.push(editor);
    editor.commands.command(({ tr }) => {
      tr.insertText(" (edited)", 1 + "Windows file".length + 1 - 1);
      return true;
    });
    const edited = composeMarkdownDocument(parts, editor.getMarkdown());
    expect(edited.startsWith("---\r\ntitle: Windows file\r\n---\r\n\r\n# Windows file (edited)\r\n")).toBe(true);
    expect(edited.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(edited.endsWith("```\r\n")).toBe(true);
  });
});
