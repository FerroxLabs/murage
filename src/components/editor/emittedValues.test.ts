// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createEmittedValues } from "./emittedValues";

describe("emitted values", () => {
  it("treats the latest edit coming back as the editor's own", () => {
    const emitted = createEmittedValues("a");
    emitted.note("ab");
    expect(emitted.isOutside("ab")).toBe(false);
  });

  it("treats an older edit arriving after a newer one as the editor's own", () => {
    const emitted = createEmittedValues("a");
    emitted.note("ab");
    emitted.note("abc");
    expect(emitted.isOutside("ab")).toBe(false);
    expect(emitted.isOutside("abc")).toBe(false);
  });

  it("treats text the editor never produced as an outside change", () => {
    const emitted = createEmittedValues("a");
    emitted.note("ab");
    expect(emitted.isOutside("reset text")).toBe(true);
  });

  it("forgets older edits once an outside change is applied", () => {
    const emitted = createEmittedValues("a");
    emitted.note("ab");
    emitted.reset("reset text");
    expect(emitted.isOutside("reset text")).toBe(false);
    expect(emitted.isOutside("ab")).toBe(true);
  });
});
