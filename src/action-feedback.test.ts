// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Every user action has to show what happened: it is pending at once, it says
// so when it worked, and it says why when it did not. 1.0.3 fixed the audit's
// High rows with useAction (src/lib/use-action.ts). This keeps the three habits
// that caused them from coming back, by reading the source of src/components:
//
//   1. a swallowed failure: `.catch(() => {})`, `.catch(() => undefined)` or a
//      catch block with nothing in it (a catch whose body holds a comment is
//      a documented choice and is not counted);
//   2. a promise `void`ed straight from an onClick handler when the call is
//      the network, the OS or `perform` (use useAction or ActionButton);
//   3. a busy flag that exists only as `useRef(false)`, with no useState beside
//      it, so nothing re-renders while the work runs.
//
// What is left from the audit's Medium and Low rows and from background code is
// listed below, each with its reason. The list is a ratchet: a count that goes
// down must be lowered here (the test fails until it is), and a count that goes
// up, or a file that is not listed, fails. The list only ever shrinks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const componentsDir = fileURLToPath(new URL("./components/", import.meta.url));

export type Finding = { rule: "swallowed-catch" | "void-onclick" | "ref-only-busy"; line: number; text: string };

const RAW_CALL = /^(?:api|fetch|perform|openOutside|openExternal\w*|window\.muragebox(?:\?)?\.[\w.?]+)$/;
const BUSY_NAME = /busy|acting|inflight|pending|working|saving|running|submitting|sending|gate|guard|lock/i;
const BUSY_STATE = /busy|acting|pending|working|saving|running|submitting|sending|inflight/i;

const isUndefinedLike = (node: ts.Node) =>
  (ts.isIdentifier(node) && node.text === "undefined") || (ts.isVoidExpression(node) && ts.isNumericLiteral(node.expression));

export function scanSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (rule: Finding["rule"], node: ts.Node) => out.push({ rule, line: lineOf(node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
  const emptyBlock = (block: ts.Block) => block.statements.length === 0 && source.slice(block.getStart(sf) + 1, block.end - 1).trim() === "";
  let hasBusyState = false;
  const refs: ts.VariableDeclaration[] = [];

  const visit = (node: ts.Node, inOnClick: boolean) => {
    // 1. swallowed catches
    if (ts.isCatchClause(node) && emptyBlock(node.block)) add("swallowed-catch", node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch" && node.arguments.length === 1) {
      const handler = node.arguments[0];
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        const body = handler.body;
        if (ts.isBlock(body) ? emptyBlock(body) : isUndefinedLike(body)) add("swallowed-catch", node);
      }
    }
    // 2. void-ed raw calls inside onClick
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "onClick") inOnClick = true;
    if (inOnClick && ts.isVoidExpression(node) && ts.isCallExpression(node.expression) && RAW_CALL.test(node.expression.expression.getText(sf).replace(/\s+/g, ""))) add("void-onclick", node);
    // 3. ref-only busy flags
    if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name) && init && ts.isCallExpression(init) && /^(?:React\.)?useRef$/.test(init.expression.getText(sf)) && init.arguments.length === 1 && init.arguments[0].kind === ts.SyntaxKind.FalseKeyword && BUSY_NAME.test(node.name.text)) refs.push(node);
      if (ts.isArrayBindingPattern(node.name) && init && ts.isCallExpression(init) && /^(?:React\.)?useState$/.test(init.expression.getText(sf))) {
        const first = node.name.elements[0];
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name) && BUSY_STATE.test(first.name.text)) hasBusyState = true;
      }
    }
    ts.forEachChild(node, child => visit(child, inOnClick));
  };
  visit(sf, false);
  if (!hasBusyState) for (const ref of refs) add("ref-only-busy", ref);
  return out.sort((a, b) => a.line - b.line);
}

/** Remaining findings, by file. `max` only ever goes down. */
type Allowed = { file: string; swallowed?: number; voidOnClick?: number; refOnly?: number; reason: string };

const BACKGROUND = "Not a user action: a background refresh or best-effort cleanup after a result that was already shown. To triage in the follow-up pass the audit names for lib/ and background catches.";

// Seeded from ACTION-FEEDBACK-AUDIT.md (2026-10-16), minus the 13 High rows fixed in 1.0.3.
export const ALLOWED: Allowed[] = [
  { file: "SettingsModal.tsx", voidOnClick: 1, reason: "Opens the download page in the browser; the page link stays visible if the open fails. Not in the audit; to triage with the other openExternal rows." },
  { file: "UpdateBanner.tsx", voidOnClick: 1, reason: "Opens the download page in the browser from the update banner; the banner keeps its own state line. Not in the audit; to triage with the other openExternal rows." },
  { file: "BackupSettings.tsx", swallowed: 1, reason: "Status read at mount; the section already shows its own unavailable text when the read gives nothing. Background, not a user action." },
  { file: "BrowserApprovedSites.tsx", swallowed: 1, reason: BACKGROUND },
  { file: "BrowserPanel.tsx", swallowed: 1, voidOnClick: 1, reason: "Audit Low (BrowserPanel.tsx:691): Open in your default browser has no error line for a rejected openExternal; the layout catch is a native-view hand-off that repaints on the next frame." },
  { file: "BrowserWorkspace.tsx", swallowed: 1, reason: BACKGROUND },
  { file: "CallView.tsx", swallowed: 2, reason: "Audit Low (Resume call): releasing the microphone while a call ends; nothing the person can act on." },
  { file: "CommandPalette.tsx", swallowed: 1, reason: "Lazy import of the settings search index; the palette still works without it. Audit Low (CommandPalette.tsx:139) covers the pending cue." },
  { file: "ComputerPanel.tsx", swallowed: 5, voidOnClick: 1, reason: "The live-desktop keepalive heartbeat (not a user action; the next beat retries, and a lost one only lets the idle timer run). Audit Low (ComputerPanel.tsx:1396, Hand back closes the viewer whatever release returned) and Medium (:1526): control release and viewer close while leaving the screen; the visible Stopping/Stopped cue is the open Medium row." },
  { file: "ConfirmDelete.tsx", swallowed: 1, reason: BACKGROUND },
  { file: "EngineManagement.tsx", swallowed: 1, voidOnClick: 5, reason: "Audit Low (EngineManagement.tsx:61): buttons only disable, no Installing label or progress. The refresh catch follows a result that is already shown." },
  { file: "EnginesSettings.tsx", swallowed: 2, reason: "Refresh after a save that already reported its result; a failed refresh keeps the last list." },
  { file: "FirstRunFluxCard.tsx", voidOnClick: 1, reason: "Audit Medium (FirstRunFluxCard.tsx:357): opening the browser to get a key has no 'could not open, copy the link' line yet." },
  { file: "FirstRunJobsCard.tsx", swallowed: 2, reason: "Audit Medium (FirstRunJobsCard.tsx:941,1074): browser open and job start follow-ups; the 'could not open' line is the open Medium row." },
  { file: "FirstRunPhoneCard.tsx", voidOnClick: 1, reason: "Audit Medium (FirstRunPhoneCard.tsx:239): Download Tailscale opens the browser with no failure line yet." },
  { file: "GroupCallView.tsx", swallowed: 1, reason: BACKGROUND },
  { file: "ImageMedia.tsx", swallowed: 1, reason: "Audit Medium (ImageMedia.tsx:565): full-size image fetch has no Loading full size line or failure note yet." },
  { file: "LocalVmWorkspace.tsx", swallowed: 10, reason: "Audit systemic note: LocalVmWorkspace.tsx x11 are teardown and control-release calls, not user actions. First in line for the follow-up triage." },
  { file: "MediaPlayer.tsx", swallowed: 1, reason: "element.play() after a source refresh; the browser refuses autoplay and the player's own controls stay." },
  { file: "MemorySettings.tsx", swallowed: 1, reason: "Audit Low (MemorySettings.tsx refresh-token family): the reload after a change made elsewhere on the page is background; every press now goes through the section action line." },
  { file: "ModelPicker.tsx", swallowed: 1, reason: "localStorage write for the picker's own preference; a blocked store is not a failed action." },
  { file: "NewsSignupSettings.tsx", swallowed: 1, reason: "Status read at mount (/api/news); no answer means this home has no news signup (Cloud), so the card stays hidden on purpose. The join action itself shows its outcome." },
  { file: "PhoneNotifications.tsx", swallowed: 3, reason: BACKGROUND },
  { file: "PluginsPanel.tsx", swallowed: 1, reason: "Audit Medium/Low (PluginsPanel.tsx:1431 family): follow-up read after a Reconnect or Retry that has its own notice." },
  { file: "SkillRecorderPage.tsx", swallowed: 5, reason: "Audit Low (SkillRecorderPage.tsx:363,446): stopping capture and closing transcription during teardown; the Finishing recording label is the open Low row." },
  { file: "SubscriptionSignIn.tsx", swallowed: 3, reason: "Audit Low (SubscriptionSignIn.tsx:85): refresh after a sign-in that already succeeded; the Checking label on submit is the open Low row." },
  { file: "TeamLibraryPanel.tsx", voidOnClick: 1, reason: "Opens a team's detail page in the browser; the link stays on the card if the open fails. Not in the audit; to triage." },
  { file: "TelegramSettings.tsx", swallowed: 1, reason: "Audit Low (TelegramSettings.tsx:92): re-reads status after a refused save so the real state shows; the refusal itself is thrown on." },
  { file: "DiagnosticDetails.tsx", refOnly: 1, reason: "Export guard held in a ref only; the Low pending cue (disable and 'Exporting') is not built yet. Not in the audit; to triage." },
  { file: "EngineSetup.tsx", refOnly: 1, reason: "Check guard held in a ref only. Audit Low (FirstRunCard.tsx:535 family): Checking label not built yet." },
  { file: "FilesDialog.tsx", refOnly: 1, reason: "Gate held in a ref only; the dialog's buttons do not dim while a native action runs. Not in the audit; to triage." },
  { file: "InboxDialog.tsx", refOnly: 1, reason: "Gate held in a ref only; approval rows have their own busy label. Audit Low (InboxMemoryWaiting.tsx:66 family)." },
  { file: "TaskPicker.tsx", refOnly: 1, reason: "Export-pending guard held in a ref only; Low pending cue for Export. Not in the audit; to triage." },
];

/**
 * Audit rows with no code pattern the scanner can see (a missing label, a missing
 * "Saved" cue, a swallow in src/lib or App.tsx). They are open work, not exceptions
 * to a rule, and each one goes when its fix lands. From the 2026-10-16 audit,
 * including its "Coverage completion" section.
 */
export const OPEN_ROWS: Array<{ where: string; severity: "Medium" | "Low"; reason: string }> = [
  { where: "App.tsx:348,351,355", severity: "Medium", reason: "Closing the local desktop viewer swallows the control release and viewer-close failures; needs a 'Could not hand control back' line on the You have the wheel card." },
  { where: "lib/i18n.ts:33-37", severity: "Medium", reason: "A failed language pack load falls back to English without a word; setLocale needs to report the fallback next to the Language control." },
  { where: "lib/open-external.ts:106", severity: "Medium", reason: "A rejected native openExternal only reaches console.warn on the phone app; needs a 'Could not open that link. Copy it instead.' toast." },
  { where: "GroupView.tsx:1300", severity: "Low", reason: "Make this channel a project closes the dialog before the reply; keep it open with Creating until the PATCH answers." },
  { where: "ComputerPanel.tsx:1396", severity: "Low", reason: "Hand back closes the viewer whatever release returned, and the failure text sits at the top of the panel." },
  { where: "ComputerPanel.tsx:1521,1560,1566,1585", severity: "Low", reason: "Computer settings pickers show a failure only as the 6 s global banner; need a Saved cue beside each picker." },
  { where: "ModelPicker.tsx:265,283", severity: "Low", reason: "Picking a model closes the popover at once; a refused save shows only in the global banner." },
  { where: "InspectorPanel.tsx:231", severity: "Low", reason: "Reload from disk has no pending state and its failure reads as a raw status." },
  { where: "LocalVmWorkspace.tsx:455,683", severity: "Low", reason: "Take control never changes its label, and returns silently when the bridge is missing." },
  { where: "components/EngineManagement.tsx:61 and the rest of the audit's Medium and Low table", severity: "Low", reason: "Pending, progress and Saved cues for the remaining Medium and Low rows; migrate to useAction opportunistically." },
];

const files = readdirSync(componentsDir).filter(name => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)).sort();
const found = new Map(files.map(name => [name, scanSource(name, readFileSync(join(componentsDir, name), "utf8"))]));
const count = (name: string, rule: Finding["rule"]) => (found.get(name) ?? []).filter(item => item.rule === rule).length;

describe("the scanner", () => {
  const rules = (source: string) => scanSource("t.tsx", source).map(item => item.rule);
  it("finds a swallowed catch in each of its forms", () => {
    expect(rules("const a = () => p.catch(() => {});")).toEqual(["swallowed-catch"]);
    expect(rules("const a = () => p.catch(() => undefined);")).toEqual(["swallowed-catch"]);
    expect(rules("const a = () => p.catch(function () {});")).toEqual(["swallowed-catch"]);
    expect(rules("try { x(); } catch {}")).toEqual(["swallowed-catch"]);
    expect(rules("try { x(); } catch (e) { }")).toEqual(["swallowed-catch"]);
  });
  it("leaves a catch that does something, or says why in a comment", () => {
    expect(rules("p.catch(error => setError(message(error)));")).toEqual([]);
    expect(rules("p.catch(() => null);")).toEqual([]);
    expect(rules("try { x(); } catch { /* a blocked store is not a failure */ }")).toEqual([]);
    expect(rules("try { x(); } catch (e) { setError(e); }")).toEqual([]);
  });
  it("finds a void-ed raw call in an onClick, and only there", () => {
    expect(rules("const a = <button onClick={() => void api('/x')} />;")).toEqual(["void-onclick"]);
    expect(rules("const a = <button onClick={() => { go(); void window.muragebox.open(p); }} />;")).toEqual(["void-onclick"]);
    expect(rules("const a = <button onClick={() => void perform('x')} />;")).toEqual(["void-onclick"]);
    expect(rules("const a = <button onClick={() => void save.run()} />;")).toEqual([]);
    expect(rules("const a = <button onClick={() => void act(() => api('/x'))} />;")).toEqual([]);
    expect(rules("useEffect(() => { void api('/x'); }, []);")).toEqual([]);
  });
  it("finds a busy flag that is only a ref, and not one with state beside it", () => {
    expect(rules("function C() { const busy = useRef(false); return null; }")).toEqual(["ref-only-busy"]);
    expect(rules("function C() { const mounted = useRef(false), inFlight = useRef(false); return null; }")).toEqual(["ref-only-busy"]);
    expect(rules("function C() { const gate = useRef(false); const [busy, setBusy] = useState(false); return null; }")).toEqual([]);
    expect(rules("function C() { const el = useRef(null); const mounted = useRef(false); return null; }")).toEqual([]);
  });
});

describe("every user action shows what happened", () => {
  const listed = new Map(ALLOWED.map(entry => [entry.file, entry]));

  it("lists each exception once, with a real reason, for a file that exists", () => {
    expect(new Set(ALLOWED.map(entry => entry.file)).size).toBe(ALLOWED.length);
    for (const entry of ALLOWED) {
      expect(existsSync(join(componentsDir, entry.file)), `${entry.file} no longer exists: remove its entry`).toBe(true);
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThanOrEqual(40);
      expect((entry.swallowed ?? 0) + (entry.voidOnClick ?? 0) + (entry.refOnly ?? 0), `${entry.file} has an entry with nothing in it`).toBeGreaterThan(0);
    }
  });

  it("keeps a reason on every open audit row it cannot scan for", () => {
    for (const row of OPEN_ROWS) expect(row.reason.length, row.where).toBeGreaterThanOrEqual(40);
    expect(new Set(OPEN_ROWS.map(row => row.where)).size).toBe(OPEN_ROWS.length);
  });

  const ratchet = (rule: Finding["rule"], key: "swallowed" | "voidOnClick" | "refOnly", what: string, fix: string) =>
    it(what, () => {
      const problems: string[] = [];
      for (const name of files) {
        const actual = count(name, rule);
        const allowed = listed.get(name)?.[key] ?? 0;
        if (actual > allowed) {
          const where = (found.get(name) ?? []).filter(item => item.rule === rule).map(item => `  ${name}:${item.line}  ${item.text}`).join("\n");
          problems.push(`${name} has ${actual} (allowed ${allowed}). ${fix}\n${where}`);
        } else if (actual < allowed) problems.push(`${name} now has ${actual}, the list allows ${allowed}. Lower it in ALLOWED (or remove the entry): the list only shrinks.`);
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });

  ratchet("swallowed-catch", "swallowed", "has no new swallowed catches in src/components", "Show the failure to the person (useAction, or a visible line), or handle it and say why.");
  ratchet("void-onclick", "voidOnClick", "has no new onClick that voids a network, OS or perform call", "Run it through useAction or ActionButton so it shows pending, success and failure.");
  ratchet("ref-only-busy", "refOnly", "has no new busy flag held only in a ref", "Mirror it into useState (or use useAction) so the control re-renders while work runs.");
});
