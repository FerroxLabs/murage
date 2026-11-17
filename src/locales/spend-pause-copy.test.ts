// SPDX-License-Identifier: AGPL-3.0-or-later
// Copy author: gap-spend. Independent inherited-copy reviewer: salv-spend.
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ledgerProblems, loadCopy, readReviewInputs, shippedMap } from "../../scripts/copy-lint.mjs";
import { ledgerFromRecords } from "../../scripts/copy-review.mjs";
const keys = ["waiting", "limitSetting", "promiseTitle", "promise", "accountBilled", "accountOfLimit"];
const ids = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"].flatMap(code => keys.map(key => `${code}:ux.l2c.pause.${key}`));
it("all 48 inherited pause renderer entries have accepted independent reviews, including a rebuild from records", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const inputs = readReviewInputs(dir), copy = loadCopy(dir);
  for (const ledger of [JSON.parse(inputs.ledgerText!), ledgerFromRecords({ dir })]) {
    expect(ids.filter(id => !ledger.strings[id]), "pause renderer entries awaiting accepted review").toEqual([]);
    const problems = ledgerProblems({ ...inputs, ledgerText: JSON.stringify(ledger), shipped: shippedMap(copy), english: copy.english });
    const reviews = ids.map(id => ledger.strings[id]?.review).filter(Boolean);
    expect(problems.filter(p => ids.some(id => p.includes(id)) || reviews.some(id => p.startsWith(`reviews/${id}.json:`)))).toEqual([]);
  }
});
