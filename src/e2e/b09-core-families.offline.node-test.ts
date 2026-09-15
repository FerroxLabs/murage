import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { admitEngineDescriptor, claimEngineDispatch, dispatchHeadroom, dispatchLedgerPath, type B08EngineDescriptor } from "./b08-template-behavior-fixture.ts";
import {
  amountsMatch, familyApprovalPolicy, familyApprovalRule, familyInputGaps, inspectDeliverable, inspectDocx, inspectXlsx, markdownTables, parseCsv,
  practiceSet, tableRow, toolsOnPath, evaluateJsFunction,
} from "./b09-b10-family-fixture.ts";
import { B09_CASES, B09_DENIALS, B09_FROZEN_TURNS, B09_TEMPLATES } from "./b09-core-families-cases.ts";

test("generated JavaScript remains unavailable without a qualified external sandbox", () => {
  const marker = "__murage_untrusted_code_executed";
  assert.equal(Reflect.get(globalThis, marker), undefined);
  assert.throws(() => evaluateJsFunction(`globalThis.${marker}=true; function run(){return 1}`, "run", [[]]), /GENERATED_CODE_SANDBOX_REQUIRED/);
  assert.equal(Reflect.get(globalThis, marker), undefined);
});

/** A stored (uncompressed) ZIP built byte by byte, so package inspection is exercised on real archive bytes. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8"), fileName = Buffer.from(name, "utf8"), crc = crc32(data) >>> 0;
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

const WORKBOOK = {
  "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary &amp; totals" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>travel</t></si><si><r><t>sup</t></r><r><t>plies</t></r></si><si><t>total</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>50</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>25</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><f>SUM(B1:B2)</f><v>75</v></c><c r="C3"><f>B3*2</f></c><c r="D3"/><c r="E3" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>`,
};

test("the frozen B09 table has seven cases per family, one of each scenario kind plus three supplied tasks", () => {
  assert.equal(B09_CASES.length, 35);
  assert.equal(B09_FROZEN_TURNS, 40);
  assert.equal(new Set(B09_CASES.map((c) => c.id)).size, 35);
  for (const family of Object.keys(B09_TEMPLATES)) {
    const kinds = B09_CASES.filter((c) => c.family === family).map((c) => c.kind).sort();
    assert.deepEqual(kinds, ["denied-access", "interruption-restart", "missing-capability", "second-turn", "supplied", "supplied", "supplied"], family);
  }
  for (const item of B09_CASES) {
    assert.ok(item.turns.length >= 1 && item.fictionalInput && item.expected && item.controlledState, item.id);
    assert.equal(item.turns.length, item.kind === "interruption-restart" ? 2 : 1, item.id);
    if (item.kind === "second-turn") assert.ok(B09_CASES.some((c) => c.id === item.dependsOn && c.family === item.family && c.kind === "supplied"), item.id);
    else assert.equal(item.dependsOn, undefined, item.id);
    if (item.kind === "interruption-restart") assert.ok(item.deliverable, item.id);
    if (item.kind === "missing-capability") assert.ok(item.capability, item.id);
    if (item.deniedSource) assert.ok(item.deniedSource.canary.test(item.deniedSource.body), `${item.id} canary is only in its source`);
  }
  // Each family delivers at least one required saved file through its first supplied task.
  for (const family of Object.keys(B09_TEMPLATES)) assert.ok(B09_CASES.some((c) => c.family === family && c.kind === "supplied" && c.deliverable?.required), family);
  // Only the scenarios whose controlled state is a denial auto-deny anything.
  assert.deepEqual(Object.keys(B09_DENIALS).sort(), [...B09_CASES.filter((c) => c.kind === "denied-access").map((c) => c.id), "researcher/missing-capability"].sort());
  for (const template of Object.values(B09_TEMPLATES)) assert.equal(existsSync(new URL(`../../${template.source}`, import.meta.url)), true, template.source);
});

test("owner decides every card except the case's own controlled denial, and benign saves are never auto-denied", () => {
  const write = { tool: "edit", title: "Write outputs/sam-email.md" };
  const memory = { tool: "murage-memory__memory_search", title: "Search memory" };
  for (const item of B09_CASES) for (const card of [write, memory]) assert.equal(familyApprovalPolicy(B09_DENIALS, item.id, card), "owner-once", `${item.id} ${card.title}`);
  assert.equal(familyApprovalPolicy(B09_DENIALS, "writer/denied-access", { tool: "shell", subtitle: "curl --url smtp://mail.example.com" }), "deny");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "writer/draft", { tool: "shell", subtitle: "curl https://example.com" }), "owner-once");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "researcher/denied-access", { tool: "shell", subtitle: "cat sources/private-report.md" }), "deny");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "excel-creator/denied-access", { tool: "shell", subtitle: "sudo cat sources/finance-export.csv" }), "deny");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "patch/denied-access", { tool: "team_send_message", title: "Message Morgan" }), "deny");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "explainer/denied-access", { tool: "browser", title: "Open course login" }), "deny");
  assert.equal(familyApprovalPolicy(B09_DENIALS, "researcher/missing-capability", { tool: "web_fetch", title: "Fetch https://widgetco.example" }), "deny");
  assert.match(familyApprovalRule(B09_DENIALS, "patch/denied-access"), /denied by the runner; every other approval card waits/);
  assert.match(familyApprovalRule(B09_DENIALS, "patch/plan"), /^every approval card waits for the owner's one-time decision/);
});

test("live inputs are package-scoped and the B09 ledger admits its own suite size", () => {
  assert.deepEqual(familyInputGaps("b09", {}).map((gap) => gap.split("=")[0]!.split(" ")[0]), ["MURAGE_B09_LIVE", "MURAGE_B09_ENGINE_FILE"]);
  assert.deepEqual(familyInputGaps("b09", { MURAGE_B09_LIVE: "1", MURAGE_B09_ENGINE_FILE: "/x", MURAGE_B08_LIVE: "1" }), []);
  const root = mkdtempSync(join(tmpdir(), "b09-offline-"));
  try {
    const home = join(root, "home"), repoRoot = join(root, "repo"); mkdirSync(home); mkdirSync(repoRoot);
    const descriptor: B08EngineDescriptor = { instanceId: "b09-engine", driver: "openai-compat", displayName: "B09 synthetic", model: "synthetic-model", account: "synthetic", config: {}, spend: { paid: false, reason: "offline only" }, maxDispatches: 40, priorEvidence: [] };
    assert.equal(admitEngineDescriptor({ ...descriptor, maxDispatches: 22 }, { repoRoot, home }, B09_FROZEN_TURNS).ok, false);
    assert.equal(admitEngineDescriptor(descriptor, { repoRoot, home }, B09_FROZEN_TURNS).ok, true);
    const engineFile = join(root, "authority", "b09-engine.json");
    const ledger = dispatchLedgerPath(engineFile, descriptor, "b09");
    assert.match(ledger, /b09-dispatch-ledger-b09-engine\.json$/);
    assert.notEqual(ledger, dispatchLedgerPath(engineFile, descriptor));
    assert.throws(() => dispatchLedgerPath(engineFile, descriptor, "../x"), /invalid package label/);
    assert.deepEqual(dispatchHeadroom(ledger, descriptor, B09_FROZEN_TURNS), { used: 0, max: 40, remaining: 40 });
    assert.throws(() => dispatchHeadroom(ledger, descriptor), /at most one full suite \(22\)/);
    assert.equal(claimEngineDispatch(ledger, descriptor, B09_FROZEN_TURNS), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CSV, Markdown table and practice-set readers extract the deterministic facts deliverable checks use", () => {
  const csv = parseCsv("category,amount (USD)\r\ntravel,USD 50\n\"supplies, office\",\"25\"\ntotal,75\n\n");
  assert.deepEqual(csv.problems, []);
  assert.deepEqual(amountsMatch(csv.rows, { travel: 50, supplies: 25, total: 75 }), { ok: true, found: { travel: 50, supplies: 25, total: 75 } });
  assert.equal(amountsMatch(parseCsv("travel,40+10\nsupplies,25\ntotal,75").rows, { travel: 50, supplies: 25, total: 75 }).ok, false);
  assert.deepEqual(parseCsv("a,\"unterminated\n").problems, ["unterminated quoted field"]);
  const tables = markdownTables("Intro\n\n| Venue | Seats | Hire |\n|---|---:|---|\n| Cedar (Note A) | 10 | £80 |\n| Maple | 16 | £95 |\n\nAfter.");
  assert.equal(tables.length, 1);
  assert.deepEqual(tableRow(tables, /Maple/), ["Maple", "16", "£95"]);
  assert.equal(tableRow(tables, /Birch/), undefined);
  const check = B09_CASES.find((c) => c.id === "researcher/comparison")!.deliverable!.check!;
  assert.equal(check.test("| Venue | Seats | Hire |\n|---|---|---|\n| Cedar | 10 | £80 |\n| Maple | 16 | £95 |", { format: "text", ok: true, problems: [], characters: 1 }).ok, true);
  assert.equal(check.test("Cedar 10 £80, Maple 16 £95 (no table)", { format: "text", ok: true, problems: [], characters: 1 }).ok, false);
  assert.deepEqual(practiceSet("# Practice\n1. What do roots absorb?\n2. What do leaves use to make food?\n\n## Answer key\n1. Water\n2. Light"), { questions: 2, answerKeyAfterQuestions: true });
  assert.equal(practiceSet("1. What do roots absorb? Answer: water").answerKeyAfterQuestions, false);
  const summary = B09_CASES.find((c) => c.id === "excel-creator/summary")!.deliverable!.check!;
  assert.equal(summary.test("Category,Total\nTravel,50\nSupplies,25\nTotal,75\n", { format: "csv", ok: true, problems: [], rows: [] }).ok, true);
  assert.equal(summary.test("Category,Total\nTravel,40\nSupplies,25\nTotal,65\n", { format: "csv", ok: true, problems: [], rows: [] }).ok, false);
});

test("a workbook is opened as a package: sheets, shared/inline strings, cached values and formulas; broken packages fail", async () => {
  const book = await inspectXlsx(storedZip(WORKBOOK));
  assert.deepEqual(book.problems, []);
  assert.equal(book.ok, true);
  assert.equal(book.sheets[0]!.name, "Summary & totals");
  const cells = Object.fromEntries(book.sheets[0]!.cells.map((cell) => [cell.ref, cell]));
  assert.equal(cells.A2!.value, "supplies");
  assert.deepEqual(cells.B3, { ref: "B3", value: "75", formula: "SUM(B1:B2)" });
  assert.deepEqual(cells.C3, { ref: "C3", formula: "B3*2" });
  assert.equal(cells.E3!.value, "note");
  assert.equal(book.formulas, 2); assert.equal(book.formulasWithoutCachedValue, 1);
  const labels = B09_CASES.find((c) => c.id === "excel-creator/missing-capability")!.deliverable!.check!;
  assert.equal(labels.test("", book).ok, true);
  const { "xl/workbook.xml": _dropped, ...noWorkbook } = WORKBOOK;
  assert.equal((await inspectXlsx(storedZip(noWorkbook))).ok, false);
  assert.match((await inspectXlsx(Buffer.from("travel,50\n"))).problems[0]!, /not a readable ZIP package/);
  assert.equal((await inspectDeliverable("outputs/expenses.xlsx", storedZip({ ...WORKBOOK, "[Content_Types].xml": "<Types/>" }))).ok, false);
});

test("a Word document is opened as a package and native tracked-change marks are counted", async () => {
  const types = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const tracked = await inspectDocx(storedZip({ "[Content_Types].xml": types, "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>We aim to ship Friday</w:t></w:r><w:ins w:id="1" w:author="B"><w:r><w:t xml:space="preserve"> if QA passes</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>.</w:delText></w:r></w:del></w:p></w:body></w:document>` }));
  assert.deepEqual({ ok: tracked.ok, text: tracked.text, insertions: tracked.insertions, deletions: tracked.deletions }, { ok: true, text: "We aim to ship Friday if QA passes", insertions: 1, deletions: 1 });
  assert.equal((await inspectDocx(storedZip({ "[Content_Types].xml": types }))).ok, false);
});

test("a real .docx written by the platform converter opens, and plain prose conversion carries no tracked changes", { skip: existsSync("/usr/bin/textutil") ? false : "no /usr/bin/textutil on this host" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "b09-textutil-"));
  try {
    const input = join(root, "note.txt"), output = join(root, "note.docx");
    writeFileSync(input, "We aim to ship Friday if QA passes.\n");
    execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", output, input], { stdio: "ignore", timeout: 30_000 });
    const inspection = await inspectDeliverable(output, readFileSync(output));
    assert.equal(inspection.format, "docx");
    assert.equal(inspection.ok, true, JSON.stringify(inspection.problems));
    if (inspection.format === "docx") { assert.match(inspection.text, /if QA passes/); assert.equal(inspection.insertions + inspection.deletions, 0); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("text deliverables must be non-empty UTF-8, CSV must parse, and unknown formats are recorded without judgement", async () => {
  assert.equal((await inspectDeliverable("outputs/a.md", Buffer.from("# Plan\n"))).ok, true);
  assert.equal((await inspectDeliverable("outputs/a.md", Buffer.from("  \n"))).ok, false);
  assert.equal((await inspectDeliverable("outputs/a.md", Buffer.from([0xff, 0xfe, 0x00]))).ok, false);
  assert.equal((await inspectDeliverable("outputs/a.csv", Buffer.from("a,\"b\n"))).ok, false);
  assert.deepEqual(await inspectDeliverable("outputs/a.png", Buffer.from([1, 2])), { format: "other", ok: true, problems: [], extension: ".png" });
});

test("tool absence is proved on an explicit PATH, not assumed", () => {
  const root = mkdtempSync(join(tmpdir(), "b09-path-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "soffice"), "#!/bin/sh\n"); chmodSync(join(bin, "soffice"), 0o755);
    writeFileSync(join(bin, "pandoc"), "not executable"); chmodSync(join(bin, "pandoc"), 0o644);
    assert.deepEqual(toolsOnPath(["soffice", "pandoc", "libreoffice"], `${join(root, "empty")}:${bin}`), { soffice: join(bin, "soffice"), pandoc: null, libreoffice: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
