// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Only an exact, reviewed source expression can be recognized as code.
 * Paths, line numbers, and credential-shaped prefixes never grant an exception. */
export function classifyLayerFindings(findings, allowances) {
  const code = new Set(allowances.map(entry => {
    assert.match(entry.rule, /^[a-z][a-z0-9-]+$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.reason?.trim());
    return `${entry.rule}:${entry.sha256}`;
  }));
  let codeFragments = 0;
  const remaining = findings.filter(finding => {
    const fragment = finding.Match ?? finding.Secret;
    assert.equal(typeof fragment, "string");
    const digest = createHash("sha256").update(fragment).digest("hex");
    if (!code.has(`${finding.RuleID}:${digest}`)) return true;
    codeFragments += 1;
    return false;
  });
  return { findings: remaining, codeFragments };
}
