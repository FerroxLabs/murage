// B09/B10 template-family runner support that runs no process and needs no
// browser: package-scoped live inputs, the per-case approval policy, the
// harness PATH probe and real deliverable inspection.
//
// Deliverable inspection opens the saved bytes the way a reader would: an
// .xlsx or .docx must be an OPC ZIP package with the matching content type,
// workbook/document part and readable sheets/paragraphs (every .xlsx
// shared-string index must be in range; an .xlsx through inspectDeliverable
// also needs its _rels/.rels relationship to the workbook); a .csv must parse; a
// text file must be valid UTF-8. It does not calculate formulas or render
// layout, so those stay unverified unless a case establishes them another way.
import { accessSync, constants } from "node:fs";
import { dirname, extname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import * as yauzl from "yauzl";

import type { B08Rubric } from "./b08-template-behavior-fixture.ts";
import { isQualifiedGeneratedCodeSandbox, type JsEvaluation, type QualifiedGeneratedCodeSandbox } from "./b10-generated-code-sandbox.ts";

export type FamilyPackage = "b09" | "b10";

export interface FamilyCase {
  id: string;
  family: string;
  kind: string;
  /** Authored fictional input from the package's execution record, unchanged in substance. */
  fictionalInput: string;
  /** Authored expected result: the contract, not a result. */
  expected: string;
  /** The prompts actually sent, in order. */
  turns: readonly string[];
  /** The actual state the runner establishes before the turn. */
  controlledState: string;
  /** Automated screen of reply text only; human assessment is still required. */
  rubric: B08Rubric;
  /** A case that continues another case's thread. */
  dependsOn?: string;
  /** Room cases: the member keys each turn @mentions; each responder is one engine dispatch. */
  responders?: ReadonlyArray<readonly string[]>;
}

export interface FamilyTemplate { name: string; slug: string; source: string; playbook: string }
/** A package that imports as a real room of members through the team import route. */
export interface FamilyRoom { name: string; source: string; roomKey: string; members: Record<string, { name: string; playbook: string }> }

/** Engine dispatches a case needs: one per turn, or one per mentioned responder in a room turn. */
export function familyCaseDispatches(item: Pick<FamilyCase, "turns" | "responders">): number {
  return item.turns.reduce((total, _turn, index) => total + (item.responders?.[index]?.length ?? 1), 0);
}
export interface ControlledDenial { rule: string; matches: RegExp }

export function familyEnv(pkg: FamilyPackage) {
  const up = pkg.toUpperCase();
  return {
    live: `MURAGE_${up}_LIVE`, engineFile: `MURAGE_${up}_ENGINE_FILE`, evidence: `MURAGE_${up}_EVIDENCE_DIR`,
    keepData: `MURAGE_${up}_KEEP_DATA`, turnTimeout: `MURAGE_${up}_TURN_TIMEOUT_MS`, runStamp: `MURAGE_${up}_RUN_STAMP`,
  } as const;
}

/** Presence only: reads no file, so discovery and no-input runs never touch a credential. */
export function familyInputGaps(pkg: FamilyPackage, env: NodeJS.ProcessEnv): string[] {
  const names = familyEnv(pkg);
  const gaps: string[] = [];
  if (env[names.live] !== "1") gaps.push(`${names.live}=1 (explicit opt-in to live inference for this run)`);
  if (!env[names.engineFile]) gaps.push(`${names.engineFile} naming a root-issued engine descriptor for ${pkg.toUpperCase()} (engine, model, account, spend authority, credential file, priorEvidence, maxDispatches)`);
  return gaps;
}

export interface ApprovalCardText { tool?: string; title?: string; subtitle?: string }

/** Cards a case's controlled state itself denies; every other card waits for the owner's one-time decision. The runner never grants. */
export function familyApprovalPolicy(denials: Partial<Record<string, ControlledDenial>>, id: string, card: ApprovalCardText): "owner-once" | "deny" {
  const denial = denials[id];
  return denial && denial.matches.test(`${card.tool ?? ""} ${card.title ?? ""} ${card.subtitle ?? ""}`) ? "deny" : "owner-once";
}

export function familyApprovalRule(denials: Partial<Record<string, ControlledDenial>>, id: string): string {
  const owner = "every other approval card waits for the owner's one-time decision (Allow once or Deny); the runner never grants";
  const denial = denials[id];
  return denial ? `${denial.rule}; ${owner}` : owner.replace(/^every other/, "every");
}

/** The PATH an isolated harness child gets (see startIsolatedHarness): node's directory, /usr/bin and /bin. */
export function harnessPath(nodeBin = process.execPath): string {
  return [dirname(nodeBin), "/usr/bin", "/bin"].join(":");
}

/** Where each named executable resolves on a PATH, or null when absent. */
export function toolsOnPath(tools: readonly string[], path: string): Record<string, string | null> {
  return Object.fromEntries(tools.map((tool) => {
    for (const dir of path.split(":").filter(Boolean)) {
      const candidate = join(dir, tool);
      try { accessSync(candidate, constants.X_OK); return [tool, candidate]; } catch { /* keep looking */ }
    }
    return [tool, null];
  }));
}

// ── Package archives ──────────────────────────────────────────────────────

/** Every file entry of a ZIP held in memory, bounded in count and expanded size. */
export async function readZipEntries(bytes: Uint8Array, limits = { entries: 2_000, bytes: 64 * 1024 * 1024 }): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true }, (error, value) => (error ? reject(error) : resolve(value!)));
  });
  const entries = new Map<string, Buffer>();
  let expanded = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      if (entries.size >= limits.entries) { fail(new Error(`archive has more than ${limits.entries} entries`)); return; }
      expanded += entry.uncompressedSize;
      if (expanded > limits.bytes) { fail(new Error(`archive expands beyond ${limits.bytes} bytes`)); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail(error ?? new Error(`no stream for ${entry.fileName}`)); return; }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", fail);
        stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return entries;
}

const decodeXml = (value: string) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
  .replace(/&amp;/g, "&");
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`))?.[1];
const textRuns = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => decodeXml(match[1]!));

export interface XlsxCell { ref: string; type?: string; value?: string; formula?: string }
export interface XlsxInspection { format: "xlsx"; ok: boolean; problems: string[]; sheets: Array<{ name: string; cells: XlsxCell[] }>; formulas: number; formulasWithoutCachedValue: number }
export interface DocxInspection { format: "docx"; ok: boolean; problems: string[]; text: string; insertions: number; deletions: number }
export interface CsvInspection { format: "csv"; ok: boolean; problems: string[]; rows: string[][] }
export interface TextInspection { format: "text"; ok: boolean; problems: string[]; characters: number }
export interface OtherInspection { format: "other"; ok: true; problems: []; extension: string }
export type DeliverableInspection = XlsxInspection | DocxInspection | CsvInspection | TextInspection | OtherInspection;

async function packageEntries(bytes: Uint8Array): Promise<{ entries?: Map<string, Buffer>; problem?: string }> {
  try { return { entries: await readZipEntries(bytes) }; }
  catch (error) { return { problem: `not a readable ZIP package: ${error instanceof Error ? error.message : String(error)}` }; }
}

export interface XlsxInspectionOptions {
  /** Also require the OPC package relationship a reader follows to the workbook: _rels/.rels with an officeDocument relationship to
   * xl/workbook.xml (a package without it did not open in Quick Look). inspectDeliverable and the B09/B10 reader adapters turn this on.
   * It is off by default only because the root-integrated B09 offline WORKBOOK (b09-core-families.offline.node-test.ts) has no _rels/.rels. */
  requirePackageRelationships?: boolean;
}

/** The OPC root relationship (_rels/.rels) that leads a reader to the package's main part. */
function rootRelationshipProblems(entries: Map<string, Buffer>, mainPart: string): string[] {
  const relationships = entries.get("_rels/.rels")?.toString("utf8");
  if (relationships === undefined) return [`_rels/.rels is missing, so no package relationship leads a reader to ${mainPart}`];
  const leads = [...relationships.matchAll(/<Relationship\b[^>]*>/g)].some((match) => (attribute(match[0], "Type") ?? "").endsWith("/officeDocument") && (attribute(match[0], "Target") ?? "").replace(/^\.?\//, "") === mainPart);
  return leads ? [] : [`_rels/.rels has no officeDocument relationship to ${mainPart}`];
}

/** Opens a workbook as a reader would: content type, workbook part (and, when required, the package relationship to it), sheet relationships, shared strings with in-range indexes, and cells (values and formulas). */
export async function inspectXlsx(bytes: Uint8Array, options: XlsxInspectionOptions = {}): Promise<XlsxInspection> {
  const opened = await packageEntries(bytes);
  if (!opened.entries) return { format: "xlsx", ok: false, problems: [opened.problem!], sheets: [], formulas: 0, formulasWithoutCachedValue: 0 };
  const entries = opened.entries;
  const problems: string[] = [];
  if (!/spreadsheetml\.sheet\.main\+xml/.test(entries.get("[Content_Types].xml")?.toString("utf8") ?? "")) problems.push("[Content_Types].xml does not declare a SpreadsheetML workbook");
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  if (!workbook) problems.push("xl/workbook.xml is missing");
  if (options.requirePackageRelationships) problems.push(...rootRelationshipProblems(entries, "xl/workbook.xml"));
  const relationships = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targets = new Map([...relationships.matchAll(/<Relationship\b[^>]*>/g)].map((match) => [attribute(match[0], "Id"), attribute(match[0], "Target")]));
  const shared = [...(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1]!, "t").join(""));
  const sheets: XlsxInspection["sheets"] = [];
  for (const match of (workbook ?? "").matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(attribute(match[0], "name") ?? "");
    const target = targets.get(attribute(match[0], "r:id"));
    if (!target) { problems.push(`sheet ${JSON.stringify(name)} has no relationship target`); continue; }
    const part = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = entries.get(part)?.toString("utf8");
    if (!xml) { problems.push(`sheet ${JSON.stringify(name)} part ${part} is missing`); continue; }
    const cells = [...xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell): XlsxCell => {
      const head = ` ${cell[1] ?? ""}`, inner = cell[2] ?? "";
      const type = attribute(head, "t"), ref = attribute(head, "r") ?? "";
      const formula = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      // A shared-string cell whose <v> is not an index into sharedStrings.xml is a corrupt package, not an empty cell.
      if (type === "s" && raw !== undefined && !(/^\s*\d+\s*$/.test(raw) && Number(raw) < shared.length)) problems.push(`sheet ${JSON.stringify(name)} cell ${ref || "without a reference"} has shared-string index ${JSON.stringify(raw)}, outside the ${shared.length} shared strings`);
      const value = type === "s" && raw !== undefined ? shared[Number(raw)] : type === "inlineStr" ? textRuns(inner, "t").join("") : raw === undefined ? undefined : decodeXml(raw);
      return { ref, ...(type ? { type } : {}), ...(value !== undefined ? { value } : {}), ...(formula !== undefined ? { formula: decodeXml(formula) } : {}) };
    });
    sheets.push({ name, cells });
  }
  if (workbook && sheets.length === 0) problems.push("the workbook declares no readable sheet");
  const cells = sheets.flatMap((sheet) => sheet.cells);
  return { format: "xlsx", ok: problems.length === 0, problems, sheets, formulas: cells.filter((cell) => cell.formula !== undefined).length, formulasWithoutCachedValue: cells.filter((cell) => cell.formula !== undefined && cell.value === undefined).length };
}

/** Opens a Word document package: content type, document part, paragraph text and native tracked-change marks. */
export async function inspectDocx(bytes: Uint8Array): Promise<DocxInspection> {
  const opened = await packageEntries(bytes);
  if (!opened.entries) return { format: "docx", ok: false, problems: [opened.problem!], text: "", insertions: 0, deletions: 0 };
  const problems: string[] = [];
  if (!/wordprocessingml\.document\.main\+xml/.test(opened.entries.get("[Content_Types].xml")?.toString("utf8") ?? "")) problems.push("[Content_Types].xml does not declare a WordprocessingML document");
  const document = opened.entries.get("word/document.xml")?.toString("utf8");
  if (!document) problems.push("word/document.xml is missing");
  const xml = document ?? "";
  return { format: "docx", ok: problems.length === 0, problems, text: textRuns(xml, "w:t").join(""), insertions: (xml.match(/<w:ins\b/g) ?? []).length, deletions: (xml.match(/<w:del\b/g) ?? []).length };
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF; blank lines ignored. */
export function parseCsv(text: string): { rows: string[][]; problems: string[] } {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const endRow = () => { row.push(field); field = ""; if (row.some((cell) => cell.trim() !== "")) rows.push(row); row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== "\"") field += char;
      else if (text[index + 1] === "\"") { field += "\""; index += 1; }
      else quoted = false;
      continue;
    }
    if (char === "\"" && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[index + 1] === "\n") index += 1; endRow(); }
    else field += char;
  }
  if (quoted) return { rows, problems: ["unterminated quoted field"] };
  endRow();
  return { rows, problems: rows.length ? [] : ["no rows"] };
}

const amountCell = (cell: string) => {
  const cleaned = cell.trim().replace(/^(USD|US\$|\$|£|€)\s*/i, "").replace(/\s*(USD)$/i, "").replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : undefined;
};

/** For each row with a text label, its last plain numeric cell. */
export function labelledAmounts(rows: readonly string[][]): Array<{ label: string; amount: number }> {
  return rows.flatMap((row) => {
    const label = row.find((cell) => /[a-z]/i.test(cell) && amountCell(cell) === undefined)?.trim();
    const amounts = row.map(amountCell).filter((value): value is number => value !== undefined);
    return label && amounts.length ? [{ label, amount: amounts[amounts.length - 1]! }] : [];
  });
}

export function amountsMatch(rows: readonly string[][], expected: Record<string, number>): { ok: boolean; found: Record<string, number | null> } {
  const amounts = labelledAmounts(rows);
  const found = Object.fromEntries(Object.keys(expected).map((label) => [label, amounts.find((item) => new RegExp(`\\b${label}\\b`, "i").test(item.label))?.amount ?? null]));
  return { ok: Object.entries(expected).every(([label, value]) => found[label] === value), found };
}

/** Pipe tables in Markdown text: header cells and body rows. */
export function markdownTables(text: string): Array<{ header: string[]; rows: string[][] }> {
  const lines = text.split(/\r?\n/);
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const tables: Array<{ header: string[]; rows: string[][] }> = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]!.includes("|") || !separator.test(lines[index + 1]!)) continue;
    const rows: string[][] = [];
    let next = index + 2;
    for (; next < lines.length && lines[next]!.includes("|") && lines[next]!.trim(); next += 1) rows.push(cells(lines[next]!));
    tables.push({ header: cells(lines[index]!), rows });
    index = next - 1;
  }
  return tables;
}

export function tableRow(tables: ReturnType<typeof markdownTables>, pattern: RegExp): string[] | undefined {
  for (const table of tables) for (const row of table.rows) if (row.some((cell) => pattern.test(cell))) return row;
  return undefined;
}

/** Questions before a separate answer-key heading. */
export function practiceSet(text: string): { questions: number; answerKeyAfterQuestions: boolean } {
  const lines = text.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => /^\s{0,3}(#{1,6}\s*|\*\*)?\s*(answer key|answers)\b/i.test(line));
  const questions = (keyIndex >= 0 ? lines.slice(0, keyIndex) : lines).filter((line) => /\?\s*(\*\*)?$/.test(line.trim())).length;
  return { questions, answerKeyAfterQuestions: keyIndex > 0 && questions > 0 };
}

/** Structural inspection by extension. Unknown formats are recorded, not judged. */
export async function inspectDeliverable(name: string, bytes: Uint8Array): Promise<DeliverableInspection> {
  const extension = extname(name).toLowerCase();
  if (extension === ".xlsx") return inspectXlsx(bytes, { requirePackageRelationships: true });
  if (extension === ".docx") return inspectDocx(bytes);
  if (extension === ".csv" || extension === ".md" || extension === ".txt") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return extension === ".csv" ? { format: "csv", ok: false, problems: ["not valid UTF-8"], rows: [] } : { format: "text", ok: false, problems: ["not valid UTF-8"], characters: 0 }; }
    if (extension === ".csv") { const parsed = parseCsv(text); return { format: "csv", ok: parsed.problems.length === 0, problems: parsed.problems, rows: parsed.rows }; }
    return { format: "text", ok: text.trim().length > 0, problems: text.trim() ? [] : ["empty text file"], characters: text.length };
  }
  return { format: "other", ok: true, problems: [], extension };
}

// ── Code and media deliverables ───────────────────────────────────────────

/** The first fenced code block (optionally of the given languages), or the whole text when there is none. */
export function extractCodeBlock(text: string, languages: readonly string[] = ["js", "javascript", "ts", "typescript", "mjs"]): string {
  for (const match of text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)) {
    if (!match[1] || languages.includes(match[1].toLowerCase())) return match[2]!;
  }
  return text;
}

export type { JsEvaluation } from "./b10-generated-code-sandbox.ts";

/** Executes saved generated JavaScript and calls one named function with JSON
 * arguments, only inside a sandbox issued by qualifyGeneratedCodeSandbox()
 * (b10-generated-code-sandbox.ts): a separate node process under a deny-default
 * macOS Seatbelt profile with no network, no host files outside a per-run
 * scratch directory, no child processes and an empty environment, whose process
 * group is SIGKILLed at the deadline and whose nonce-framed result is accepted
 * only after exit 0. Node vm is defense in depth inside that process, not the
 * boundary. Without a qualified sandbox it throws before any code runs. */
export function evaluateJsFunction(code: string, name: string, calls: readonly unknown[][], sandbox?: QualifiedGeneratedCodeSandbox): Promise<JsEvaluation> {
  if (!isQualifiedGeneratedCodeSandbox(sandbox)) throw new Error("GENERATED_CODE_SANDBOX_REQUIRED: executable deliverable verification runs only inside a sandbox issued by qualifyGeneratedCodeSandbox()");
  return sandbox.evaluate(code, name, calls);
}

/** A real 1×1 PNG carrying one tEXt chunk, so a denied reference image holds a canary only its bytes reveal. */
export function pngWithText(keyword: string, text: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`${keyword}\0${text}`, "latin1")),
    chunk("IDAT", deflateSync(Buffer.from([0, 32, 64, 160]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A receipt-sized view of an inspection. */
export function inspectionSummary(inspection: DeliverableInspection): Record<string, unknown> {
  if (inspection.format === "xlsx") return { format: "xlsx", ok: inspection.ok, problems: inspection.problems, sheets: inspection.sheets.map((sheet) => ({ name: sheet.name, cells: sheet.cells.length, sample: sheet.cells.slice(0, 40) })), formulas: inspection.formulas, formulasWithoutCachedValue: inspection.formulasWithoutCachedValue };
  if (inspection.format === "docx") return { format: "docx", ok: inspection.ok, problems: inspection.problems, characters: inspection.text.length, insertions: inspection.insertions, deletions: inspection.deletions };
  if (inspection.format === "csv") return { format: "csv", ok: inspection.ok, problems: inspection.problems, rows: inspection.rows.slice(0, 40) };
  return { ...inspection };
}
