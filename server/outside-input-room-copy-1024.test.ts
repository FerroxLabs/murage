// SPDX-License-Identifier: AGPL-3.0-or-later
// 1024 brucecopy (S10): the room member-turn refusal sites (index.ts runGroupMemberTurnDispatch, `roomOutsideInput`) pick their line from these
// functions. q1024-weakfix: the room copy is checked by calling the real module the room sites call, not by matching index.ts source text.
// (The room sites themselves are not reachable from a webhook today, outside-input-refused-copy-1024-api.test.ts S15, so the contract that
// would matter the moment one is, which source counts as outside input and which line every refusal kind gets, is pinned here.)
import { describe, expect, it } from "vitest";
import { isOutsideInputSource, lateMemoryRefusalLine, OUTSIDE_INPUT_REFUSED_LINE, RESEND_OFFER_LINE, turnRefusedLine, type TurnRefusedKind } from "./memory/dispatch.ts";

describe("outside input in a room turn's refusal copy", () => {
  it.each(["webhook", "channel", "app"])("%s is outside input; the owner's own sources and junk are not", (source) => {
    expect(isOutsideInputSource(source)).toBe(true);
    for (const own of ["schedule", "manual", "owner", "", undefined, null, 7]) expect(isOutsideInputSource(own)).toBe(false);
  });
  const SEND_KINDS: TurnRefusedKind[] = ["after-submission", "after-submission-uncertain", "not-started", "unknown-submission"];
  it.each(SEND_KINDS)("a refused send (%s) for outside input says the one outside-input line, never a Send again offer", (kind) => {
    const line = turnRefusedLine("Claude", kind, true);
    expect(line).toBe(OUTSIDE_INPUT_REFUSED_LINE);
    expect(line).not.toBe(turnRefusedLine("Claude", kind, false));
    expect(line).not.toMatch(/send (it )?again|resend/i);
  });
  it("the owner's own refusals keep their lines: resend offer for the uncertain send, and the default when no flag is given", () => {
    expect(turnRefusedLine("Claude", "resend-offer", true)).toBe(RESEND_OFFER_LINE);
    for (const kind of SEND_KINDS) expect(turnRefusedLine("Claude", kind)).toBe(turnRefusedLine("Claude", kind, false));
    expect(turnRefusedLine("Claude", "after-submission-uncertain")).not.toBe(OUTSIDE_INPUT_REFUSED_LINE);
  });
  it("the late-memory refusal (every rebuild revoked) follows the same rule", () => {
    expect(lateMemoryRefusalLine("Claude", true)).toBe(OUTSIDE_INPUT_REFUSED_LINE);
    expect(lateMemoryRefusalLine("Claude")).toBe(turnRefusedLine("Claude", "not-started"));
    expect(lateMemoryRefusalLine("Claude")).not.toBe(OUTSIDE_INPUT_REFUSED_LINE);
  });
});
