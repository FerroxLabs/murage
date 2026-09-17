// Offline proof that saved B09/B10 deliverables open in independent readers
// already on macOS, with one small synthetic artifact per required type built
// in a temp directory: a textutil-written .docx, a stored-ZIP .xlsx, a .csv, a
// pngWithText .png and a saved .js run behind the qualified B10 sandbox. Negative
// controls are corrupted variants of those artifacts and stand-in tools. No
// model output, network, credential or install. No test is skipped: on a host
// without these readers the adapters throw and the tests fail.
import assert from "node:assert/strict";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";

import { harnessPath, inspectDeliverable, inspectDocx, inspectXlsx, parseCsv, pngWithText, readZipEntries, toolsOnPath, type XlsxCell } from "./b09-b10-family-fixture.ts";
import {
  READER_GATES_NOT_ESTABLISHED, compareXlsxCell, csvReaderAgreement, docxReaderAgreement, executeSavedCode, htmlTableRows, parseBmp, pngHeader, pngReaderAgreement, readerTool, runProblems, runReader, xlsxReaderAgreement, type ReaderRun,
} from "./b09-b10-deliverable-readers.ts";
import { qualifyGeneratedCodeSandbox } from "./b10-generated-code-sandbox.ts";
import { B09_CASES } from "./b09-core-families-cases.ts";

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "b09-b10-readers-")));
  try { await body(root); } finally { safeWipeSync(root); }
}

function standIn(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A stored (uncompressed) ZIP built byte by byte, as in the B09 offline test. */
function storedZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), fileName = Buffer.from(name, "utf8"), crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data); centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const size = centrals.reduce((total, part) => total + part.length, 0), count = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", RELS = "http://schemas.openxmlformats.org/package/2006/relationships", OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** Same cells as the B09 offline WORKBOOK: shared and inline strings, a cached SUM and a formula without a cached value. */
const SHEET_PARTS = {
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${OFFICE}"><sheets><sheet name="Summary &amp; totals" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}"><si><t>travel</t></si><si><r><t>sup</t></r><r><t>plies</t></r></si><si><t>total</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>50</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>25</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><f>SUM(B1:B2)</f><v>75</v></c><c r="C3"><f>B3*2</f></c><c r="D3"/><c r="E3" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>`,
};
const WORKBOOK = {
  ...SHEET_PARTS,
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
};

/** Processes whose whole command line is exactly this, so a shell that merely mentions it does not count. */
const running = (command: string) => execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.trim().replace(/^\d+\s+/, "") === command);

// ── Control helpers: negative controls, and the broken readers they must catch ──

type Verdict = { ok: boolean; problems: string[] };

/** A negative control: the verdict must reject, with every expected problem present. */
function assertRejects(verdict: Verdict, expected: readonly RegExp[], label: string): void {
  assert.equal(verdict.ok, false, `${label} was accepted: ${JSON.stringify(verdict.problems)}`);
  for (const pattern of expected) assert.ok(verdict.problems.some((problem) => pattern.test(problem)), `${label} lacks ${String(pattern)}: ${JSON.stringify(verdict.problems)}`);
}

/** The same negative control must FAIL against a broken reader, comparator or adapter; a control that passes there could not catch one. */
function assertControlCatches(verdict: Verdict, expected: readonly RegExp[], label: string): void {
  assert.throws(() => assertRejects(verdict, expected, label), assert.AssertionError, `${label}: the negative control passed against a broken reader`);
}

/** A verdict forced to ok:true with no problems. Passing it to assertControlCatches is a helper self-check (assertRejects refuses an accepted verdict), not evidence about any adapter;
 * the adapter kills are the deepEqual assertions on real adapters with one-change stand-ins. */
const alwaysAgreeing = <T extends Verdict>(verdict: T): T => ({ ...verdict, ok: true, problems: [] });

/** The minimal package shape of the B09 offline WORKBOOK: no _rels/.rels and only the workbook content-type override. */
const MINIMAL_CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;

const sheetXml = (rows: string) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`;
/** The independent reviewer's xlsx probe rows (t3-verify/mutate.ts): plain shared strings travel, supplies, total and a cached SUM. */
const PROBE_ROWS = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>50</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>25</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><f>SUM(B1:B2)</f><v>75</v></c></row>`;
const probeWorkbook = (rows: string) => storedZip({ ...WORKBOOK, "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}"><si><t>travel</t></si><si><t>supplies</t></si><si><t>total</t></si></sst>`, "xl/worksheets/sheet1.xml": sheetXml(rows) });
/** The reviewer's false-negative probe shape (t3-verify/falseneg.ts): inline strings only, no sharedStrings part. */
const inlineWorkbook = (rows: string) => storedZip({
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  "_rels/.rels": WORKBOOK["_rels/.rels"],
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${OFFICE}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": sheetXml(rows),
});

/** A Quick Look-style HTML preview table of plain-text cells. */
const previewHtml = (rows: ReadonlyArray<readonly string[]>) => `<html><body><table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table></body></html>`;

type Rgb = readonly [number, number, number];
/** A top-down 24-bit BMP, the format the sips stand-in "decodes" to. */
function bmp(rows: ReadonlyArray<readonly Rgb[]>): Buffer {
  const width = rows[0]!.length, height = rows.length, stride = Math.floor((24 * width + 31) / 32) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write("BM", 0, "ascii"); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(-height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  rows.forEach((row, y) => row.forEach(([r, g, b], x) => { const at = 54 + y * stride + x * 3; bytes[at] = b; bytes[at + 1] = g; bytes[at + 2] = r; }));
  return bytes;
}
const UNIFORM_1X1 = bmp([[[32, 64, 160]]]), TWO_COLOURS_2X1 = bmp([[[255, 255, 255], [0, 0, 0]]]), FOUR_2X2 = bmp([[[1, 2, 3], [4, 5, 6]], [[7, 8, 9], [10, 11, 12]]]);

/** A sips stand-in: `-g …` reports a PNG of the given size; `-s format bmp <file> --out <path>` copies the prepared BMP there, or writes nothing. */
function sipsStandIn(root: string, name: string, reported: { width: number; height: number }, decoded: Buffer | undefined): string {
  const source = join(root, `${name}.bmp`);
  if (decoded) writeFileSync(source, decoded);
  return standIn(root, name, [
    "case \"$1\" in",
    `  -g) echo "$7"; echo "  format: png"; echo "  pixelWidth: ${reported.width}"; echo "  pixelHeight: ${reported.height}";;`,
    `  -s) ${decoded ? `/bin/cp '${source}' "$6"` : ":"};;`,
    "  *) echo \"unexpected sips arguments: $*\" >&2; exit 64;;",
    "esac",
  ].join("\n"));
}

/** A qlmanage stand-in that reports success for `-t` (thumbnail) and `-p` (HTML preview) and copies the prepared output, or writes nothing for an omitted one. */
function quickLookStandIn(root: string, name: string, output: { preview?: ReadonlyArray<readonly string[]>; thumbnail?: boolean }): string {
  const html = join(root, `${name}.html`), png = join(root, `${name}.png`);
  if (output.preview) writeFileSync(html, previewHtml(output.preview));
  if (output.thumbnail) writeFileSync(png, "thumbnail bytes that only the sips stand-in reads");
  return standIn(root, name, [
    "case \"$1\" in",
    `  -t) ${output.thumbnail ? `/bin/cp '${png}' "$5/$(/usr/bin/basename "$6").png"` : ":"}; echo "* $6 produced one thumbnail";;`,
    `  -p) /bin/mkdir -p "$3/$(/usr/bin/basename "$4").qlpreview"; ${output.preview ? `/bin/cp '${html}' "$3/$(/usr/bin/basename "$4").qlpreview/Preview.html"` : ":"}; echo "* $4 produced a preview with data of type public.html";;`,
    "  *) echo \"unexpected qlmanage arguments: $*\" >&2; exit 64;;",
    "esac",
  ].join("\n"));
}

/** The PNG with its IDAT payload overwritten and the chunk CRC recomputed: the header still reads 1x1, the pixels do not decode. */
function corruptIdat(png: Buffer): Buffer {
  const at = png.indexOf(Buffer.from("IDAT", "ascii")), length = png.readUInt32BE(at - 4);
  const corrupt = Buffer.from(png);
  corrupt.fill(0xff, at + 4, at + 4 + length);
  corrupt.writeUInt32BE(crc32(corrupt.subarray(at, at + 4 + length)) >>> 0, at + 4 + length);
  return corrupt;
}

const cell = (ref: string, value: string | undefined, type?: string, formula?: string): XlsxCell => ({ ref, ...(type ? { type } : {}), ...(value !== undefined ? { value } : {}), ...(formula ? { formula } : {}) });

test("readers fail closed: an unsupported host or a missing tool throws before reading, and stand-in tools that exit 0 silently, report on stderr, hang or flood are rejected", async () => {
  await withRoot(async (root) => {
    const absent = join(root, "absent-tool");
    assert.throws(() => readerTool("textutil", { platform: "linux" }), /DELIVERABLE_READER_UNAVAILABLE: textutil is a macOS reader and this host is linux/);
    const file = join(root, "note.docx");
    writeFileSync(file, "not yet a document");
    await assert.rejects(docxReaderAgreement(file, root, { platform: "darwin", tools: { textutil: absent } }), /DELIVERABLE_READER_UNAVAILABLE: textutil at .*absent-tool is not an executable file/);
    await assert.rejects(xlsxReaderAgreement(file, root, { platform: "darwin", tools: { qlmanage: absent } }), /DELIVERABLE_READER_UNAVAILABLE: qlmanage/);
    await assert.rejects(csvReaderAgreement(file, root, { platform: "darwin", tools: { qlmanage: absent } }), /DELIVERABLE_READER_UNAVAILABLE: qlmanage/);
    await assert.rejects(pngReaderAgreement(file, root, { platform: "win32" }), /DELIVERABLE_READER_UNAVAILABLE: sips is a macOS reader/);
    await assert.rejects(pngReaderAgreement(file, root, { platform: "darwin", tools: { sips: root } }), /DELIVERABLE_READER_UNAVAILABLE: sips at .* is not an executable file/);

    const silent = standIn(root, "silent", "exit 0");
    const quiet = await docxReaderAgreement(file, root, { platform: "darwin", tools: { textutil: silent } });
    assert.equal(quiet.ok, false);
    assert.ok(quiet.problems.some((problem) => /not a readable ZIP package/.test(problem)), JSON.stringify(quiet.problems));
    const docx = storedZip({ "[Content_Types].xml": `<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, "word/document.xml": "<w:document><w:t>Ship Friday</w:t></w:document>" });
    writeFileSync(file, docx);
    assert.equal((await inspectDocx(docx)).ok, true);
    assert.deepEqual((await docxReaderAgreement(file, root, { platform: "darwin", tools: { textutil: silent } })).problems, ["textutil produced no text (it exits 0 on unreadable input)"]);
    const complaining = standIn(root, "complaining", "echo 'Ship Friday'; echo 'Error reading note.docx.' >&2; exit 0");
    assert.deepEqual((await docxReaderAgreement(file, root, { platform: "darwin", tools: { textutil: complaining } })).problems, ["textutil reported on stderr: Error reading note.docx."]);
    const quietLook = await xlsxReaderAgreement(file, root, { platform: "darwin", tools: { qlmanage: silent, sips: silent } });
    assert.equal(quietLook.ok, false);
    assert.ok(quietLook.problems.includes("thumbnail: Quick Look reported no thumbnail") && quietLook.problems.some((problem) => problem.startsWith("preview: Quick Look produced no HTML preview")), JSON.stringify(quietLook.problems));

    const marker = "29.4817";
    const hanging = standIn(root, "hanging", `trap '' TERM HUP INT\n/bin/sleep ${marker} &\nwait`);
    const hang = await runReader(hanging, [], { deadlineMs: 700, maxOutputBytes: 1024, tmpDir: root });
    assert.deepEqual({ timedOut: hang.timedOut, signal: hang.signal, groupGone: hang.groupGone }, { timedOut: true, signal: "SIGKILL", groupGone: true });
    assert.deepEqual(running(`/bin/sleep ${marker}`), []);
    const flooding = standIn(root, "flooding", "while :; do echo 0123456789abcdef; done");
    const flood = await runReader(flooding, [], { deadlineMs: 5_000, maxOutputBytes: 1024, tmpDir: root });
    assert.deepEqual({ overflow: flood.overflow, timedOut: flood.timedOut, groupGone: flood.groupGone }, { overflow: true, timedOut: false, groupGone: true });
    assert.ok(Buffer.byteLength(flood.stdout) <= 1024);
  });
});

test("the preview table and BMP readers used by the adapters parse what they are given, and nothing else", () => {
  assert.deepEqual(htmlTableRows(`<table><tr><td class="s0">a &amp; b</td><td><p>50</p></td></tr><tr><td> </td><td>x&#39;y</td></tr></table>`), [["a & b", "50"], [" ", "x'y"]]);
  assert.deepEqual(htmlTableRows("<p>no table</p>"), []);
  const bmp = Buffer.alloc(58);
  bmp.write("BM", 0, "ascii"); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(-1, 22); bmp.writeUInt16LE(24, 28);
  bmp[54] = 160; bmp[55] = 64; bmp[56] = 32;
  assert.deepEqual(parseBmp(bmp), { problems: [], image: { width: 1, height: 1, bitsPerPixel: 24, distinctPixels: 1, topLeftPixel: { r: 32, g: 64, b: 160 } } });
  assert.deepEqual(parseBmp(bmp.subarray(0, 40)).problems, ["the decoded image is not a BMP"]);
  assert.deepEqual(parseBmp(bmp.subarray(0, 56)).problems, ["the decoded pixel data is truncated"]);
  assert.deepEqual(pngHeader(pngWithText("Comment", "x")), { width: 1, height: 1 });
  assert.equal(pngHeader(Buffer.from("not a png at all, just bytes")), undefined);
});

test("a textutil-written .docx is read back by textutil as DOCX and its text matches the yauzl package inspection; unreadable bytes fail", async (t) => {
  await withRoot(async (root) => {
    const input = join(root, "note.txt"), file = join(root, "note.docx");
    writeFileSync(input, "We aim to ship Friday if QA passes.\n\nMobile stays out of scope.\n");
    execFileSync(readerTool("textutil"), ["-convert", "docx", "-output", file, input], { stdio: "ignore", timeout: 30_000 });
    const agreement = await docxReaderAgreement(file, root);
    t.diagnostic(JSON.stringify({ ok: agreement.ok, problems: agreement.problems, readerText: agreement.readerText, packageText: agreement.packageText, runs: agreement.runs.map(({ exitCode, stderr, timedOut, groupGone, elapsedMs }) => ({ exitCode, stderr, timedOut, groupGone, elapsedMs })) }));
    assert.deepEqual(agreement.problems, []);
    assert.equal(agreement.ok, true);
    assert.match(agreement.readerText, /We aim to ship Friday if QA passes\.\s+Mobile stays out of scope\./);
    assert.equal(agreement.packageText.replace(/\s+/g, ""), "WeaimtoshipFridayifQApasses.Mobilestaysoutofscope.");

    const garbage = join(root, "garbage.docx");
    writeFileSync(garbage, "We aim to ship Friday if QA passes.\n");
    const refused = await docxReaderAgreement(garbage, root);
    t.diagnostic(JSON.stringify({ garbage: refused.problems }));
    assert.equal(refused.ok, false);
    assert.ok(refused.problems.some((problem) => problem.startsWith("package: not a readable ZIP package")), JSON.stringify(refused.problems));
    assert.ok(refused.problems.some((problem) => /^textutil reported on stderr: Error reading .*garbage\.docx/.test(problem)), JSON.stringify(refused.problems));
  });
});

test("a stored-ZIP .xlsx renders in Quick Look as a decodable non-uniform thumbnail and a preview with the package's cached cells; formula calculation stays NOT ESTABLISHED; a package yauzl accepts but Quick Look cannot open fails", async (t) => {
  await withRoot(async (root) => {
    const file = join(root, "expenses.xlsx");
    writeFileSync(file, storedZip(WORKBOOK));
    const agreement = await xlsxReaderAgreement(file, root);
    t.diagnostic(JSON.stringify({ ok: agreement.ok, problems: agreement.problems, thumbnail: agreement.thumbnail, renderedRows: agreement.renderedRows, uncachedFormulas: agreement.uncachedFormulas, runs: agreement.runs.map(({ tool, exitCode, stderr, timedOut, groupGone, elapsedMs }) => ({ tool, exitCode, stderr, timedOut, groupGone, elapsedMs })) }));
    assert.deepEqual(agreement.problems, []);
    assert.equal(agreement.ok, true);
    assert.ok(agreement.thumbnail && agreement.thumbnail.width > 0 && agreement.thumbnail.height > 0 && agreement.thumbnail.distinctPixels > 1, JSON.stringify(agreement.thumbnail));
    assert.deepEqual(agreement.renderedRows, [["travel", "50"], ["supplies", "25"], ["total", "75", " ", " ", "note"]]);
    // The cached SUM renders as 75; B3*2 has no cached value and renders blank: Quick Look does not calculate.
    assert.deepEqual(agreement.uncachedFormulas, [{ ref: "C3", formula: "B3*2", rendered: "" }]);
    assert.match(agreement.formulaCalculation, /^NOT ESTABLISHED: no calculation engine/);

    // The B09 offline test's minimal package (no _rels/.rels or part overrides) passes inspectXlsx, yet Quick Look cannot open it.
    const minimal = join(root, "minimal.xlsx");
    const minimalBytes = storedZip({ ...SHEET_PARTS, "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`, "xl/_rels/workbook.xml.rels": WORKBOOK["xl/_rels/workbook.xml.rels"] });
    writeFileSync(minimal, minimalBytes);
    assert.equal((await inspectXlsx(minimalBytes)).ok, true);
    // RESTART-T2: the relationship requirement that inspectDeliverable and the reader adapter turn on refuses it before any reader runs.
    assert.deepEqual((await inspectXlsx(minimalBytes, { requirePackageRelationships: true })).problems, ["_rels/.rels is missing, so no package relationship leads a reader to xl/workbook.xml"]);
    assert.equal((await inspectDeliverable("outputs/minimal.xlsx", minimalBytes)).ok, false);
    const refused = await xlsxReaderAgreement(minimal, root, { deadlineMs: 4_000 });
    t.diagnostic(JSON.stringify({ minimal: refused.problems, runs: refused.runs.map(({ tool, exitCode, signal, timedOut, groupGone, elapsedMs }) => ({ tool, exitCode, signal, timedOut, groupGone, elapsedMs })) }));
    assert.equal(refused.ok, false);
    assert.ok(refused.problems.includes("package: _rels/.rels is missing, so no package relationship leads a reader to xl/workbook.xml"), JSON.stringify(refused.problems));
    assert.ok(refused.problems.some((problem) => problem.startsWith("preview: Quick Look produced no HTML preview")), JSON.stringify(refused.problems));
    assert.ok(refused.runs.every((run) => run.groupGone), "every reader process group is gone");
  });
});

test("a saved .csv is previewed by Quick Look as the same rows parseCsv reads", async (t) => {
  await withRoot(async (root) => {
    const file = join(root, "totals.csv");
    const text = "category,amount (USD)\r\ntravel,50\n\"supplies, office\",25\ntotal,75\n";
    writeFileSync(file, text);
    const agreement = await csvReaderAgreement(file, root);
    t.diagnostic(JSON.stringify({ ok: agreement.ok, problems: agreement.problems, renderedRows: agreement.renderedRows }));
    assert.deepEqual(agreement.problems, []);
    assert.equal(agreement.ok, true);
    assert.deepEqual(agreement.renderedRows, parseCsv(text).rows);
    assert.deepEqual(agreement.renderedRows, [["category", "amount (USD)"], ["travel", "50"], ["supplies, office", "25"], ["total", "75"]]);
  });
});

test("the Creator reference .png from pngWithText is pixel-decoded by sips as 1x1 with its IDAT colour; a PNG whose header survives but pixels do not fails", async (t) => {
  await withRoot(async (root) => {
    const file = join(root, "reference.png");
    const png = pngWithText("Comment", "B10-CR4-canary: teal crackle glaze");
    writeFileSync(file, png);
    const agreement = await pngReaderAgreement(file, root);
    t.diagnostic(JSON.stringify({ ok: agreement.ok, problems: agreement.problems, header: agreement.header, image: agreement.image }));
    assert.deepEqual(agreement.problems, []);
    assert.deepEqual(agreement.image, { format: "png", width: 1, height: 1, bitsPerPixel: 24, distinctPixels: 1, topLeftPixel: { r: 32, g: 64, b: 160 } });

    const at = png.indexOf(Buffer.from("IDAT", "ascii")), length = png.readUInt32BE(at - 4);
    const corrupt = Buffer.from(png);
    corrupt.fill(0xff, at + 4, at + 4 + length);
    corrupt.writeUInt32BE(crc32(corrupt.subarray(at, at + 4 + length)) >>> 0, at + 4 + length);
    const broken = join(root, "reference-corrupt.png");
    writeFileSync(broken, corrupt);
    const refused = await pngReaderAgreement(broken, root);
    t.diagnostic(JSON.stringify({ corrupt: refused.problems, header: refused.header }));
    assert.deepEqual(refused.header, { width: 1, height: 1 });
    assert.equal(refused.ok, false);
    assert.ok(refused.problems.some((problem) => /^sips pixel decode (exited|reported on stderr)/.test(problem)), JSON.stringify(refused.problems));
  });
});

test("a saved .js deliverable executes only through the qualified B10 sandbox", async (t) => {
  await withRoot(async (root) => {
    const marker = "__murage_saved_code_executed";
    const file = join(root, "add.js");
    writeFileSync(file, `\`\`\`js\nglobalThis.${marker} = true;\nfunction add(a, b) { return a + b; }\n\`\`\`\n`);
    assert.throws(() => executeSavedCode(file, "add", [[2, 3]]), /GENERATED_CODE_SANDBOX_REQUIRED/);
    assert.equal(Reflect.get(globalThis, marker), undefined);
    const sandbox = await qualifyGeneratedCodeSandbox();
    const evaluation = await executeSavedCode(file, "add", [[2, 3], [-2, 3]], sandbox);
    t.diagnostic(JSON.stringify(evaluation));
    assert.deepEqual(evaluation, { loaded: true, results: [{ args: [2, 3], value: 5 }, { args: [-2, 3], value: 1 }] });
    assert.equal(Reflect.get(globalThis, marker), undefined);
  });
});

test("gates that no offline reader here establishes stay explicit", () => {
  assert.deepEqual(toolsOnPath(["soffice", "libreoffice"], harnessPath()), { soffice: null, libreoffice: null });
  assert.equal(B09_CASES.some((item) => String(item.deliverable?.extension) === ".pptx"), false);
  for (const [gate, text] of Object.entries(READER_GATES_NOT_ESTABLISHED)) assert.match(text, /^NOT ESTABLISHED: /, gate);
  assert.deepEqual(Object.keys(READER_GATES_NOT_ESTABLISHED).sort(), ["booleanRendering", "formulaCalculation", "layoutFidelity", "modelOutputs", "multiSheetWorkbooks", "numberFormats", "pptx", "runnerWiring", "savedCodeBeyondPlainJs", "trackedChanges", "unsandboxedReaders"]);
  assert.match(READER_GATES_NOT_ESTABLISHED.pptx, /open rather than unnecessary/);
});

// ── RESTART-T2 reader controls ─────────────────────────────────────────────

test("positive controls: valid workbooks with cached numbers written as 3.10 and 75.0, boolean cells and a cached formula value are accepted by cell type, not by text", async (t) => {
  await withRoot(async (root) => {
    const file = join(root, "typed.xlsx");
    const bytes = inlineWorkbook(`<row r="1"><c r="A1" t="inlineStr"><is><t>paid</t></is></c><c r="B1" t="b"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>total</t></is></c><c r="B2"><v>75.0</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>rate</t></is></c><c r="B3"><v>3.10</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>refunded</t></is></c><c r="B4" t="b"><v>0</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>sum</t></is></c><c r="B5"><f>B2+B3</f><v>78.10</v></c></row>`);
    writeFileSync(file, bytes);
    const inspection = await inspectXlsx(bytes, { requirePackageRelationships: true });
    assert.deepEqual(inspection.problems, []);
    const cells = Object.fromEntries(inspection.sheets[0]!.cells.map((item) => [item.ref, item]));
    assert.deepEqual([cells.B1, cells.B2, cells.B3, cells.B4, cells.B5], [{ ref: "B1", type: "b", value: "1" }, { ref: "B2", value: "75.0" }, { ref: "B3", value: "3.10" }, { ref: "B4", type: "b", value: "0" }, { ref: "B5", value: "78.10", formula: "B2+B3" }]);
    const agreement = await xlsxReaderAgreement(file, root, { deadlineMs: 6_000 });
    t.diagnostic(JSON.stringify({ ok: agreement.ok, problems: agreement.problems, renderedRows: agreement.renderedRows, unrenderedBooleans: agreement.unrenderedBooleans, uncachedFormulas: agreement.uncachedFormulas, thumbnail: agreement.thumbnail }));
    assert.deepEqual(agreement.problems, []);
    assert.equal(agreement.ok, true);
    // The reported false rejections: Quick Look shows 75 and 3.1 for the package's 75.0 and 3.10, which agree only as numbers.
    assert.deepEqual(agreement.renderedRows[1], ["total", "75"]);
    assert.deepEqual(agreement.renderedRows[2], ["rate", "3.1"]);
    assert.equal(Number(agreement.renderedRows[4]?.[1]), 78.1);
    assert.deepEqual(agreement.uncachedFormulas, []);
    for (const [ref, row, display] of [["B1", 0, "TRUE"], ["B4", 3, "FALSE"]] as const) {
      const rendered = agreement.renderedRows[row]?.[1] ?? "";
      assert.ok(rendered === display || agreement.unrenderedBooleans.some((item) => item.ref === ref && item.display === display), `${ref} rendered ${JSON.stringify(rendered)}: ${JSON.stringify(agreement.unrenderedBooleans)}`);
    }
    assert.ok(agreement.unrenderedBooleans.every((item) => item.ref === "B1" || item.ref === "B4"), JSON.stringify(agreement.unrenderedBooleans));
  });
});

test("cell comparison follows the cell type (numbers by value, booleans as TRUE/FALSE, text exactly); its negative table fails against always-agreeing, text-as-number and any-boolean comparators", () => {
  const agreements: Array<[XlsxCell, string]> = [
    [cell("B1", "3.10"), "3.1"], [cell("B2", "75.0"), "75"], [cell("B3", "75", "n"), " 75 "], [cell("B4", "-0.50"), "-0.5"], [cell("B5", "1E3"), "1000"],
    [cell("C1", "1", "b"), "TRUE"], [cell("C2", "0", "b"), "FALSE"],
    [cell("A1", "3.10", "s"), "3.10"], [cell("A2", "note", "inlineStr"), " note "], [cell("A3", "75.0", "str", "TEXT(B2,\"0.0\")"), "75.0"],
    [cell("D1", "78.10", undefined, "B2+B3"), "78.1"], [cell("E1", "#DIV/0!", "e", "1/0"), "#DIV/0!"], [cell("F1", undefined), " "],
  ];
  for (const [item, rendered] of agreements) assert.deepEqual(compareXlsxCell(item, rendered), { agrees: true }, `${item.ref} ${JSON.stringify(rendered)}`);
  assert.deepEqual(compareXlsxCell(cell("C3", "1", "b"), ""), { agrees: true, unrenderedBoolean: "TRUE" });
  assert.deepEqual(compareXlsxCell(cell("C4", "0", "b"), " "), { agrees: true, unrenderedBoolean: "FALSE" });

  const negatives: Array<[XlsxCell, string, RegExp]> = [
    [cell("A1", "3.10", "s"), "3.1", /^A1: the package holds the text "3\.10" but Quick Look rendered "3\.1"$/],
    [cell("A2", "75.0", "inlineStr"), "75", /^A2: the package holds the text "75\.0" but Quick Look rendered "75"$/],
    [cell("A3", "007", "str", "TEXT(7,\"000\")"), "7", /^A3: the package holds the text "007" but Quick Look rendered "7"$/],
    [cell("B1", "3.10"), "3.11", /^B1: the package holds the number 3\.10 but Quick Look rendered "3\.11"$/],
    [cell("B2", "75.0"), "75 USD", /^B2: the package holds the number 75\.0 but Quick Look rendered "75 USD"$/],
    [cell("B3", "abc"), "abc", /^B3: the package's numeric cell holds "abc", which is not a number$/],
    [cell("C1", "1", "b"), "FALSE", /^C1: the package holds the boolean TRUE but Quick Look rendered "FALSE"$/],
    [cell("C2", "1", "b"), "1", /^C2: the package holds the boolean TRUE but Quick Look rendered "1"$/],
    [cell("C3", "yes", "b"), "TRUE", /^C3: the package's boolean cell holds "yes", which is neither 0 nor 1$/],
    [cell("D1", "78.10", undefined, "B2+B3"), "78", /^D1: the package holds the number 78\.10 but Quick Look rendered "78"$/],
    [cell("F1", undefined), "stray", /^F1: the package holds an empty n cell but Quick Look rendered "stray"$/],
    [cell("G1", "2026-09-15", "d"), "2026-09-15", /^G1: cell type "d" is not compared by this reader$/],
  ];
  const assertNegatives = (compare: typeof compareXlsxCell) => {
    for (const [item, rendered, expected] of negatives) {
      const comparison = compare(item, rendered);
      assert.equal(comparison.agrees, false, `${item.ref} ${JSON.stringify(rendered)} was accepted`);
      assert.match("problem" in comparison ? comparison.problem : "", expected);
    }
  };
  assertNegatives(compareXlsxCell);
  const alwaysAgrees: typeof compareXlsxCell = () => ({ agrees: true });
  const textAsNumber: typeof compareXlsxCell = (item, rendered) => (/^[\d.]+$/.test(item.value ?? "") && Number(item.value) === Number(rendered.trim()) ? { agrees: true } : compareXlsxCell(item, rendered));
  const anyBoolean: typeof compareXlsxCell = (item, rendered) => (item.type === "b" ? { agrees: true } : compareXlsxCell(item, rendered));
  for (const [label, broken] of [["always agrees", alwaysAgrees], ["text as number", textAsNumber], ["any boolean", anyBoolean]] as const) assert.throws(() => assertNegatives(broken), assert.AssertionError, label);
  // The pre-restart comparison (trimmed text equality) fails the positive table: that was the reported false rejection.
  const textEquality: typeof compareXlsxCell = (item, rendered) => ((item.value ?? "").trim() === rendered.trim() ? { agrees: true } : { agrees: false, problem: `${item.ref}: text differs` });
  assert.deepEqual(agreements.filter(([item, rendered]) => !textEquality(item, rendered).agrees).map(([item]) => item.ref), ["B1", "B2", "B4", "B5", "C1", "C2", "D1"]);
});

test("inspectXlsx refuses an out-of-range shared-string index, and a package without its workbook relationship whenever inspectDeliverable or a reader requires it; the lenient inspection fails that control", async () => {
  const outOfRange = await inspectXlsx(probeWorkbook(PROBE_ROWS.replace('<c r="A1" t="s"><v>0</v>', '<c r="A1" t="s"><v>9</v>')));
  assert.deepEqual(outOfRange.problems, ['sheet "Summary & totals" cell A1 has shared-string index "9", outside the 3 shared strings']);
  assert.equal(outOfRange.ok, false);
  for (const index of ["-1", "1.5", "x", "3"]) assert.equal((await inspectXlsx(probeWorkbook(PROBE_ROWS.replace('<c r="A1" t="s"><v>0</v>', `<c r="A1" t="s"><v>${index}</v>`)))).ok, false, index);
  assert.deepEqual((await inspectXlsx(probeWorkbook(PROBE_ROWS), { requirePackageRelationships: true })).problems, []);

  const unrelated = storedZip(Object.fromEntries(Object.entries(WORKBOOK).filter(([name]) => name !== "_rels/.rels")));
  const missing = [/^_rels\/\.rels is missing, so no package relationship leads a reader to xl\/workbook\.xml$/];
  assertRejects(await inspectXlsx(unrelated, { requirePackageRelationships: true }), missing, "workbook without _rels/.rels");
  assertRejects(await inspectDeliverable("outputs/expenses.xlsx", unrelated), missing, "inspectDeliverable of a workbook without _rels/.rels");
  // The default stays lenient only for the root-owned B09 offline WORKBOOK: as an inspector for this control it is broken, and the control catches it.
  assertControlCatches(await inspectXlsx(unrelated), missing, "lenient inspection of a workbook without _rels/.rels");
  const elsewhere = storedZip({ ...WORKBOOK, "_rels/.rels": WORKBOOK["_rels/.rels"].replace('Target="xl/workbook.xml"', 'Target="xl/other.xml"') });
  assert.deepEqual((await inspectXlsx(elsewhere, { requirePackageRelationships: true })).problems, ["_rels/.rels has no officeDocument relationship to xl/workbook.xml"]);
  const absolute = storedZip({ ...WORKBOOK, "_rels/.rels": WORKBOOK["_rels/.rels"].replace('Target="xl/workbook.xml"', 'Target="/xl/workbook.xml"') });
  assert.deepEqual((await inspectXlsx(absolute, { requirePackageRelationships: true })).problems, []);
});

test("negative controls for .docx: a malformed document part is refused by textutil, and disagreeing, failed and hung reader results are refused; the malformed control fails against a textutil stub that returns the expected text, the others against a clean agreeing stub, with helper self-checks on always-agreeing verdicts", async (t) => {
  await withRoot(async (root) => {
    const input = join(root, "note.txt"), written = join(root, "note.docx");
    writeFileSync(input, "We aim to ship Friday if QA passes.\n\nMobile stays out of scope.\n");
    execFileSync(readerTool("textutil"), ["-convert", "docx", "-output", written, input], { stdio: "ignore", timeout: 30_000 });
    const entries = Object.fromEntries(await readZipEntries(readFileSync(written)));
    const documentXml = entries["word/document.xml"]!.toString("utf8");
    const malformedXml = documentXml.replace(/<\/w:body>[\s\S]*$/, "");
    assert.notEqual(malformedXml, documentXml);
    const malformed = join(root, "malformed.docx");
    writeFileSync(malformed, storedZip({ ...entries, "word/document.xml": malformedXml }));
    const unreadable = [/^textutil reported on stderr: Error reading .*malformed\.docx/];
    const refused = await docxReaderAgreement(malformed, root);
    t.diagnostic(JSON.stringify({ malformed: refused.problems }));
    assertRejects(refused, unreadable, "malformed docx");
    assert.deepEqual((await inspectDocx(readFileSync(malformed))).problems, [], "the package inspection alone accepts it; only the independent reader refuses it");
    const echoing = standIn(root, "textutil-echo", "printf 'We aim to ship Friday if QA passes.\\n\\nMobile stays out of scope.\\n'");
    const stubbed = await docxReaderAgreement(malformed, root, { tools: { textutil: echoing } });
    assert.deepEqual(stubbed.problems, []);
    assertControlCatches(stubbed, unreadable, "malformed docx read by a textutil stub that returns the expected text");
    assertControlCatches(alwaysAgreeing(refused), unreadable, "malformed docx (helper self-check: assertRejects refuses an always-agreeing verdict)");

    const file = join(root, "ship.docx");
    writeFileSync(file, storedZip({ "[Content_Types].xml": `<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, "word/document.xml": "<w:document><w:t>Ship Friday</w:t></w:document>" }));
    const disagreeing = await docxReaderAgreement(file, root, { tools: { textutil: standIn(root, "textutil-other-text", "echo 'Ship Monday'") } });
    assert.deepEqual(disagreeing.problems, ["textutil text differs from the package text"]);
    const failed = await docxReaderAgreement(file, root, { tools: { textutil: standIn(root, "textutil-exit-3", "echo 'Ship Friday'\nexit 3") } });
    assert.deepEqual(failed.problems, ["textutil exited 3"]);
    const marker = "27.3619";
    const hung = await docxReaderAgreement(file, root, { tools: { textutil: standIn(root, "textutil-hang", `trap '' TERM HUP INT\n/bin/sleep ${marker} &\nwait`) }, deadlineMs: 700 });
    assert.deepEqual(hung.problems, ["textutil exceeded the 700 ms deadline and its process group was SIGKILLed"]);
    assert.deepEqual(hung.runs.map(({ timedOut, signal, groupGone }) => ({ timedOut, signal, groupGone })), [{ timedOut: true, signal: "SIGKILL", groupGone: true }]);
    assert.deepEqual(running(`/bin/sleep ${marker}`), []);
    const agreeing = await docxReaderAgreement(file, root, { tools: { textutil: standIn(root, "textutil-agrees", "echo 'Ship Friday'") } });
    assert.deepEqual(agreeing.problems, []);
    for (const [label, verdict, expected] of [["disagreeing text", disagreeing, /^textutil text differs from the package text$/], ["non-zero exit", failed, /^textutil exited 3$/], ["hang", hung, /^textutil exceeded the 700 ms deadline/]] as const) {
      assertRejects(verdict, [expected], label);
      assertControlCatches(agreeing, [expected], `${label} control against a reader that agrees and exits cleanly`);
      assertControlCatches(alwaysAgreeing(verdict), [expected], `${label} (helper self-check: assertRejects refuses an always-agreeing verdict)`);
    }
  });
});

test("negative controls for .xlsx: an out-of-range shared string and a misplaced cell ref are refused with the real readers; wrong, extra, uniform and missing reader output from stand-ins is refused; a reader that opens a package without its workbook relationship does not excuse it", async (t) => {
  await withRoot(async (root) => {
    const oob = join(root, "oob.xlsx");
    writeFileSync(oob, probeWorkbook(PROBE_ROWS.replace('<c r="A1" t="s"><v>0</v>', '<c r="A1" t="s"><v>9</v>')));
    const outOfRange = await xlsxReaderAgreement(oob, root, { deadlineMs: 6_000 });
    t.diagnostic(JSON.stringify({ oob: outOfRange.problems, renderedRows: outOfRange.renderedRows }));
    // Quick Look renders the lost label blank without complaint (t3-verify/mutate.log:10); only the package inspection refuses it.
    assert.deepEqual(outOfRange.problems, ['package: sheet "Summary & totals" cell A1 has shared-string index "9", outside the 3 shared strings']);
    assertControlCatches(alwaysAgreeing(outOfRange), [/^package: sheet "Summary & totals" cell A1 has shared-string index "9"/], "out-of-range shared string (helper self-check: assertRejects refuses an always-agreeing verdict)");

    const misplaced = join(root, "misplaced.xlsx");
    writeFileSync(misplaced, probeWorkbook(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>50</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C1"><v>25</v></c></row>`));
    const moved = await xlsxReaderAgreement(misplaced, root, { deadlineMs: 6_000 });
    t.diagnostic(JSON.stringify({ misplaced: moved.problems, renderedRows: moved.renderedRows }));
    assert.deepEqual(moved.problems, ['C1: the package holds the number 25 but Quick Look rendered ""', 'Quick Look rendered "25" at C2, where the package has no cell']);
    assertControlCatches(alwaysAgreeing(moved), [/^C1: the package holds the number 25/, /^Quick Look rendered "25" at C2/], "misplaced cell ref (helper self-check: assertRejects refuses an always-agreeing verdict)");

    const file = join(root, "expenses.xlsx");
    writeFileSync(file, storedZip(WORKBOOK));
    const rendered = [["travel", "50"], ["supplies", "25"], ["total", "75", "", "", "note"]];
    const decoder = sipsStandIn(root, "sips-two-colours", { width: 2, height: 1 }, TWO_COLOURS_2X1);
    const look = (name: string, output: Parameters<typeof quickLookStandIn>[2], sips = decoder, target = file) => xlsxReaderAgreement(target, root, { tools: { qlmanage: quickLookStandIn(root, name, output), sips } });
    const faithful = await look("ql-faithful", { preview: rendered, thumbnail: true });
    assert.deepEqual(faithful.problems, [], "the stand-ins reproduce an agreeing reading, so each rejection below comes from its one change");
    assert.deepEqual(faithful.uncachedFormulas, [{ ref: "C3", formula: "B3*2", rendered: "" }]);
    assert.equal(faithful.thumbnail?.distinctPixels, 2);
    assert.deepEqual((await look("ql-wrong-values", { preview: [["travel", "51"], ["suppliez", "25"], rendered[2]!], thumbnail: true })).problems, ['B1: the package holds the number 50 but Quick Look rendered "51"', 'A2: the package holds the text "supplies" but Quick Look rendered "suppliez"']);
    assert.deepEqual((await look("ql-extra-cell", { preview: [["travel", "50", "stray"], rendered[1]!, rendered[2]!], thumbnail: true })).problems, ['Quick Look rendered "stray" at C1, where the package has no cell']);
    assert.deepEqual((await look("ql-uniform", { preview: rendered, thumbnail: true }, sipsStandIn(root, "sips-uniform", { width: 1, height: 1 }, UNIFORM_1X1))).problems, ["thumbnail: the thumbnail is a uniform image"]);
    assert.deepEqual((await look("ql-no-thumbnail-file", { preview: rendered })).problems, ["thumbnail: Quick Look wrote no thumbnail file"]);
    assert.deepEqual((await look("ql-no-preview-file", { thumbnail: true })).problems, ["preview: the Quick Look preview file is missing, empty or oversized"]);
    assert.deepEqual((await look("ql-no-decoded-image", { preview: rendered, thumbnail: true }, sipsStandIn(root, "sips-writes-nothing", { width: 2, height: 1 }, undefined))).problems, ["thumbnail: sips wrote no decoded image"]);

    const minimal = join(root, "minimal.xlsx");
    writeFileSync(minimal, storedZip({ ...SHEET_PARTS, "[Content_Types].xml": MINIMAL_CONTENT_TYPES, "xl/_rels/workbook.xml.rels": WORKBOOK["xl/_rels/workbook.xml.rels"] }));
    const opened = await look("ql-opens-minimal", { preview: rendered, thumbnail: true }, decoder, minimal);
    assert.deepEqual(opened.problems, ["package: _rels/.rels is missing, so no package relationship leads a reader to xl/workbook.xml"]);
  });
});

test("negative controls for .csv: invalid and mismatching files are refused with the real reader; the mismatch control fails against a Quick Look stub that renders parseCsv's rows, with helper self-checks on always-agreeing verdicts", async (t) => {
  await withRoot(async (root) => {
    const put = (name: string, bytes: string | Buffer) => { const path = join(root, name); writeFileSync(path, bytes); return path; };
    const unbalanced = await csvReaderAgreement(put("unbalanced.csv", "category,amount\n\"supplies, office,25\ntotal,75\n"), root);
    const invalidUtf8 = await csvReaderAgreement(put("invalid-utf8.csv", Buffer.concat([Buffer.from("category,amount\ntravel,"), Buffer.from([0xff, 0xfe]), Buffer.from("50\n")])), root);
    const semicolon = put("semicolon.csv", "category;amount\ntravel;50\n");
    const mismatch = await csvReaderAgreement(semicolon, root);
    t.diagnostic(JSON.stringify({ unbalanced: unbalanced.problems, invalidUtf8: invalidUtf8.problems, mismatch: mismatch.problems }));
    assert.deepEqual(unbalanced.problems, ["parser: unterminated quoted field"]);
    assert.deepEqual(invalidUtf8.problems, ["parser: not valid UTF-8"]);
    assert.deepEqual(mismatch.problems, ['row 1: parsed ["category;amount"] but Quick Look rendered ["category","amount"]']);
    const mismatched = /^row 1: parsed \["category;amount"\] but Quick Look rendered/;
    const stubbed = await csvReaderAgreement(semicolon, root, { tools: { qlmanage: quickLookStandIn(root, "ql-parser-rows", { preview: [["category;amount"], ["travel;50"]] }) } });
    assert.deepEqual(stubbed.problems, []);
    assertControlCatches(stubbed, [mismatched], "semicolon csv previewed by a stub that renders parseCsv's rows");
    for (const [label, verdict, expected] of [["unbalanced quote", unbalanced, /^parser: unterminated quoted field$/], ["invalid UTF-8", invalidUtf8, /^parser: not valid UTF-8$/], ["semicolon", mismatch, mismatched]] as const) {
      assertRejects(verdict, [expected], label);
      assertControlCatches(alwaysAgreeing(verdict), [expected], `${label} (helper self-check: assertRejects refuses an always-agreeing verdict)`);
    }
  });
});

test("negative controls for .png: a corrupt IDAT behind a readable header is refused by the real decoder, and that control fails against a sips stub that decodes it anyway; size disagreements from a stand-in decoder are refused", async (t) => {
  await withRoot(async (root) => {
    const good = join(root, "reference.png"), broken = join(root, "reference-corrupt.png");
    const png = pngWithText("Comment", "B10-CR4-canary: teal crackle glaze");
    writeFileSync(good, png);
    writeFileSync(broken, corruptIdat(png));
    const undecodable = [/^sips pixel decode (exited|reported on stderr)/];
    const refused = await pngReaderAgreement(broken, root);
    t.diagnostic(JSON.stringify({ corrupt: refused.problems, header: refused.header }));
    assert.deepEqual(refused.header, { width: 1, height: 1 });
    assertRejects(refused, undecodable, "corrupt IDAT");
    const stubbed = await pngReaderAgreement(broken, root, { tools: { sips: sipsStandIn(root, "sips-decodes-anything", { width: 1, height: 1 }, UNIFORM_1X1) } });
    assert.deepEqual(stubbed.problems, []);
    assertControlCatches(stubbed, undecodable, "corrupt IDAT decoded by a sips stub");
    assertControlCatches(alwaysAgreeing(refused), undecodable, "corrupt IDAT (helper self-check: assertRejects refuses an always-agreeing verdict)");
    assert.deepEqual((await pngReaderAgreement(good, root, { tools: { sips: sipsStandIn(root, "sips-reports-2x2-decodes-1x1", { width: 2, height: 2 }, UNIFORM_1X1) } })).problems, ["decoded 1x1 differs from the reported 2x2"]);
    assert.deepEqual((await pngReaderAgreement(good, root, { tools: { sips: sipsStandIn(root, "sips-decodes-2x2", { width: 2, height: 2 }, FOUR_2X2) } })).problems, ["sips decoded 2x2 but IHDR declares 1x1"]);
  });
});

test("every reader-run rejection path is driven directly: deadline, overflow, signal, non-zero exit, unexpected stderr and a surviving process group", () => {
  const run: ReaderRun = { tool: "/usr/bin/textutil", args: [], pid: 4242, exitCode: 0, signal: null, timedOut: false, overflow: false, groupGone: true, elapsedMs: 5, stdout: "text", stderr: "" };
  const limits = { deadlineMs: 700, maxOutputBytes: 1024, tmpDir: "/nonexistent" };
  assert.deepEqual(runProblems("textutil", run, limits), []);
  assert.deepEqual(runProblems("textutil", { ...run, groupGone: false }, limits), ["textutil process group 4242 was still present after SIGKILL"]);
  assert.deepEqual(runProblems("textutil", { ...run, exitCode: 3 }, limits), ["textutil exited 3"]);
  assert.deepEqual(runProblems("textutil", { ...run, exitCode: null, signal: "SIGTERM" }, limits), ["textutil ended by SIGTERM"]);
  assert.deepEqual(runProblems("textutil", { ...run, exitCode: null, signal: "SIGKILL", timedOut: true }, limits), ["textutil exceeded the 700 ms deadline and its process group was SIGKILLed"]);
  assert.deepEqual(runProblems("textutil", { ...run, exitCode: null, signal: "SIGKILL", overflow: true }, limits), ["textutil output exceeded 1024 bytes and its process group was SIGKILLed"]);
  assert.deepEqual(runProblems("textutil", { ...run, stderr: "Error reading x.docx.\n" }, limits), ["textutil reported on stderr: Error reading x.docx."]);
  assert.deepEqual(runProblems("qlmanage preview", { ...run, stderr: "2026-09-15 10:50:15.169 qlmanage[14179:79801645] Processing Preview.html\nparser error\n" }, limits, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} qlmanage\[\d+:\d+\] /), ["qlmanage preview reported on stderr: parser error"]);
  assert.deepEqual(runProblems("textutil", { ...run, exitCode: 3, groupGone: false, stderr: "boom" }, limits), ["textutil exited 3", "textutil reported on stderr: boom", "textutil process group 4242 was still present after SIGKILL"]);
});
