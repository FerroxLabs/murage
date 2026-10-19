// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { groupNumbers, hiddenPatchFrom } from "./record-numbers";

describe("a room patch built from a server answer carries the answer's numbers (CI-OVERLAY-DESIGN r4 I-H1)", () => {
  it("hiddenPatchFrom: the server's hidden (true, or cleared) under the answer's recordSeq/recordEpoch", () => {
    expect(hiddenPatchFrom("g1", { id: "g1", hidden: true, recordSeq: 5, recordEpoch: "e1" })).toEqual({ id: "g1", hidden: true, recordSeq: 5, recordEpoch: "e1" });
    expect(hiddenPatchFrom("g1", { id: "g1", hidden: false, recordSeq: 5, recordEpoch: "e1" })).toEqual({ id: "g1", hidden: undefined, recordSeq: 5, recordEpoch: "e1" });
    expect(hiddenPatchFrom("g1", { id: "g1", recordSeq: 5, recordEpoch: "e1" })).toEqual({ id: "g1", hidden: undefined, recordSeq: 5, recordEpoch: "e1" });
  });

  it("an unnumbered or absent answer (an older server) yields an unnumbered patch, which the reducer applies as the client's own", () => {
    expect(hiddenPatchFrom("g1", { id: "g1", hidden: true })).toEqual({ id: "g1", hidden: true });
    expect(hiddenPatchFrom("g1", undefined)).toEqual({ id: "g1", hidden: undefined });
    expect(groupNumbers({ recordSeq: "5", recordEpoch: "e1" })).toEqual({});
    expect(groupNumbers({ recordSeq: 5 })).toEqual({});
    expect(groupNumbers(null)).toEqual({});
  });
});
