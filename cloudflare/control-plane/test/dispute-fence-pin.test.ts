// SPDX-License-Identifier: AGPL-3.0-or-later
// DISPUTE-FENCE-ACCOUNT round 2 (Astra + Opus reviews of 1b5ee3eac): THE PIN. An open account-level dispute stops every credit grant and every
// cap RAISE through ONE choke point each (flux-grant-fence.ts allocateFenceRevision for op "grant"; flux-dispute-fence.ts capRaiseFence inside the
// cap UPDATE of changeCap). This test scans src/ and fails when a NEW path that sends a credit grant or writes a cap skips the choke point, unless
// it is added to an allowlist below WITH A REASON. Reversals, refunds, lowering and switching off stay allowed, so they are not choked.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0147_flux_account_dispute_fence.sql?raw";
import { CREDIT_RAISING_OPS } from "../src/flux-grant-fence";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const SRC = import.meta.glob("../src/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.entries(SRC).map(([path, text]) => ({ name: path.replace("../src/", ""), text }));
const filesWith = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.name).sort();

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The scanners. Pure functions over { name, text } so SELF-TESTS below can feed them each bypass shape and prove it is caught.
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Src = { name: string; text: string };
const CAP_COLUMNS = /\b(cap_microcents|spending_off)\b/i;

/** Source with comments blanked out (positions kept), so a comment can neither hide nor fake a match. `//` counts only at a line start or after whitespace (not in a URL). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[\s;{}(,])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}
/** End of the SQL string that contains `from`: the next unescaped quote of the kind that opened it, outside any `${...}`; also ends at a top-level `;`. */
function statementEnd(text: string, from: number, openerFrom = from): number {
  let opener = "`";
  for (let i = openerFrom - 1; i >= 0; i--) { if (text[i] === "`" || text[i] === '"') { opener = text[i]; break; } }
  let brace = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "$" && text[i + 1] === "{") { brace++; i++; continue; }
    if (brace > 0) { if (c === "{") brace++; else if (c === "}") brace--; continue; }
    if (c === opener && text[i - 1] !== "\\") return i;
    if (c === ";") return i;
  }
  return text.length;
}
/** The top-level assignments of a SET clause starting at `from` (after the word SET): cut at the first WHERE at paren depth 0, split at commas at depth 0. */
function setAssignments(text: string, from: number, end: number): string[] {
  const out: string[] = []; let depth = 0; let brace = 0; let cur = "";
  for (let i = from; i < end; i++) {
    const c = text[i];
    if (c === "$" && text[i + 1] === "{") { brace++; cur += "${"; i++; continue; }
    if (brace > 0) { if (c === "{") brace++; else if (c === "}") brace--; cur += c; continue; }
    if (c === "(") depth++; else if (c === ")") depth--;
    if (depth === 0 && /^where\b/i.test(text.slice(i, i + 6)) && (i === 0 || /\W/.test(text[i - 1]))) break;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** Does this top-level SET assignment write a cap column? An interpolated `${name}` is looked up as `const name = ...;` in the file; one that cannot be resolved counts as a cap write when the table is flux_home_keys (the only cap table). */
const assignsCap = (assignment: string, file: string, onKeyTable: boolean, depth = 0): boolean => {
  const interp = /^\s*\$\{\s*([A-Za-z_]\w*)\s*\}\s*$/.exec(assignment);
  if (interp) {
    const def = new RegExp(`\\b(?:const|let)\\s+${interp[1]}\\s*=\\s*([^;]*);`).exec(file);
    if (!def || depth > 3) return onKeyTable;
    return setAssignments(def[1], 0, def[1].length).some((a) => assignsCap(a.replace(/^[\s"'`]+|[\s"'`]+$/g, ""), file, onKeyTable, depth + 1));
  }
  if (/^\s*\$\{/.test(assignment)) return onKeyTable;
  if (assignment.includes("${") && onKeyTable) return true; // an interpolation INSIDE an assignment (`updated_at=?${extra}`) could carry a cap column
  const lhs = /^\s*([^=]*?)\s*=/.exec(assignment)?.[1] ?? "";
  return CAP_COLUMNS.test(lhs);
};
interface CapWrite { file: string; key: string; stmt: string; after: string; before: string }
interface Update { file: string; table: string; capWrite: boolean; key: string; stmt: string; after: string; before: string }
/** Joins `"abc" + "def"` string pieces (the seam), so SQL built with + reads as one statement. */
const joinSeams = (text: string): string => text.replace(/["'`]\s*\+\s*["'`]/g, "");
/** A SQL identifier as it can appear in JS source: plain, "double", `back`, [bracket] or 'single' quoted (with a backslash escape inside a JS string), or a ${placeholder}. */
const IDENT = String.raw`(?:\\?["'\`\[]?[\w.]+\\?["'\`\]]?|\$\{[^}]*\})`;
const UPDATE_RE = new RegExp(String.raw`\b(?:(DO)\s+)?UPDATE(?:\s+OR\s+\w+)?(?:\s+(${IDENT}))?(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b`, "gi");
const bareIdent = (t: string) => t.replace(/[\\"'`\[\]]/g, "");
/** Every UPDATE ... SET statement (and the SET of INSERT ... ON CONFLICT DO UPDATE SET) in the file, with whether it assigns a cap column. A table that is a ${placeholder} counts as the key table. */
function parseUpdates(f: Src): Update[] {
  const text = joinSeams(stripComments(f.text));
  const out: Update[] = [];
  for (const m of text.matchAll(UPDATE_RE)) {
    const isUpsert = !!m[1];
    const rawTable = m[2];
    const setAt = m.index! + m[0].length;
    if (!isUpsert && !rawTable) continue;
    const end = statementEnd(text, setAt, m.index!);
    const assigns = setAssignments(text, setAt, end);
    const target = isUpsert ? [...text.slice(0, m.index!).matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+\\?["'`\[]?(\w+)/gi)].pop()?.[1] : rawTable && bareIdent(rawTable);
    const unknown = !target || target.startsWith("${");
    const onKeyTable = unknown || /^flux_home_keys$/i.test(target);
    out.push({ file: f.name, table: target ?? "?", capWrite: assigns.some((a) => assignsCap(a, text, onKeyTable)) || (unknown && /\bcap_microcents|\bspending_off/i.test(text.slice(setAt, end))),
      key: `${f.name}:${text.slice(m.index!, m.index! + 60).replace(/\s+/g, " ")}`, stmt: text.slice(m.index!, end), after: text.slice(end, end + 700), before: text.slice(0, m.index!) });
  }
  return out;
}
/** Every SQL statement in the file that assigns a cap column: UPDATE ... SET, and the SET of INSERT ... ON CONFLICT DO UPDATE SET (any case, any quoting, any alias, UPDATE OR x). */
const capWrites = (f: Src): CapWrite[] => parseUpdates(f).filter((u) => u.capWrite);
/** An UPDATE of flux_home_keys the parser could not read at all (normalised text names `update ... flux_home_keys`, but no statement was parsed for it): refuse, a reviewer must look. */
function unparsedKeyUpdates(f: Src): string[] {
  const norm = joinSeams(stripComments(f.text)).toLowerCase().replace(/[\\"'`\[\]]/g, "").replace(/\s+/g, " ");
  const named = (norm.match(/\bupdate (?:or \w+ )?flux_home_keys\b/g) ?? []).length;
  const parsed = parseUpdates(f).filter((u) => /^flux_home_keys$/i.test(u.table)).length;
  return named > parsed ? [`${f.name}: an UPDATE of flux_home_keys whose SET could not be parsed (${named} named, ${parsed} parsed)`] : [];
}
/** Why a cap write is not fenced, or null. The fence must be IN this statement (its WHERE), built by capRaiseFence in the SAME function, and its binds must follow. */
function unfencedReason(w: CapWrite): string | null {
  if (!w.stmt.includes("${fence.sql}")) return "the statement does not contain ${fence.sql}";
  const fnAt = w.before.lastIndexOf("function ");
  const scope = w.before.slice(fnAt === -1 ? 0 : fnAt);
  if (!/const\s+fence\s*=\s*capRaiseFence\(/.test(scope)) return "fence is not built by capRaiseFence in the same function";
  if (!/\.\.\.fence\.binds/.test(w.after)) return "the fence binds do not follow the statement";
  return null;
}
/** Findings (strings) for every unallowlisted unfenced cap write across `fs`. */
function capFindings(fs: Src[], allowed: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const f of fs) for (const w of capWrites(f)) {
    if (allowed[w.key]) continue;
    const why = unfencedReason(w);
    if (why) out.push(`${w.key} -- ${why}`);
  }
  for (const f of fs) out.push(...unparsedKeyUpdates(f));
  return out;
}
/** Findings for credit-grant dispatch outside the choke point, in ANY module: the Flux grant endpoint (path constant or literal) or its URL/token env, used anywhere but flux-grants.ts, or a non-GET call there outside fencedMutation (before its allocation). */
function grantDispatchFindings(fs: Src[]): string[] {
  const out: string[] = [];
  const ENDPOINT = /\b(GRANT_PATH|CAPABILITIES_PATH|ELIGIBILITY_PATH|FLUX_CLOUD_GRANTS_URL)\b|credit-grants/g;
  for (const f of fs) {
    const text = stripComments(f.text).replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?/gm, (m) => " ".repeat(m.length));
    if (!/^flux-grants\.ts$/.test(f.name) && !/^env-policy\./.test(f.name)) {
      // A use is allowed only as the path handed to fencedMutation( (the same statement, no ; between).
      for (const m of text.matchAll(ENDPOINT)) {
        const before = text.slice(Math.max(0, m.index! - 300), m.index!);
        const at = before.lastIndexOf("fencedMutation(");
        if (at === -1 || before.slice(at).includes(";")) out.push(`${f.name}: reaches the Flux grant endpoint outside flux-grants.ts (${m[0]})`);
      }
    }
    if (f.name !== "flux-grants.ts") continue;
    const start = text.indexOf("export async function fencedMutation");
    const end = start < 0 ? -1 : text.indexOf("\n}\n", start);
    if (start < 0) { out.push(`${f.name}: fencedMutation not found`); continue; }
    const alloc = text.indexOf("allocateFenceRevision(", start);
    for (const m of text.matchAll(/(?<!function\s)\bcall\(\s*\w+\s*,\s*\w+\s*,\s*([^,]+),/g)) {
      if (/^\s*["'`]GET["'`]\s*$/.test(m[1])) continue;
      const inFenced = m.index! > start && m.index! < end;
      if (!inFenced) out.push(`${f.name}: a non-GET call (${m[1].trim()}) outside fencedMutation`);
      else if (alloc < 0 || alloc > m.index!) out.push(`${f.name}: a non-GET call before allocateFenceRevision inside fencedMutation`);
    }
    // A raw network call anywhere in flux-grants.ts but the two default FetchLike arrows `(u, i) => fetch(u, i)`: every request must go through call() (Astra M).
    const rawNet = text.replace(/\(u, i\) => fetch\(u, i\)/g, "").match(/(?<![\w$])(?:[\w$.]+\.)?fetch\s*\(|new\s+Request\s*\(|XMLHttpRequest|\bsendBeacon\s*\(/g);
    if (rawNet) out.push(`${f.name}: a raw network call (${rawNet.map((r) => r.trim()).join(", ")}) outside call()`);
    const callFnAt = text.indexOf("async function call(");
    const callFnEnd = callFnAt < 0 ? -1 : text.indexOf("\n}\n", callFnAt);
    for (const m of text.matchAll(/\bdoFetch\(/g)) {
      const inCall = m.index! > callFnAt && m.index! < callFnEnd;
      const ensure = /ENSURE_ACCOUNT_PATH/.test(text.slice(m.index!, m.index! + 160));
      if (!inCall && !ensure) out.push(`${f.name}: a direct doFetch outside call()`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Round 3 (Astra M + Opus L1): the OCCURRENCE SNAPSHOT. Structural scanners can be dodged by SQL shape (a quoted identifier, UPDATE OR IGNORE, an alias, a
// ${table}, a + join, an interpolated suffix). This one cannot: every file under src/ is lowercased with quotes, backticks and brackets stripped (string pieces
// joined across +), and the occurrences of the tokens that make up a cap write or a Flux credit grant are COUNTED per file and compared with a checked-in map.
// A new file, a new site or a changed count fails until a reviewer has confirmed the site goes through capRaiseFence (cap writes) or allocateFenceRevision
// (credit grants) and updated the map. Comments are NOT stripped here (a `//` inside a string must not be able to hide a token), so a comment that names a
// token counts too: that is deliberate, it keeps the map honest.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const OCCURRENCE_TOKENS = ["cap_microcents", "spending_off", "flux_home_keys", "grant_path", "capabilities_path", "eligibility_path", "flux_cloud_grants_url", "credit-grants", "/grant"] as const;
const normalizeForCount = (text: string): string => joinSeams(text).toLowerCase().replace(/[`'"\[\](){}]/g, "");
function occurrenceCounts(text: string): Record<string, number> {
  const norm = normalizeForCount(text);
  const out: Record<string, number> = {};
  for (const t of OCCURRENCE_TOKENS) { const n = norm.split(t).length - 1; if (n > 0) out[t] = n; }
  return out;
}
const sameCounts = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function occurrenceFindings(fs: Src[], snapshot: Record<string, Record<string, number>>): string[] {
  const out: string[] = [];
  const names = new Set(fs.map((f) => f.name));
  for (const f of fs) {
    const now = occurrenceCounts(f.text);
    const was = snapshot[f.name] ?? {};
    if (!sameCounts(now, was)) out.push(`${f.name}: occurrences changed, was ${JSON.stringify(was)} now ${JSON.stringify(now)} -- a reviewer must confirm the new site goes through capRaiseFence or allocateFenceRevision (cap writes use capRaiseFence, credit grants use allocateFenceRevision), then update OCCURRENCE_SNAPSHOT`);
  }
  for (const n of Object.keys(snapshot)) if (!names.has(n)) out.push(`${n}: in OCCURRENCE_SNAPSHOT but no longer under src/ -- a reviewer must confirm a removed site (capRaiseFence or allocateFenceRevision) and update OCCURRENCE_SNAPSHOT`);
  return out;
}

/** The op label is bound to the path in every fencedMutation( call, in every module: GRANT_PATH only with op "grant", /reverse only with "reverse", /reversal-target only with "target", and both literal. */
function opBindingFindings(fs: Src[]): string[] {
  const out: string[] = [];
  const PAIRS: Record<string, string> = { "GRANT_PATH": "grant", "`${GRANT_PATH}/reverse`": "reverse", "`${GRANT_PATH}/reversal-target`": "target" };
  for (const f of fs) {
    const text = stripComments(f.text).replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?/gm, (m) => " ".repeat(m.length));
    for (const m of text.matchAll(/(?<![\w$.])fencedMutation\b(?!\s*\()/g)) { if (!/function\s+$/.test(text.slice(0, m.index!))) out.push(`${f.name}: fencedMutation used other than as a direct call`); }
    for (const m of text.matchAll(/(?<![\w$.])fencedMutation\s*\(/g)) {
      if (/function\s+$/.test(text.slice(0, m.index!))) continue; // the definition
      let depth = 0; let i = m.index! + m[0].length - 1; const start = i;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === "`") { const q = c; for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++; continue; }
        if (c === "(") depth++; else if (c === ")" && --depth === 0) break;
      }
      const args = text.slice(start, i);
      const op = /(?<![\w$.])op\s*:\s*(["'])([a-z]+)\1/.exec(args)?.[2];
      const path = /(?<![\w$.])path\s*:\s*(`[^`]*`|[^,}]+)/.exec(args)?.[1]?.replace(/\s+/g, "");
      if (!op) { out.push(`${f.name}: a fencedMutation call whose op is not a string literal`); continue; }
      if (!path || !(path in PAIRS)) { out.push(`${f.name}: a fencedMutation call (op "${op}") whose path is not one of the three known Flux paths (${path ?? "none"})`); continue; }
      if (PAIRS[path] !== op) out.push(`${f.name}: op "${op}" is sent to ${path}, which needs op "${PAIRS[path]}"`);
    }
  }
  return out;
}
// Reviewed 2026-11-06 at 7962470f2 + round 3. Every cap_microcents / spending_off / flux_home_keys site goes through capRaiseFence (b4-flux.ts changeCap), every grant site through
// fencedMutation -> allocateFenceRevision (flux-grants.ts). To change a count: a reviewer confirms the NEW site, then edits this map.
const OCCURRENCE_SNAPSHOT: Record<string, Record<string, number>> = {
  "alert-tiers.ts": { "spending_off": 3 }, // release 8b: the two 8b resume alerts mention spending_off in text only (no write)
  "b3-control.ts": { "flux_home_keys": 1 },
  "b4-flux-ledger.ts": { "flux_home_keys": 1, "credit-grants": 2, "/grant": 2 },
  "b4-flux-renewal.ts": { "spending_off": 3, "flux_home_keys": 1 },
  "b4-flux.ts": { "cap_microcents": 44, "spending_off": 103, "flux_home_keys": 63, /* release 8b: poller resume (resumeStatements, hold/resume WHERE clauses, ack and stop-check writes); every cap write still carries the dispute fence in changeCap */ "grant_path": 3, "flux_cloud_grants_url": 1, "credit-grants": 1, "/grant": 2 },
  "env-policy.d.mts": { "flux_cloud_grants_url": 2 },
  "env-policy.mjs": { "flux_cloud_grants_url": 1 },
  "flux-dispute-fence.ts": { "cap_microcents": 1, "spending_off": 1, "flux_home_keys": 1 },
  "flux-email-proof.ts": { "flux_home_keys": 2 },
  "flux-grants-cutover.ts": { "/grant": 1 },
  "flux-grants.ts": { "grant_path": 9, "capabilities_path": 3, "eligibility_path": 2, "flux_cloud_grants_url": 18, "credit-grants": 6, "/grant": 1 },
  "flux-live-hooks.ts": { "flux_cloud_grants_url": 1 },
  "index.ts": { "spending_off": 3 },
  "step-up-email.ts": { "flux_home_keys": 4 },
  "topup-charge.ts": { "spending_off": 2, "flux_home_keys": 2 },
};

describe("dispute fence pin: every cap write goes through capRaiseFence", () => {
  it("every statement that assigns cap_microcents or spending_off (UPDATE or upsert, any case, any right side) carries the cap fence built in its own function", () => {
    // Allowlist of statements that assign a cap column and cannot raise the effective cap. Empty today: add `file:first-60-chars` WITH A REASON.
    const ALLOWED: Record<string, string> = {};
    const writes = files.flatMap(capWrites);
    expect(writes.length).toBeGreaterThan(0); // the scan really found the changeCap UPDATE
    expect(capFindings(files, ALLOWED)).toEqual([]);
  });

  it("cap values are assigned in b4-flux.ts changeCap only", () => {
    expect([...new Set(files.flatMap(capWrites).map((w) => w.file))]).toEqual(["b4-flux.ts"]);
  });

  it("new key rows (the only other cap-bearing write) are created in b4-flux.ts, at the default cap, held by the dispute and refused at the key claim and commit; no REPLACE writes", () => {
    expect(filesWith(/INTO\s+flux_home_keys/i)).toEqual(["b4-flux.ts"]);
    expect(filesWith(/REPLACE\s+INTO\s+flux_home_keys/i)).toEqual([]);
  });
});

describe("dispute fence pin: every credit grant to Flux goes through allocateFenceRevision's grant check", () => {
  it("credit-raising ops are exactly the grant; reversals, targets and operator adjustments are never choked", () => {
    expect([...CREDIT_RAISING_OPS]).toEqual(["grant"]);
  });

  it("the choke point is in the allocation statement itself", () => {
    const fence = SRC["../src/flux-grant-fence.ts"];
    const body = fence.slice(fence.indexOf("export async function allocateFenceRevision"), fence.indexOf("export async function abandonFenceRevision"));
    expect(body).toContain("CREDIT_RAISING_OPS");
    expect(body).toContain("homeDisputeOpenSql(");
  });

  it("no module reaches the Flux grant endpoint but flux-grants.ts, and its non-GET calls sit in fencedMutation after the allocation", () => {
    expect(files.some((f) => f.name === "flux-grants.ts")).toBe(true);
    expect(grantDispatchFindings(files)).toEqual([]);
    expect(opBindingFindings(files)).toEqual([]); // op is a literal bound to its path in every fencedMutation call
    const g = SRC["../src/flux-grants.ts"];
    expect(g.slice(g.indexOf("export async function fencedMutation"))).toContain("allocateFenceRevision(");
  });

  it("the callers of allocateFenceRevision are exactly: fencedMutation (grant, reverse, target) and the two operator adjustments", () => {
    // The operator ones (an operator's dispute-credit claim, a ledger adjustment) are accounting corrections: they reconcile a grant already made and paid.
    // They CAN restore credit (an operator restores a failed refund), and the reversal target can give value back when it is lowered (the coverage
    // reconciler, b5-billing.ts). That is an EXPLICIT EXCEPTION to the fence, not a claim that they only remove credit: test/h1-flux-fence.test.ts
    // ("Astra M3") shows the restoration while a dispute stands.
    expect(files.filter((f) => f.name !== "flux-grant-fence.ts" && /allocateFenceRevision\(/.test(f.text)).map((f) => f.name).sort())
      .toEqual(["b4-flux-ledger.ts", "b5-billing.ts", "flux-grants.ts"]);
    expect(SRC["../src/b4-flux-ledger.ts"].match(/allocateFenceRevision\([^)]*\)/g)).toEqual(['allocateFenceRevision(db, { grantId: wire, token, epoch: fenceEpoch }, { op: "operator" })']);
    expect(SRC["../src/b5-billing.ts"].match(/allocateFenceRevision\([^)]*\)/g)).toEqual(['allocateFenceRevision(env.DB, c, { op: "operator" })']);
  });

  it('op: "grant" is written only where fencedMutation is called for a grant (B4 sendGrant client, B5 grantMonthlyCredits)', () => {
    expect(filesWith(/op: "grant"/)).toEqual(["b4-flux.ts", "flux-grants.ts"]);
  });

  it("grant OBLIGATION rows (flux_grants, credit_grants) are inserted only in the two billing writers; the Flux request is made later, through the choke point", () => {
    expect(filesWith(/INSERT (OR IGNORE )?INTO (flux_grants|credit_grants)\b/i)).toEqual(["b4-flux.ts", "b5-billing.ts"]);
  });
});

describe("dispute fence pin SELF-TEST: each bypass shape is caught by the scanners", () => {
  const GOOD_CAP = "async function changeCap() {\n const fence = capRaiseFence(h, c, o);\n await db.prepare(`UPDATE flux_home_keys SET plan=?,cap_microcents=? WHERE home_id=? AND ${fence.sql}`).bind(a, ...fence.binds);\n}\n";
  const cap = (body: string, name = "x.ts") => capFindings([{ name, text: `async function bad() {\n ${body}\n}\n` }]);
  const capShapes: [string, string][] = [
    ["lowercase update", "db.prepare(`update flux_home_keys set cap_microcents=60000000 where home_id=?`);"],
    ["numeric right side", "db.prepare(`UPDATE flux_home_keys SET cap_microcents=60000000 WHERE home_id=?`);"],
    ["spending switched on", "db.prepare(`UPDATE flux_home_keys SET spending_off=0 WHERE home_id=?`);"],
    ["upsert DO UPDATE SET", "db.prepare(`INSERT INTO flux_home_keys (home_id,cap_microcents) VALUES (?,1) ON CONFLICT(home_id) DO UPDATE SET cap_microcents=excluded.cap_microcents`);"],
    ["lowercase upsert", "db.prepare(`insert into t (a) values (1) on conflict(a) do update set spending_off=0`);"],
    ["cap behind a subquery WHERE in SET", "db.prepare(`UPDATE flux_home_keys SET note=(SELECT 1 FROM t WHERE x=1), cap_microcents=60000000 WHERE home_id=?`);"],
    ["interpolated SET list", "db.prepare(`UPDATE flux_home_keys SET ${sets} WHERE home_id=?`);"],
    ["double-quoted statement", 'db.prepare("UPDATE flux_home_keys SET cap_microcents=9 WHERE home_id=?");'],
    // Round 3: every shape both reviewers named.
    ["quoted identifier (Astra M)", 'db.prepare(\'UPDATE "flux_home_keys" SET cap_microcents=9 WHERE home_id=?\');'],
    ["bracket-quoted identifier", "db.prepare(`UPDATE [flux_home_keys] SET cap_microcents=9 WHERE home_id=?`);"],
    ["backtick-quoted identifier", 'db.prepare("UPDATE `flux_home_keys` SET cap_microcents=9 WHERE home_id=?");'],
    ["UPDATE OR IGNORE", "db.prepare(`UPDATE OR IGNORE flux_home_keys SET cap_microcents=9 WHERE home_id=?`);"],
    ["UPDATE OR REPLACE", "db.prepare(`UPDATE OR REPLACE flux_home_keys SET spending_off=0 WHERE home_id=?`);"],
    ["table alias", "db.prepare(`UPDATE flux_home_keys AS k SET cap_microcents=9 WHERE k.home_id=?`);"],
    ["interpolated table name", "db.prepare(`UPDATE ${table} SET cap_microcents=9 WHERE home_id=?`);"],
    ["SQL joined with +", 'db.prepare("UPDATE flux_home_keys SET " + "cap_microcents=9 WHERE home_id=?");'],
    ["cap column carried in an interpolated suffix", "db.prepare(`UPDATE flux_home_keys SET updated_at=?${extra} WHERE home_id=?`);"],
    ["mixed case and odd spacing", "db.prepare(`UpDaTe   flux_home_keys\n SeT\n  Cap_Microcents = 9 WHERE home_id=?`);"],
  ];
  for (const [name, body] of capShapes) it(`cap write caught: ${name}`, () => { expect(cap(body).length, name).toBeGreaterThan(0); });
  it("a cap write in a SUBFOLDER module is caught (the glob is recursive)", () => {
    expect(cap("db.prepare(`UPDATE flux_home_keys SET cap_microcents=1 WHERE home_id=?`);", "sub/dir/x.ts")[0]).toContain("sub/dir/x.ts");
  });
  it("a fence BORROWED from a neighbouring statement does not count (it must be inside the same statement, built in the same function)", () => {
    const borrowed = "async function changeCap() {\n const fence = capRaiseFence(h, c, o);\n db.prepare(`UPDATE flux_home_keys SET cap_microcents=? WHERE home_id=?`).bind(a);\n db.prepare(`SELECT 1 WHERE ${fence.sql}`).bind(...fence.binds);\n}\n";
    expect(capFindings([{ name: "x.ts", text: borrowed }]).join()).toContain("does not contain");
    const foreign = "async function other() {\n const fence = { sql: '1', binds: [] };\n db.prepare(`UPDATE flux_home_keys SET cap_microcents=? WHERE home_id=? AND ${fence.sql}`).bind(a, ...fence.binds);\n}\n";
    expect(capFindings([{ name: "x.ts", text: foreign }]).join()).toContain("capRaiseFence");
    const builtElsewhere = "function a() { const fence = capRaiseFence(h, c, o); }\nfunction b() {\n db.prepare(`UPDATE flux_home_keys SET cap_microcents=? WHERE home_id=? AND ${fence.sql}`).bind(a, ...fence.binds);\n}\n";
    expect(capFindings([{ name: "x.ts", text: builtElsewhere }]).join()).toContain("capRaiseFence");
  });
  it("a comment cannot hide or fake a cap write, and the genuine fenced shape passes", () => {
    expect(capFindings([{ name: "x.ts", text: GOOD_CAP }])).toEqual([]);
    expect(capFindings([{ name: "x.ts", text: "// UPDATE flux_home_keys SET cap_microcents=1 WHERE x\n" }])).toEqual([]);
  });

  const grant = (name: string, text: string) => grantDispatchFindings([{ name: "flux-grants.ts", text: GRANTS_OK }, { name, text }]);
  const GRANTS_OK = "export async function fencedMutation(env, doFetch, a) {\n const w = await allocateFenceRevision(db, c, {});\n await call(env, doFetch, \"POST\", a.path, body);\n}\nasync function call(env, doFetch, method, path) {\n const res = await doFetch(url, {});\n}\nconst x = await call(env, doFetch, \"GET\", P);\n";
  it("the genuine flux-grants.ts shape passes", () => { expect(grantDispatchFindings([{ name: "flux-grants.ts", text: GRANTS_OK }])).toEqual([]); });
  const grantShapes: [string, string, string][] = [
    ["a raw fetch to the path constant in a new top-level module", "x.ts", "import { GRANT_PATH } from './flux-grants';\nawait fetch(`${base}${GRANT_PATH}`, { method: 'POST' });"],
    ["a literal grant URL in a nested module", "sub/y.ts", "await fetch('https://api/internal/cloud-home/credit-grants', { method: 'POST' });"],
    ["the grants URL read in another module", "z.ts", "const t = env.FLUX_CLOUD_GRANTS_URL;"],
    ["a differently spelled POST helper", "w.ts", "await doPost(env.FLUX_CLOUD_GRANTS_URL + p);"],
  ];
  for (const [name, file, text] of grantShapes) it(`grant dispatch caught: ${name}`, () => { expect(grant(file, text).length, name).toBeGreaterThan(0); });
  it("Round 3: a raw fetch / POST to the grant path INSIDE flux-grants.ts is caught", () => {
    const run = (extra: string) => grantDispatchFindings([{ name: "flux-grants.ts", text: GRANTS_OK + extra }]);
    expect(run("async function sneaky(env) { await fetch(`${env.FLUX_CLOUD_GRANTS_URL}${GRANT_PATH}`, { method: 'POST', body }); }\n").length).toBeGreaterThan(0);
    expect(run("async function sneaky(env) { await env.GRANTS.fetch(`https://x/internal/cloud-home/credit-grants`, { method: 'POST' }); }\n").length).toBeGreaterThan(0);
    expect(run("async function sneaky(env) { await new Request(GRANT_PATH, { method: 'POST' }); }\n").length).toBeGreaterThan(0);
  });
  it("Round 3 (Opus L1a): the op label is bound to the path: op target / reverse with GRANT_PATH, op grant with another path, a runtime op, all caught", () => {
    const call = (body: string, name = "x.ts") => opBindingFindings([{ name, text: `async function f() {\n await fencedMutation(env, doFetch, { ${body} });\n}\n` }]);
    expect(call('grantId, homeId, op: "target", path: GRANT_PATH, frozen').length).toBeGreaterThan(0);
    expect(call('grantId, homeId, op: "reverse", path: GRANT_PATH, frozen').length).toBeGreaterThan(0);
    expect(call('grantId, homeId, op: "operator", path: GRANT_PATH, frozen').length).toBeGreaterThan(0);
    expect(call('grantId, homeId, op: "grant", path: `${GRANT_PATH}/reverse`, frozen').length).toBeGreaterThan(0);
    expect(call("grantId, homeId, op: a.op, path: GRANT_PATH, frozen").length).toBeGreaterThan(0);
    expect(call("grantId, homeId, op, path: GRANT_PATH, frozen").length).toBeGreaterThan(0);
    expect(call('grantId, homeId, op: "grant", path: somePath, frozen').length).toBeGreaterThan(0);
    // the genuine pairings pass
    expect(call('grantId, homeId, op: "grant", path: GRANT_PATH, frozen')).toEqual([]);
    expect(call('grantId, homeId, op: "reverse", path: `${GRANT_PATH}/reverse`, frozen')).toEqual([]);
    expect(call('grantId, homeId, op: "target", path: `${GRANT_PATH}/reversal-target`, frozen')).toEqual([]);
  });
  it("grant dispatch caught inside flux-grants.ts: a POST call outside fencedMutation, a non-literal method, a call before the allocation, a direct doFetch", () => {
    const run = (extra: string) => grantDispatchFindings([{ name: "flux-grants.ts", text: GRANTS_OK + extra }]);
    expect(run("async function sneaky(env, doFetch) { await call(env, doFetch, \"POST\", P, b); }\n").join()).toContain("outside fencedMutation");
    expect(run("async function sneaky(env, doFetch, m) { await call(env, doFetch, m, P, b); }\n").join()).toContain("outside fencedMutation");
    expect(run("async function sneaky(env, doFetch) { await doFetch(`${base}${GRANT_PATH}`, { method: 'POST' }); }\n").join()).toContain("direct doFetch");
    const early = "export async function fencedMutation(env, doFetch, a) {\n await call(env, doFetch, \"POST\", a.path, body);\n const w = await allocateFenceRevision(db, c, {});\n}\nasync function call(env, doFetch, method, path) {\n const res = await doFetch(url, {});\n}\n";
    expect(grantDispatchFindings([{ name: "flux-grants.ts", text: early }]).join()).toContain("before allocateFenceRevision");
  });
});

describe("dispute fence pin: the occurrence snapshot (cannot be dodged by SQL shape)", () => {
  const MSG = /capRaiseFence or allocateFenceRevision/;
  it("every file under src/ has exactly the snapshotted counts of cap_microcents, spending_off, flux_home_keys, the grant path (constant, literal, URL env) and /grant; a new file or a changed count needs a reviewer", () => {
    expect(files.length).toBeGreaterThan(20); // the recursive glob really reached src/
    expect(occurrenceFindings(files, OCCURRENCE_SNAPSHOT)).toEqual([]);
  });
  it("a NEW file naming a cap column, the key table, the grant path or /grant fails, and the message tells a reviewer what to confirm", () => {
    for (const text of ["const c = 'cap_microcents';", "const t = 'flux_home_keys';", "const s = 'spending_off';", "x(GRANT_PATH);", "fetch(base + '/internal/cloud-home/credit-grants');", "fetch(`${base}/grant`);"]) {
      const out = occurrenceFindings([...files, { name: "brand-new.ts", text }], OCCURRENCE_SNAPSHOT);
      expect(out.length, text).toBeGreaterThan(0);
      expect(out.join("\n")).toMatch(MSG);
      expect(out.join("\n")).toContain("brand-new.ts");
    }
  });
  it("an existing file that gains (or loses) one occurrence fails", () => {
    const b4 = files.find((f) => f.name === "b4-flux.ts")!;
    expect(occurrenceFindings(files.map((f) => f === b4 ? { ...f, text: f.text + "\n// cap_microcents\n" } : f), OCCURRENCE_SNAPSHOT).join()).toContain("b4-flux.ts");
    expect(occurrenceFindings(files.map((f) => f === b4 ? { ...f, text: f.text.replace(/cap_microcents/, "cap_x") } : f), OCCURRENCE_SNAPSHOT).join()).toContain("b4-flux.ts");
  });
  it("counting ignores case, quotes, backticks and brackets, and sees through a + join of string pieces", () => {
    const shapes = ['"CAP_MICROCENTS"', "`Cap_Microcents`", "[cap_microcents]", "'cap_' + 'microcents'", '"cap_" +\n "microcents"', "'flux_' + \"home_keys\"", '"UPDATE ""flux_home_keys"" SET x"'];
    for (const text of shapes) expect(occurrenceFindings([{ name: "n.ts", text: `const q = ${text};` }], {}).join(), text).toContain("n.ts");
  });
  it("each bypass shape named by Astra and Opus, dropped into a NEW file, is caught by the snapshot as well as by the structural scanner", () => {
    const shapes = [
      'db.prepare(\'UPDATE "flux_home_keys" SET cap_microcents=9 WHERE home_id=?\');', "db.prepare(`UPDATE OR IGNORE flux_home_keys SET cap_microcents=9`);",
      "db.prepare(`UPDATE flux_home_keys AS k SET cap_microcents=9`);", "db.prepare(`UPDATE ${table} SET cap_microcents=9`);",
      'db.prepare("UPDATE flux_home_keys SET " + "cap_microcents=9");', "db.prepare(`UPDATE flux_home_keys SET updated_at=?${extra} WHERE home_id=?`);",
      "await fetch(`${base}${GRANT_PATH}`, { method: 'POST' });", 'await fencedMutation(env, doFetch, { op: "target", path: GRANT_PATH });',
    ];
    for (const text of shapes) expect(occurrenceFindings([{ name: "z.ts", text }], {}).length, text).toBeGreaterThan(0);
  });
  it("a snapshot entry for a file that no longer exists fails (a deleted site is also a change)", () => {
    expect(occurrenceFindings(files, { ...OCCURRENCE_SNAPSHOT, "gone.ts": { cap_microcents: 1 } }).join()).toContain("gone.ts");
  });
});

describe("migration 0147 backfill: disputes that stood before the fence are fenced from the first minute", () => {
  const stmts = () => {
    const at = migration.indexOf("-- BACKFILL");
    expect(at, "0147 has a BACKFILL section").toBeGreaterThan(0);
    return migration.slice(at).split(/;\s*\n/).map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
  };
  const home = (id: string, owner: string) => env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,'ready','ready','sha256:x','k',1,1)`).bind(id, `inst-${id}`, owner).run();
  const keyRow = (id: string) => env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at) VALUES (?,'starter',0,'none',30000000,0,1)`).bind(id).run();
  const alert = (acct: string, home: string, resolvedAt: number | null) => env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at,subject)
    VALUES (?,?,'credit.email_proof_disputed','high',?,777,?,?)`).bind(`alert:email_proof_disputed:${acct}`, home, JSON.stringify({ accountId: acct, by: "ops-linked", rule: "r" }), resolvedAt, `account:${acct}`).run();

  it("a legacy unlinked dispute row and an OPEN linked-dispute alert become open account fences with held key rows; a resolved alert and other accounts do not; a second run changes nothing", async () => {
    for (const [h, o] of [["h-a", "acct-a"], ["h-b", "acct-b"], ["h-c", "acct-c"], ["h-d", "acct-d"]]) { await home(h, o); await keyRow(h); }
    await env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES ('acct-a','legacy note','ops-legacy',0,555)").run();
    await alert("acct-b", "h-b", null);
    await alert("acct-c", "h-c", 900);
    await env.DB.prepare("DELETE FROM flux_account_dispute").run();
    await env.DB.prepare("UPDATE flux_home_keys SET proof_hold=0").run();
    for (let run = 0; run < 2; run++) {
      for (const s of stmts()) await env.DB.prepare(s).run();
      const rows = (await env.DB.prepare("SELECT account_id,version,open,by,at FROM flux_account_dispute ORDER BY account_id").all()).results;
      expect(rows).toEqual([{ account_id: "acct-a", version: 1, open: 1, by: "ops-legacy", at: 555 }, { account_id: "acct-b", version: 1, open: 1, by: "ops-linked", at: 777 }]);
      expect((await env.DB.prepare("SELECT home_id,proof_hold FROM flux_home_keys ORDER BY home_id").all()).results)
        .toEqual([{ home_id: "h-a", proof_hold: 1 }, { home_id: "h-b", proof_hold: 1 }, { home_id: "h-c", proof_hold: 0 }, { home_id: "h-d", proof_hold: 0 }]);
    }
    for (const t of ["flux_email_proof_disputes", "cloud_alerts", "flux_home_keys", "cloud_homes", "flux_account_dispute"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });
});
