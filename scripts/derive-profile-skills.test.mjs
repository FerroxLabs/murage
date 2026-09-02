// Guards for the two things in derive-profile-skills.mjs that fail SILENTLY.
//
// 1. Its toMatchExpression is a hand-copy of the server's. If the server's
//    changes, this script keeps searching with the old grammar and every score
//    it prints describes a retrieval the product no longer performs.
// 2. The ownership rule decides which skills belong to another assistant. Too
//    loose and `stage-pitch-deck` ends up on a different profile; too tight and
//    `copy-editing` -- an ordinary library skill that merely starts with the
//    name of the `copy` profile -- is deleted from the book copy editor, which
//    is exactly what a plain prefix rule did.
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { toMatchExpression as server } from "../server/skill-search.ts";
import { belongsToAnother, ownershipIndex, toMatchExpression } from "./derive-profile-skills.mjs";

test("toMatchExpression is identical to the server's", () => {
  for (const input of [
    "trading",
    "c++ templates",
    'say "hi"',
    "AND OR NOT",
    "a b cc ddd",
    "one two three four five six seven eight nine ten eleven twelve thirteen",
    "  ",
    "café & crème",
  ]) {
    strictEqual(toMatchExpression(input), server(input), `mismatch for ${JSON.stringify(input)}`);
  }
});

const ownership = ownershipIndex([
  { pkg: { id: "stage" }, declared: ["stage-pitch-deck", "sales-pitch-deck", "pitch-deck-creator"] },
  { pkg: { id: "copy" }, declared: ["copy-hook-craft", "content-about-page"] },
  { pkg: { id: "book-copy-editor" }, declared: [] },
]);

test("a declared, prefixed skill belongs to the profile that declared it", () => {
  deepStrictEqual([...ownership.owners].sort(), ["copy", "stage"]);
  strictEqual(belongsToAnother({ id: "stage-pitch-deck", description: "x" }, "pitch-deck-creator", ownership), true);
  strictEqual(belongsToAnother({ id: "stage-pitch-deck", description: "x" }, "stage", ownership), false);
});

test("a shared prefix alone is not ownership", () => {
  // `copy` owns a namespace but never declared `copy-editing`, and the skill's
  // description is ordinary prose -- so it stays available to everyone.
  const copyEditing = { id: "copy-editing", description: "Performs line-level copy editing for clarity." };
  strictEqual(belongsToAnother(copyEditing, "book-copy-editor", ownership), false);
  // `stage` itself declares `sales-pitch-deck`, which is not in a `stage-` namespace.
  const salesPitch = { id: "sales-pitch-deck", description: "Produces a sales pitch deck narrative." };
  strictEqual(belongsToAnother(salesPitch, "pitch-deck-creator", ownership), false);
});

test("a bold house-style directive marks an undeclared skill as someone else's", () => {
  const unowned = { id: "cross-role-consume-voice-profile", description: "**When to use.** When a voice profile exists." };
  strictEqual(belongsToAnother(unowned, "ppt-creator", ownership), false, "bold prose outside any owned namespace is nobody's");
  const owned = { id: "copy-podcast", description: "**When to use.** When the brief includes a podcast." };
  strictEqual(belongsToAnother(owned, "ppt-creator", ownership), true);
  strictEqual(belongsToAnother(owned, "copy", ownership), false);
});
