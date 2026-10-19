// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1), the client side:
//   - item 5 (Rule 81b): "Always allow" outside a routine is ONE request that
//     saves and answers, never a save followed by a separate answer.
//   - Rule 82a: a browser pairing that is not offered the routine choice
//     says why in plain words.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routineChoiceElsewhereWords } from "@/lib/routine-grant-words";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("item 5, Rule 81b: Always allow saves and answers in one request", () => {
  it("sends one decision that answers too, and keeps the card pending on a refusal", () => {
    const store = read("../state/store.tsx");
    const start = store.indexOf("if (action.alwaysAllow) {");
    const branch = store.slice(start, store.indexOf("void respond();", start));
    expect(branch).toContain("answer: true");
    expect(branch).not.toContain("respond()");
    expect(branch).toContain("onError");
  });
});

describe("Rule 82a: where the routine choice is not offered, say why", () => {
  it("tells a browser pairing where the choice is made", () => {
    expect(routineChoiceElsewhereWords("browser")).toBe("Always allow for this routine is chosen on your computer or in the Murage phone app.");
  });

  it("says nothing where the choice is offered", () => {
    for (const surface of ["desktop", "app", "unknown"] as const) expect(routineChoiceElsewhereWords(surface)).toBeUndefined();
  });

  it("is shown on the card beside an offer the pairing cannot choose", () => {
    const panel = read("./PendingApproval.tsx");
    expect(panel).toContain("routineChoiceElsewhereWords(surface)");
    expect(panel).toContain('data-routine-choice="elsewhere"');
  });
});
