// B09/B10 saved-deliverable reader adapters. The accepted fixture checks open
// saved bytes with this repository's own ZIP/XML/CSV parsers (yauzl plus
// regular expressions). BUILD-PLAN B09 requires actual file/renderer validation
// for native output, so these adapters hand the same saved file to independent
// readers already on macOS and require them to agree with that inspection:
//   .docx  /usr/bin/textutil (the Cocoa document importer) extracts the text;
//   .xlsx  /usr/bin/qlmanage (Quick Look) renders a thumbnail, which sips then
//          decodes, and an HTML preview whose cells must match the package by
//          cell type (numbers as numbers, booleans as TRUE/FALSE, text exactly);
//   .csv   /usr/bin/qlmanage renders an HTML table whose rows must match;
//   .png   /usr/bin/sips decodes the pixels (a BMP conversion), not only IHDR;
//   .js    the saved file runs only behind the qualified B10 sandbox.
// Each reader runs as its own process group with a minimal environment, a hard
// SIGKILL deadline and bounded output. These tools exit 0 on unreadable input
// and report only on stderr or by producing nothing, so a reading is accepted
// only with clean stderr and the expected output present. A non-macOS host or a
// missing tool throws DELIVERABLE_READER_UNAVAILABLE: a skip is never a pass.
// What this does not establish is listed in READER_GATES_NOT_ESTABLISHED.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { evaluateJsFunction, extractCodeBlock, inspectDocx, inspectXlsx, parseCsv, type JsEvaluation, type XlsxCell } from "./b09-b10-family-fixture.ts";
import type { QualifiedGeneratedCodeSandbox } from "./b10-generated-code-sandbox.ts";

export const READER_TOOLS = Object.freeze({ textutil: "/usr/bin/textutil", qlmanage: "/usr/bin/qlmanage", sips: "/usr/bin/sips" });
export type ReaderTool = keyof typeof READER_TOOLS;

export const READER_LIMITS = Object.freeze({ deadlineMs: 20_000, maxOutputBytes: 1024 * 1024 });

/** Host overrides exist for fail-closed tests; limits may only tighten READER_LIMITS. */
export interface ReaderHost { platform?: NodeJS.Platform; tools?: Partial<Record<ReaderTool, string>>; deadlineMs?: number; maxOutputBytes?: number }

export const READER_GATES_NOT_ESTABLISHED = Object.freeze({
  formulaCalculation: "NOT ESTABLISHED: no calculation engine is installed (soffice/libreoffice absent); Quick Look renders cached <v> values only, and a formula without a cached value renders blank",
  pptx: "NOT ESTABLISHED: no PPTX artifact or reader ran; no current B09/B10 case declares a .pptx deliverable, which leaves PPTX validation open rather than unnecessary",
  layoutFidelity: "NOT ESTABLISHED: the Quick Look thumbnail is proved decodable and non-uniform, not visually compared with an expected layout",
  trackedChanges: "NOT ESTABLISHED: textutil flattens text; native w:ins/w:del marks are counted only by the package inspection",
  multiSheetWorkbooks: "NOT ESTABLISHED: the preview cell comparison covers single-sheet workbooks",
  numberFormats: "NOT ESTABLISHED: numeric cells are compared as plain numbers (3.10 agrees with 3.1) and number formats are never applied, so a valid cell Quick Look renders formatted (currency such as $50.00, percent, a date serial shown as a date, thousands separators) or as a shortened long General float is REJECTED: a fail-closed false rejection of valid writer output; no styled workbook was tested",
  booleanRendering: "NOT ESTABLISHED: Quick Look renders boolean cells blank, so a blank rendering is accepted only as an unrendered boolean whose TRUE/FALSE comes from the package's 0/1 and is never confirmed by the reader; t=\"d\" cells and numeric cells with an empty <v> are refused",
  savedCodeBeyondPlainJs: "NOT ESTABLISHED: only a plain saved .js file ran behind the B10 sandbox; saved .ts, .mjs and code fenced inside .md deliverables did not run in any offline test",
  unsandboxedReaders: "NOT ESTABLISHED: the readers parse saved bytes as the user without a sandbox (as Finder Quick Look would); only .js runs behind the B10 boundary",
  modelOutputs: "NOT ESTABLISHED: synthetic artifacts only; no model-generated deliverable, live run or human rubric assessment",
  runnerWiring: "NOT ESTABLISHED: RESTART-T3 wired these adapters into the B09/B10 runner and specs source-only; that wiring has not executed live or against a model deliverable",
});

/** The absolute path of an executable reader on macOS, or DELIVERABLE_READER_UNAVAILABLE before anything runs. */
export function readerTool(tool: ReaderTool, host: ReaderHost = {}): string {
  const platform = host.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(`DELIVERABLE_READER_UNAVAILABLE: ${tool} is a macOS reader and this host is ${platform}`);
  const path = host.tools?.[tool] ?? READER_TOOLS[tool];
  try {
    accessSync(path, constants.X_OK);
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch { throw new Error(`DELIVERABLE_READER_UNAVAILABLE: ${tool} at ${path} is not an executable file`); }
  return path;
}

export interface ReaderRunOptions { deadlineMs: number; maxOutputBytes: number; tmpDir: string }
export interface ReaderRun { tool: string; args: readonly string[]; pid?: number; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; overflow: boolean; groupGone: boolean; elapsedMs: number; stdout: string; stderr: string }
export type ReaderReceipt = Omit<ReaderRun, "stdout">;

async function confirmGroupGone(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(-pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    try { process.kill(-pid, "SIGKILL"); } catch { /* exited between the probe and the kill */ }
    await delay(20);
  }
  return false;
}

/** Runs one reader as a new process group; SIGKILLs the whole group at the deadline, on output overflow and after exit, then confirms the group is gone. */
export function runReader(tool: string, args: readonly string[], options: ReaderRunOptions): Promise<ReaderRun> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(tool, [...args], { env: { PATH: "/usr/bin:/bin", TMPDIR: `${options.tmpDir}/` }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, timedOut = false, overflow = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, options.deadlineMs);
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) { overflow = true; killGroup(); return; }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => { clearTimeout(timer); killGroup(); reject(error); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      killGroup();
      void confirmGroupGone(child.pid).then((groupGone) => resolve({
        tool, args, ...(child.pid !== undefined ? { pid: child.pid } : {}), exitCode, signal, timedOut, overflow, groupGone,
        elapsedMs: Date.now() - started, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  });
}

const receipt = ({ stdout: _stdout, ...rest }: ReaderRun): ReaderReceipt => ({ ...rest, stderr: rest.stderr.slice(0, 400) });

/** Quick Look logs NSLog lines such as "2026-09-15 10:38:04.194 qlmanage[71706:79693933] Processing Preview.html" to stderr on success. */
const QUICK_LOOK_LOG = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} qlmanage\[\d+:\d+\] /;

/** Why one reader run cannot be trusted: deadline, overflow, signal, non-zero exit, unexpected stderr or a surviving process group. Exported so offline tests can drive every rejection path. */
export function runProblems(label: string, run: ReaderRun, options: ReaderRunOptions, toleratedStderr?: RegExp): string[] {
  const problems: string[] = [];
  if (run.timedOut) problems.push(`${label} exceeded the ${options.deadlineMs} ms deadline and its process group was SIGKILLed`);
  else if (run.overflow) problems.push(`${label} output exceeded ${options.maxOutputBytes} bytes and its process group was SIGKILLed`);
  else if (run.signal) problems.push(`${label} ended by ${run.signal}`);
  else if (run.exitCode !== 0) problems.push(`${label} exited ${run.exitCode}`);
  const reported = run.stderr.split(/\r?\n/).filter((line) => line.trim() && !(toleratedStderr?.test(line)));
  if (reported.length) problems.push(`${label} reported on stderr: ${reported.join(" | ").slice(0, 300)}`);
  if (!run.groupGone) problems.push(`${label} process group ${run.pid} was still present after SIGKILL`);
  return problems;
}

function limitsFor(host: ReaderHost, workDir: string): ReaderRunOptions {
  const tighten = (requested: number | undefined, fallback: number) => (typeof requested === "number" && requested >= 1 ? Math.min(requested, fallback) : fallback);
  if (!isAbsolute(workDir) || !existsSync(workDir) || !statSync(workDir).isDirectory()) throw new Error(`reader work directory must be an existing absolute directory: ${workDir}`);
  return { deadlineMs: tighten(host.deadlineMs, READER_LIMITS.deadlineMs), maxOutputBytes: tighten(host.maxOutputBytes, READER_LIMITS.maxOutputBytes), tmpDir: workDir };
}

function savedFile(file: string): string {
  if (!isAbsolute(file) || !existsSync(file) || !statSync(file).isFile()) throw new Error(`reader input must be an absolute path to a saved file: ${file}`);
  return file;
}

const squash = (text: string) => text.replace(/\s+/g, "");

// ── Word ──────────────────────────────────────────────────────────────────

export interface DocxReaderAgreement { format: "docx"; reader: "textutil"; ok: boolean; problems: string[]; readerText: string; packageText: string; runs: ReaderReceipt[] }

/** textutil must read the saved file as DOCX and yield the package's text (whitespace-insensitive: the package joins runs, textutil separates paragraphs). */
export async function docxReaderAgreement(file: string, workDir: string, host: ReaderHost = {}): Promise<DocxReaderAgreement> {
  const textutil = readerTool("textutil", host);
  const saved = savedFile(file), limits = limitsFor(host, workDir);
  const inspection = await inspectDocx(readFileSync(saved));
  const run = await runReader(textutil, ["-format", "docx", "-convert", "txt", "-stdout", saved], limits);
  const problems = [...inspection.problems.map((problem) => `package: ${problem}`), ...runProblems("textutil", run, limits)];
  if (!problems.length && !run.stdout.trim()) problems.push("textutil produced no text (it exits 0 on unreadable input)");
  if (!problems.length && squash(run.stdout) !== squash(inspection.text)) problems.push("textutil text differs from the package text");
  return { format: "docx", reader: "textutil", ok: problems.length === 0, problems, readerText: run.stdout, packageText: inspection.text, runs: [receipt(run)] };
}

// ── Images ────────────────────────────────────────────────────────────────

export interface DecodedImage { format: string; width: number; height: number; bitsPerPixel: number; distinctPixels: number; topLeftPixel?: { r: number; g: number; b: number } }
export interface ImageReading { ok: boolean; problems: string[]; image?: DecodedImage; runs: ReaderReceipt[] }

/** An uncompressed (BI_RGB or BI_BITFIELDS) BMP as sips writes it. */
export function parseBmp(bytes: Buffer): { problems: string[]; image?: Omit<DecodedImage, "format"> } {
  if (bytes.length < 54 || bytes.toString("ascii", 0, 2) !== "BM") return { problems: ["the decoded image is not a BMP"] };
  const offset = bytes.readUInt32LE(10), width = bytes.readInt32LE(18), rawHeight = bytes.readInt32LE(22), bitsPerPixel = bytes.readUInt16LE(28), compression = bytes.readUInt32LE(30);
  const height = Math.abs(rawHeight), pixelBytes = bitsPerPixel / 8;
  if (width < 1 || height < 1 || width * height > 16_000_000) return { problems: [`the decoded image has an unusable size ${width}x${rawHeight}`] };
  if ((bitsPerPixel !== 24 && bitsPerPixel !== 32) || (compression !== 0 && compression !== 3)) return { problems: [`unsupported BMP layout: ${bitsPerPixel} bpp, compression ${compression}`] };
  const stride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (offset + stride * height > bytes.length) return { problems: ["the decoded pixel data is truncated"] };
  const distinct = new Set<string>();
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const at = offset + row * stride + column * pixelBytes;
    distinct.add(bytes.toString("hex", at, at + pixelBytes));
  }
  const top = offset + (rawHeight < 0 ? 0 : (height - 1) * stride);
  return { problems: [], image: { width, height, bitsPerPixel, distinctPixels: distinct.size, ...(compression === 0 ? { topLeftPixel: { r: bytes[top + 2]!, g: bytes[top + 1]!, b: bytes[top]! } } : {}) } };
}

async function decodeImage(sips: string, file: string, expectedFormat: string, limits: ReaderRunOptions): Promise<ImageReading> {
  const properties = await runReader(sips, ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", file], limits);
  const runs = [receipt(properties)];
  const problems = runProblems("sips", properties, limits);
  const fields = Object.fromEntries([...properties.stdout.matchAll(/^\s+(format|pixelWidth|pixelHeight): (.*)$/gm)].map((match) => [match[1]!, match[2]!.trim()]));
  if (!problems.length && fields.format !== expectedFormat) problems.push(`sips reports format ${JSON.stringify(fields.format)}, expected ${expectedFormat}`);
  if (!problems.length && !(/^[1-9]\d*$/.test(fields.pixelWidth ?? "") && /^[1-9]\d*$/.test(fields.pixelHeight ?? ""))) problems.push(`sips reports no pixel size (${fields.pixelWidth} x ${fields.pixelHeight})`);
  if (problems.length) return { ok: false, problems, runs };
  // Properties come from the header alone; converting forces a full pixel decode.
  const decoded = join(mkdtempSync(join(limits.tmpDir, "sips-decode-")), "decoded.bmp");
  const conversion = await runReader(sips, ["-s", "format", "bmp", file, "--out", decoded], limits);
  runs.push(receipt(conversion));
  problems.push(...runProblems("sips pixel decode", conversion, limits));
  if (!problems.length && !existsSync(decoded)) problems.push("sips wrote no decoded image");
  if (problems.length) return { ok: false, problems, runs };
  const bmp = parseBmp(readFileSync(decoded));
  if (!bmp.image) return { ok: false, problems: bmp.problems, runs };
  if (bmp.image.width !== Number(fields.pixelWidth) || bmp.image.height !== Number(fields.pixelHeight)) problems.push(`decoded ${bmp.image.width}x${bmp.image.height} differs from the reported ${fields.pixelWidth}x${fields.pixelHeight}`);
  return { ok: problems.length === 0, problems, image: { format: fields.format!, ...bmp.image }, runs };
}

/** The width and height a PNG's own IHDR declares. */
export function pngHeader(bytes: Uint8Array): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a" || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface PngReaderAgreement { format: "png"; reader: "sips"; ok: boolean; problems: string[]; header?: { width: number; height: number }; image?: DecodedImage; runs: ReaderReceipt[] }

/** sips must decode the saved PNG's pixels at the size its IHDR declares. */
export async function pngReaderAgreement(file: string, workDir: string, host: ReaderHost = {}): Promise<PngReaderAgreement> {
  const sips = readerTool("sips", host);
  const saved = savedFile(file), limits = limitsFor(host, workDir);
  const header = pngHeader(readFileSync(saved));
  const reading = await decodeImage(sips, saved, "png", limits);
  const problems = [...(header ? [] : ["the saved bytes carry no PNG signature and IHDR"]), ...reading.problems];
  if (header && reading.image && (header.width !== reading.image.width || header.height !== reading.image.height)) problems.push(`sips decoded ${reading.image.width}x${reading.image.height} but IHDR declares ${header.width}x${header.height}`);
  return { format: "png", reader: "sips", ok: problems.length === 0, problems, ...(header ? { header } : {}), ...(reading.image ? { image: reading.image } : {}), runs: reading.runs };
}

// ── Quick Look ────────────────────────────────────────────────────────────

const decodeHtml = (value: string) => value
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
  .replace(/&amp;/g, "&");

/** Cell text of every table row in a Quick Look HTML preview. */
export function htmlTableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(cell[1]!.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))));
}

interface PreviewReading { problems: string[]; rows: string[][]; runs: ReaderReceipt[] }

async function quickLookPreviewRows(qlmanage: string, file: string, limits: ReaderRunOptions): Promise<PreviewReading> {
  const outDir = mkdtempSync(join(limits.tmpDir, "quicklook-preview-"));
  const run = await runReader(qlmanage, ["-p", "-o", outDir, file], limits);
  const problems = runProblems("qlmanage preview", run, limits, QUICK_LOOK_LOG);
  const html = join(outDir, `${basename(file)}.qlpreview`, "Preview.html");
  if (!problems.length && !/produced a preview with data of type public\.html/.test(run.stdout)) problems.push(`Quick Look produced no HTML preview (${run.stdout.trim().split("\n").pop()?.trim() || "no output"})`);
  if (!problems.length && (!existsSync(html) || statSync(html).size === 0 || statSync(html).size > limits.maxOutputBytes)) problems.push("the Quick Look preview file is missing, empty or oversized");
  const rows = problems.length ? [] : htmlTableRows(readFileSync(html, "utf8"));
  if (!problems.length && rows.length === 0) problems.push("the Quick Look preview has no table rows");
  return { problems, rows, runs: [receipt(run)] };
}

async function quickLookThumbnail(qlmanage: string, sips: string, file: string, limits: ReaderRunOptions): Promise<ImageReading> {
  const outDir = mkdtempSync(join(limits.tmpDir, "quicklook-thumbnail-"));
  const run = await runReader(qlmanage, ["-t", "-s", "256", "-o", outDir, file], limits);
  const problems = runProblems("qlmanage thumbnail", run, limits, QUICK_LOOK_LOG);
  const image = join(outDir, `${basename(file)}.png`);
  if (!problems.length && !/produced one thumbnail/.test(run.stdout)) problems.push("Quick Look reported no thumbnail");
  if (!problems.length && !existsSync(image)) problems.push("Quick Look wrote no thumbnail file");
  if (problems.length) return { ok: false, problems, runs: [receipt(run)] };
  const reading = await decodeImage(sips, image, "png", limits);
  if (reading.image && reading.image.distinctPixels < 2) reading.problems.push("the thumbnail is a uniform image");
  return { ...reading, ok: reading.problems.length === 0, runs: [receipt(run), ...reading.runs] };
}

const trimRow = (row: readonly string[]) => { const copy = [...row]; while (copy.length && copy[copy.length - 1]!.trim() === "") copy.pop(); return copy; };

// ── Spreadsheets ──────────────────────────────────────────────────────────

const columnName = (index: number): string => (index < 26 ? "" : columnName(Math.floor(index / 26) - 1)) + String.fromCharCode(65 + (index % 26));
function cellPosition(ref: string): { row: number; column: number } | undefined {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  if (!match) return undefined;
  const column = [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, column };
}

export interface XlsxReaderAgreement {
  format: "xlsx"; reader: "qlmanage+sips"; ok: boolean; problems: string[];
  thumbnail?: DecodedImage; renderedRows: string[][];
  uncachedFormulas: Array<{ ref: string; formula: string; rendered: string }>;
  /** Boolean cells Quick Look left blank: their TRUE/FALSE comes from the package's 0/1 only (READER_GATES_NOT_ESTABLISHED.booleanRendering). */
  unrenderedBooleans: Array<{ ref: string; display: "TRUE" | "FALSE" }>;
  formulaCalculation: typeof READER_GATES_NOT_ESTABLISHED.formulaCalculation;
  runs: ReaderReceipt[];
}

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export type XlsxCellComparison = { agrees: true; unrenderedBoolean?: "TRUE" | "FALSE" } | { agrees: false; problem: string };

/** Compares one package cell with the text Quick Look rendered for it, by the cell's own SpreadsheetML type (t, n when absent):
 *  - n: the cached value and the rendered text must both be plain numbers and equal as numbers (3.10 agrees with 3.1; 75.0 with 75);
 *  - b: 1 and 0 display as TRUE and FALSE; Quick Look renders booleans blank, which agrees only as an unrendered boolean that is reported;
 *  - s, inlineStr, str (a formula's cached text), e (a cached error): exact text, trimmed. Text is never compared as a number;
 *  - any other type (t="d" included) is not compared and disagrees; an n cell with an empty <v> is not a number and disagrees (both fail closed).
 * A formula cell compares its cached value by the same rule; nothing is calculated. An empty cell agrees only with a blank rendering. */
export function compareXlsxCell(cell: XlsxCell, rendered: string): XlsxCellComparison {
  const shown = rendered.trim(), type = cell.type ?? "n";
  const disagree = (holds: string): XlsxCellComparison => ({ agrees: false, problem: `${cell.ref}: the package holds ${holds} but Quick Look rendered ${JSON.stringify(shown)}` });
  if (cell.value === undefined) return shown === "" ? { agrees: true } : disagree(`an empty ${type} cell`);
  const value = cell.value.trim();
  if (type === "n") {
    if (!NUMERIC_TEXT.test(value)) return { agrees: false, problem: `${cell.ref}: the package's numeric cell holds ${JSON.stringify(cell.value)}, which is not a number` };
    return NUMERIC_TEXT.test(shown) && Number(shown) === Number(value) ? { agrees: true } : disagree(`the number ${value}`);
  }
  if (type === "b") {
    const display = value === "1" ? "TRUE" : value === "0" ? "FALSE" : undefined;
    if (!display) return { agrees: false, problem: `${cell.ref}: the package's boolean cell holds ${JSON.stringify(cell.value)}, which is neither 0 nor 1` };
    if (shown === display) return { agrees: true };
    return shown === "" ? { agrees: true, unrenderedBoolean: display } : disagree(`the boolean ${display}`);
  }
  if (type === "s" || type === "inlineStr" || type === "str" || type === "e") return shown === value ? { agrees: true } : disagree(`the text ${JSON.stringify(value)}`);
  return { agrees: false, problem: `${cell.ref}: cell type ${JSON.stringify(type)} is not compared by this reader` };
}

/** Quick Look must render the saved workbook (a decodable, non-uniform thumbnail) and preview the package's cached cell values, indexed from A1 and compared by cell type (compareXlsxCell). The package must also carry its relationship to the workbook. */
export async function xlsxReaderAgreement(file: string, workDir: string, host: ReaderHost = {}): Promise<XlsxReaderAgreement> {
  const qlmanage = readerTool("qlmanage", host), sips = readerTool("sips", host);
  const saved = savedFile(file), limits = limitsFor(host, workDir);
  const inspection = await inspectXlsx(readFileSync(saved), { requirePackageRelationships: true });
  const thumbnail = await quickLookThumbnail(qlmanage, sips, saved, limits);
  const preview = await quickLookPreviewRows(qlmanage, saved, limits);
  const problems = [...inspection.problems.map((problem) => `package: ${problem}`), ...thumbnail.problems.map((problem) => `thumbnail: ${problem}`), ...preview.problems.map((problem) => `preview: ${problem}`)];
  const uncachedFormulas: XlsxReaderAgreement["uncachedFormulas"] = [], unrenderedBooleans: XlsxReaderAgreement["unrenderedBooleans"] = [];
  if (inspection.sheets.length !== 1) problems.push(`the preview comparison covers single-sheet workbooks; this package has ${inspection.sheets.length}`);
  else if (!preview.problems.length) {
    const compared = new Set<string>();
    for (const cell of inspection.sheets[0]!.cells) {
      const at = cellPosition(cell.ref);
      if (!at) { problems.push(`package cell ${JSON.stringify(cell.ref)} is not an A1 reference`); continue; }
      const rendered = preview.rows[at.row]?.[at.column] ?? "";
      compared.add(cell.ref);
      if (cell.formula !== undefined && cell.value === undefined) { uncachedFormulas.push({ ref: cell.ref, formula: cell.formula, rendered: rendered.trim() }); continue; }
      const comparison = compareXlsxCell(cell, rendered);
      if (!comparison.agrees) problems.push(comparison.problem);
      else if (comparison.unrenderedBoolean) unrenderedBooleans.push({ ref: cell.ref, display: comparison.unrenderedBoolean });
    }
    preview.rows.forEach((row, rowIndex) => row.forEach((text, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (text.trim() && !compared.has(ref)) problems.push(`Quick Look rendered ${JSON.stringify(text.trim())} at ${ref}, where the package has no cell`);
    }));
  }
  return {
    format: "xlsx", reader: "qlmanage+sips", ok: problems.length === 0, problems, ...(thumbnail.image ? { thumbnail: thumbnail.image } : {}),
    renderedRows: preview.rows.map(trimRow), uncachedFormulas, unrenderedBooleans, formulaCalculation: READER_GATES_NOT_ESTABLISHED.formulaCalculation, runs: [...thumbnail.runs, ...preview.runs],
  };
}

export interface CsvReaderAgreement { format: "csv"; reader: "qlmanage"; ok: boolean; problems: string[]; parsedRows: string[][]; renderedRows: string[][]; runs: ReaderReceipt[] }

/** Quick Look's CSV preview must show the same rows parseCsv reads from the saved bytes. */
export async function csvReaderAgreement(file: string, workDir: string, host: ReaderHost = {}): Promise<CsvReaderAgreement> {
  const qlmanage = readerTool("qlmanage", host);
  const saved = savedFile(file), limits = limitsFor(host, workDir);
  const problems: string[] = [];
  let parsedRows: string[][] = [];
  try {
    const parsed = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(saved)));
    parsedRows = parsed.rows.map(trimRow);
    problems.push(...parsed.problems.map((problem) => `parser: ${problem}`));
  } catch { problems.push("parser: not valid UTF-8"); }
  const preview = await quickLookPreviewRows(qlmanage, saved, limits);
  problems.push(...preview.problems.map((problem) => `preview: ${problem}`));
  const renderedRows = preview.rows.map(trimRow);
  if (!problems.length) {
    const differs = Math.max(parsedRows.length, renderedRows.length);
    for (let index = 0; index < differs; index += 1) {
      if (JSON.stringify(parsedRows[index]) !== JSON.stringify(renderedRows[index])) { problems.push(`row ${index + 1}: parsed ${JSON.stringify(parsedRows[index])} but Quick Look rendered ${JSON.stringify(renderedRows[index])}`); break; }
    }
  }
  return { format: "csv", reader: "qlmanage", ok: problems.length === 0, problems, parsedRows, renderedRows, runs: preview.runs };
}

// ── Code ──────────────────────────────────────────────────────────────────

/** Reads a saved code deliverable as strict UTF-8 and runs it only through evaluateJsFunction, which throws synchronously without a qualified sandbox. */
export function executeSavedCode(file: string, name: string, calls: readonly unknown[][], sandbox?: QualifiedGeneratedCodeSandbox): Promise<JsEvaluation> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(savedFile(file)));
  return evaluateJsFunction(extractCodeBlock(text), name, calls, sandbox);
}
