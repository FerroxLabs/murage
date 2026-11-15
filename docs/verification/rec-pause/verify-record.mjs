import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ledgerFromRecords } from "../../../scripts/copy-review.mjs";
import { loadCopy, recordId, shippedMap } from "../../../scripts/copy-lint.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const id = "2026-11-11-1019-pause-95b6ea300928";
const bundleText = read("sol-bundle.json");
const bundle = JSON.parse(bundleText);
const recordText = read(`../../../src/locales/copy-lint/reviews/${id}.json`);
assert.equal(recordText, bundleText);
assert.equal(recordId("2026-11-11", "1019-pause", recordText), id);
const dir = fileURLToPath(new URL("../../../src/locales", import.meta.url));
const copy = loadCopy(dir);
const shipped = shippedMap(copy);
const ledger = json("../../../src/locales/copy-lint/reviewed.json");
assert.deepEqual(ledger, ledgerFromRecords({ dir }));
const reReview = json("../rec-pause2/sol-bundle.json");
assert.deepEqual(reReview.reviewer, bundle.reviewer);
assert.equal(reReview.base, "e04baa7044d47a71b4de17c9faf25655aca1ab27");
assert.ok(reReview.scope.includes(id));
const reReviewId = ledger.strings[Object.keys(reReview.strings)[0]].review;
const reReviewText = read(`../../../src/locales/copy-lint/reviews/${reReviewId}.json`);
const reReviewRecord = JSON.parse(reReviewText);
assert.equal(recordId("2026-11-11", "1019-pause-rereview", reReviewText), reReviewId);
assert.deepEqual(reReviewRecord, {
  version: reReview.version,
  reviewer: reReview.reviewer,
  author: reReview.author,
  date: "2026-11-11",
  base: reReview.base,
  scope: reReview.scope,
  strings: reReview.strings,
  files: reReview.files,
});
const corrections = json("corrections.json");
const request = json("re-review-request.json");
assert.equal(corrections.length, 10);
assert.deepEqual(Object.keys(request.strings).sort(), corrections.map((c) => c.id).sort());
assert.deepEqual(Object.keys(reReview.strings).sort(), Object.keys(request.strings).sort());
let passed = 0;
let corrected = 0;
for (const [key, item] of Object.entries(bundle.strings)) {
  if (item.verdict === "pass") {
    assert.equal(shipped.get(key), item.text);
    assert.equal(ledger.strings[key].review, id);
    passed++;
  } else {
    assert.equal(item.verdict, "fail");
    const correction = corrections.find((c) => c.id === key);
    assert.equal(correction.old, item.text);
    assert.equal(correction.new, item.note.split("Corrected string: ")[1]);
    assert.equal(shipped.get(key), correction.new);
    assert.equal(ledger.strings[key].review, reReviewId);
    assert.equal(reReview.strings[key].verdict, "pass");
    assert.equal(reReview.strings[key].text, correction.new);
    assert.equal(reReview.strings[key].en, copy.english[key.slice(key.indexOf(":") + 1)]);
    assert.equal(request.strings[key].text, correction.new);
    assert.equal(request.strings[key].verdict, "");
    corrected++;
  }
}
assert.equal(passed, 126);
assert.equal(corrected, 10);
console.log(`${id}: exact original bundle and record match; hash valid; original 126 passes and 10 fails preserved.`);
console.log(`${reReviewId}: exact Sol re-review fields and verdicts match; hash valid; ledger matches rebuild; all 10 corrections approved.`);
