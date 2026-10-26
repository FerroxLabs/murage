// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U45: the retained-run line and the later "Engine closed" line agree (the conversation continues once the engine
// exits; a restart is only the way out if it never does), and the 1.0.3 changelog page reads like the release body.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ENGINE_CLOSED_LATE_NOTE, PROVIDER_STOP_UNCONFIRMED_LINE } from "./direct-late-close.ts";

describe("late-close wording", () => {
  it("says the conversation continues once the engine exits", () => {
    expect(PROVIDER_STOP_UNCONFIRMED_LINE.startsWith("error: provider stop is unconfirmed")).toBe(true);
    expect(PROVIDER_STOP_UNCONFIRMED_LINE).toContain("continues once the engine exits");
    expect(PROVIDER_STOP_UNCONFIRMED_LINE).not.toContain("restart Murage before continuing");
    expect(ENGINE_CLOSED_LATE_NOTE).toContain("you can continue this conversation");
  });

  it("the server writes that line, not the old one", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("restart Murage before continuing this thread");
    expect(index).toContain("tool:{name:PROVIDER_STOP_UNCONFIRMED_LINE,ok:false}");
  });
});

describe("the 1.0.3 changelog page", () => {
  const page = readFileSync(new URL("../apps/docs/content/docs/changelog/v1-0-3.mdx", import.meta.url), "utf8");
  it("matches the published release body", () => {
    for (const line of [
      "Setup checks both records before it finishes.",
      "- **Rooms run with memory off.**",
      "A reply from a turn that began after a change goes straight to the channel when it is sent.",
      "- **Replies held in 1.0.2 are restored.**",
      "- **First paint is quicker,** with the engine sign-in work moved out of the way.",
    ]) expect(page).toContain(line);
    for (const old of ["no longer lets setup finish early", "works as it should", "is no longer caught", "Earlier replies come back", "back under budget"]) expect(page).not.toContain(old);
  });
});
