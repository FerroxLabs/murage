// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 copy sync (not a behaviour witness): the notice names the same plain-words list the server keeps.
import { expect, it } from "vitest";
import { AUTOMATIC_ALWAYS_ASKS } from "./AutomaticModeNotice";
import { AUTOMATIC_ALWAYS_ASKS as SERVER_ALWAYS_ASKS } from "../../server/automatic-default.ts";

it("names the same plain-words list the server keeps", () => {
  expect(AUTOMATIC_ALWAYS_ASKS).toEqual(SERVER_ALWAYS_ASKS);
});
