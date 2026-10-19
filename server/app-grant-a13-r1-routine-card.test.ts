// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1) item 1, Rules 76, 81: every eligible
// card a routine run raises (app actions, lookups, several rows) carries the
// server's routine identity, so the owner can choose it and the save route
// takes it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routineCardFields } from "./approval-grant-request.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const offer = { routineId: "r1", routineName: "Training", eligible: true, actionKeys: ["app-action:GMAIL_FETCH_EMAILS"], stopKeys: [], notRemembered: [] };

describe("item 1, Rules 76, 81: every routine card carries the server's routine identity", () => {
  it("names the routine on an app action, lookup or several-row card with no stop or command key", () => {
    expect(routineCardFields({ routineId: "r1" }, undefined, { rows: [], routine: offer })).toEqual({ routineId: "r1" });
    const lookup = { ...offer, actionKeys: ["mcp__murage_connectors__APPS_SEARCH_TOOLS"] };
    expect(routineCardFields({ routineId: "r1" }, undefined, { rows: [], routine: lookup })).toEqual({ routineId: "r1" });
  });

  it("keeps the scoped key of a stop or command card beside it", () => {
    expect(routineCardFields({ routineId: "r1" }, "stop:message:bob@example.com", undefined)).toEqual({ routineId: "r1", routineAllowKey: "stop:message:bob@example.com" });
  });

  it("names no routine when no run of it raised the card, or the card offers nothing for it", () => {
    expect(routineCardFields(null, "stop:message:bob@example.com", { rows: [], routine: offer })).toEqual({});
    expect(routineCardFields({ routineId: "r1" }, undefined, { rows: [] })).toEqual({});
    expect(routineCardFields({ routineId: "r1" }, undefined, undefined)).toEqual({});
  });

  it("is what the request path puts on the card", () => {
    const source = read("./index.ts");
    expect(source).toMatch(/const routineAllowCard = routineCardFields\(routineOffered, routineAllowKey, grantRequest\)/);
  });
});
