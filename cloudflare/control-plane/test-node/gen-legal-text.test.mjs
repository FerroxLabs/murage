// SPDX-License-Identifier: AGPL-3.0-or-later
// scripts/gen-legal-text.mjs GEN_CONSTS rules: it may only supply imported names the page cannot resolve. A name the page source defines
// is an error (never a silent override), an unresolved import supplied through it resolves, and an unresolved name without it fails.
// Runs the real script against a tiny fixture site tree. Run with: node --test test-node/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = new URL("../scripts/gen-legal-text.mjs", import.meta.url).pathname;

const SHARED = `export const LEGAL_EFFECTIVE_DATE = "October 18, 2026";\nexport const LEGAL_LAST_UPDATED = "October 18, 2026";\n`;
function pageSource(head, extra = "") {
  return `${head}
export default function Page() {
  return (
    <LegalPage title="T" subtitle="S">
      <LegalSection title="One"><p>Base clause.{DOWNGRADE_LIVE ? <> Downgrade clause.</> : null}</p></LegalSection>
      ${extra}
    </LegalPage>
  );
}
`;
}

function fixture(head) {
  const dir = mkdtempSync(join(tmpdir(), "genlegal-"));
  mkdirSync(join(dir, "_components"));
  writeFileSync(join(dir, "_components", "legal.tsx"), SHARED);
  for (const f of ["cloud-terms", "terms-of-service", "privacy-policy"]) {
    mkdirSync(join(dir, f));
    writeFileSync(join(dir, f, "page.tsx"), pageSource(head));
  }
  return dir;
}

function run(dir, genConsts) {
  const out = join(dir, "out.ts");
  const env = { ...process.env };
  delete env.GEN_CONSTS;
  if (genConsts !== undefined) env.GEN_CONSTS = genConsts;
  try {
    execFileSync("node", [script, dir, out], { env, stdio: "pipe" });
    return { code: 0, stderr: "", out: readFileSync(out, "utf8") };
  } catch (e) {
    return { code: e.status, stderr: String(e.stderr) };
  }
}

test("a GEN_CONSTS name the page source defines is an error, not an override", () => {
  const dir = fixture("const DOWNGRADE_LIVE = true;");
  const r = run(dir, "DOWNGRADE_LIVE=false");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /GEN_CONSTS DOWNGRADE_LIVE: already defined/);
});

test("a GEN_CONSTS name that shadows a shared constant is an error", () => {
  const dir = fixture('import { DOWNGRADE_LIVE } from "x";');
  const r = run(dir, "DOWNGRADE_LIVE=false,LEGAL_EFFECTIVE_DATE=true");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /LEGAL_EFFECTIVE_DATE: already defined/);
});

test("an unresolved import supplied through GEN_CONSTS resolves", () => {
  const dir = fixture('import { DOWNGRADE_LIVE } from "x";');
  const off = run(dir, "DOWNGRADE_LIVE=false");
  assert.equal(off.code, 0, off.stderr);
  assert.ok(!off.out.includes("Downgrade clause."));
  const on = run(dir, "DOWNGRADE_LIVE=true");
  assert.equal(on.code, 0, on.stderr);
  assert.ok(on.out.includes("Downgrade clause."));
});

test("an unresolved identifier without GEN_CONSTS still fails", () => {
  const dir = fixture('import { DOWNGRADE_LIVE } from "x";');
  const r = run(dir, undefined);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unresolved identifier DOWNGRADE_LIVE/);
});

test("a GEN_CONSTS name no page uses is an error", () => {
  const dir = fixture('import { DOWNGRADE_LIVE } from "x";');
  const r = run(dir, "DOWNGRADE_LIVE=false,NOT_USED_ANYWHERE=true");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /NOT_USED_ANYWHERE: never resolved by any page/);
});

const bad = (consts, re) => {
  const r = run(fixture('import { DOWNGRADE_LIVE } from "x";'), consts);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, re);
};
test("trailing garbage after a value is rejected", () => bad("DOWNGRADE_LIVE=false=garbage", /each entry must be NAME=true or NAME=false/));
test("non-boolean values are rejected", () => {
  bad("DOWNGRADE_LIVE=yes", /each entry must be/);
  bad("DOWNGRADE_LIVE=1", /each entry must be/);
  bad('DOWNGRADE_LIVE="true"', /each entry must be/);
  bad("DOWNGRADE_LIVE=", /each entry must be/);
  bad("DOWNGRADE_LIVE", /each entry must be/);
});
test("a malformed name is rejected", () => bad("1BAD=true,DOWNGRADE_LIVE=false", /each entry must be/));
test("a duplicate name is rejected", () => bad("DOWNGRADE_LIVE=false,DOWNGRADE_LIVE=true", /given twice/));
test("a name that appears only in a comment or string is unused", () => {
  const dir = fixture('import { DOWNGRADE_LIVE } from "x";\n// ONLY_IN_COMMENT is mentioned here\nconst note = "ONLY_IN_COMMENT";');
  const r = run(dir, "DOWNGRADE_LIVE=false,ONLY_IN_COMMENT=true");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ONLY_IN_COMMENT: never resolved by any page/);
});
