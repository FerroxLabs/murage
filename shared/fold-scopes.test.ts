// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 1 (gate tier): the fold's table. Every verdict
// source times every routine, unattended, host, stop kind, public and placed
// combination has a defined answer; a source without an entry in REASON_FOLD
// fails to compile and fails here; every offered key is one the reader
// honors on the next identical ask, and the rows the reader would ignore
// (a task row on an unattended or automated turn, a payment "always") are
// never shown.
import { describe, expect, it } from "vitest";

import { autoVerdict } from "../server/auto-approve.ts";
import { stopLineKeyCovers, type StopHit } from "../server/stop-line.ts";
import { exactCommandKey } from "./exact-command.ts";
import { REASON_FOLD, botScopeOffered, foldScopes, taskScopeOffered, type CardClass, type CardKeys, type CardReason } from "./fold-scopes.ts";

const REASONS = Object.keys(REASON_FOLD) as CardReason[];
const FOLDING = new Set<CardReason>(["stop-line", "no-grant"]);

const STOPS: { name: string; stop?: CardClass["stop"]; keys: CardKeys }[] = [
  { name: "no stop", keys: { allowKey: "Read" } },
  { name: "message one new", stop: { kind: "message", public: false, placed: true, places: 1 }, keys: { allowKey: "stop:message:dana@acme.example", taskAllowKey: "stop:message:dana@acme.example" } },
  { name: "message several", stop: { kind: "message", public: false, placed: false, places: 3 }, keys: {} },
  { name: "public post", stop: { kind: "message", public: true, placed: true, places: 1 }, keys: { allowKey: "stop:public:github:ferrox/murage", taskAllowKey: "stop:public:github:ferrox/murage" } },
  { name: "delete folder", stop: { kind: "delete", public: false, placed: true, places: 1 }, keys: { allowKey: "stop:delete:/Users/alex/site/build", taskAllowKey: "stop:delete:/Users/alex/site/build" } },
  { name: "delete app", stop: { kind: "delete", public: false, placed: true, places: 1 }, keys: { allowKey: "stop:delete:app:github", taskAllowKey: "stop:delete:app:github" } },
  { name: "delete unplaced", stop: { kind: "delete", public: false, placed: true, places: 1 }, keys: { allowKey: 'stop:delete:unplaced:["/tmp","rm -rf $X"]', taskAllowKey: 'stop:delete:unplaced:["/tmp","rm -rf $X"]' } },
  { name: "delete no place", stop: { kind: "delete", public: false, placed: false, places: 1 }, keys: {} },
  { name: "pay", stop: { kind: "pay", public: false, placed: true, places: 1 }, keys: { allowKey: "stop:pay:stripe:brightline", taskAllowKey: "stop:pay:stripe:brightline" } },
];

const classOf = (reason: CardReason, extra: Partial<CardClass>, keys: CardKeys): CardClass => ({
  reason, unattended: false, automated: false, keys: (Object.keys(keys) as CardClass["keys"]).filter((field) => (field as string) !== "routineId"), ...extra,
});

describe("foldScopes: the 1.2 table", () => {
  it("has an entry for every verdict source and the question", () => {
    // the Record type makes a missing source a compile error; this keeps the runtime table whole too
    expect(REASONS.length).toBeGreaterThanOrEqual(23);
    for (const reason of REASONS) expect(["none", "class"]).toContain(REASON_FOLD[reason]);
    expect(REASON_FOLD.question).toBe("none");
  });

  const routineOffer = { routineId: "r1", routineName: "Morning brief", eligible: true, actionKeys: ["app-action:GMAIL_SEND_EMAIL"], stopKeys: [], notRemembered: [] };
  for (const reason of REASONS) {
    for (const stop of STOPS) {
      for (const routine of [false, true]) {
        for (const unattended of [false, true]) {
          for (const scope of [undefined, "local-computer" as const]) {
            it(`${reason} / ${stop.name}${routine ? " / routine" : ""}${unattended ? " / unattended" : ""}${scope ? " / host" : ""}`, () => {
              const keys: CardKeys = routine ? { ...stop.keys, routineId: "r1", routineOffer } : stop.keys;
              const rows = foldScopes(classOf(reason, { ...(stop.stop ? { stop: stop.stop } : {}), ...(routine ? { routine: { routineId: "r1" } } : {}), unattended, ...(scope ? { scope } : {}) }, keys), keys);
              expect(Array.isArray(rows)).toBe(true);
              // guards, the host, unattended turns and every non-folding source: nothing
              if (!FOLDING.has(reason) || unattended || scope) return expect(rows).toEqual([]);
              // a routine's card: the routine's row only, never a bot-level one
              if (routine) return expect(rows.map((row) => row.scope)).toEqual(["routine"]);
              expect(rows.every((row) => row.scope !== "routine")).toBe(true);
              // never a payment "always", never a new-person message scope
              expect(rows.some((row) => row.scope === "bot" && row.keys.some((key) => key.startsWith("stop:pay:")))).toBe(false);
              if (stop.stop?.kind === "message" && !stop.stop.public) expect(rows).toEqual([]);
              // bot-level rows are the computer's; task and routine rows go everywhere
              for (const row of rows) expect(row.surface).toBe(row.scope === "bot" ? "desktop" : "any");
            });
          }
        }
      }
    }
  }

  it("offers the 12-hour task row only on an attended, non-automated, non-host turn", () => {
    const keys = STOPS[4]!.keys;
    const stop = STOPS[4]!.stop!;
    expect(foldScopes(classOf("stop-line", { stop }, keys), keys).map((row) => row.id)).toEqual(["task", "always"]);
    expect(foldScopes(classOf("stop-line", { stop, automated: true }, keys), keys).map((row) => row.id)).toEqual(["always"]);
    expect(foldScopes(classOf("stop-line", { stop }, keys), keys)[0]).toMatchObject({ window: { hours: 12, where: "conversation" }, target: { kind: "delete-folder", folder: "/Users/alex/site/build" } });
  });

  it("a payment offers the task row only", () => {
    const { keys, stop } = STOPS[8]!;
    const rows = foldScopes(classOf("stop-line", { stop: stop! }, keys), keys);
    expect(rows).toEqual([{ id: "task", scope: "task", surface: "any", keys: ["stop:pay:stripe:brightline"], target: { kind: "pay", payee: "stripe:brightline" }, window: { hours: 12, where: "conversation" } }]);
  });

  it("names the place each stop row covers", () => {
    const targets = STOPS.slice(3, 7).map(({ stop, keys }) => foldScopes(classOf("stop-line", { stop: stop! }, keys), keys).find((row) => row.id === "always")?.target);
    expect(targets).toEqual([
      { kind: "public", where: "github:ferrox/murage" },
      { kind: "delete-folder", folder: "/Users/alex/site/build" },
      { kind: "delete-place", where: "app", name: "github" },
      { kind: "delete-command", folder: "/tmp", command: "rm -rf $X" },
    ]);
  });

  it("no-grant rows: exact command, program, native tool, app action, set, mount, another bot", () => {
    const exact = exactCommandKey({ engine: "claude", cwd: "/Users/alex/site", command: "git push" })!;
    const cmd: CardKeys = { allowKey: "Bash:git", exactAllowKey: exact };
    expect(foldScopes(classOf("no-grant", {}, cmd), cmd).map((row) => [row.id, row.target.kind])).toEqual([["always-exact", "exact-command"], ["always", "program"]]);
    const one = (allowKey: string) => foldScopes(classOf("no-grant", {}, { allowKey }), { allowKey })[0]?.target;
    expect(one("Read")).toEqual({ kind: "native-tool", tool: "Read" });
    expect(one("app-action:GMAIL_SEND_EMAIL")).toEqual({ kind: "app-action", key: "app-action:GMAIL_SEND_EMAIL" });
    expect(one("acp-tool:v2:custom%3Agithub/create%5Fissue")).toEqual({ kind: "mount-tool", mountId: "custom:github", tool: "create_issue" });
    expect(one("ask_bot:@Helper")).toEqual({ kind: "ask-bot", bot: "Helper" });
    // never: a host key, a bare command tool, a question tool
    expect(one("local-computer:Bash:git")).toBeUndefined();
    expect(one("Bash")).toBeUndefined();
    expect(one("AskUserQuestion")).toBeUndefined();
    const set: CardKeys = { allowKeys: ["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"] };
    const rows = foldScopes(classOf("no-grant", {}, set), set);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "always-set", keys: set.allowKeys });
    // the save route takes the whole set, never one key of it
    expect(botScopeOffered(classOf("no-grant", {}, set), set, set.allowKeys!)).toBe(true);
    expect(botScopeOffered(classOf("no-grant", {}, set), set, [set.allowKeys![0]!])).toBe(false);
  });

  it("an always row is shown only when its key is on the card", () => {
    const keys: CardKeys = { taskAllowKey: "stop:delete:/Users/alex/site/build" };
    expect(foldScopes(classOf("stop-line", { stop: STOPS[4]!.stop! }, keys), keys).map((row) => row.id)).toEqual(["task"]);
  });

  it("F18: a card from an older build is read as the most restrictive class its keys allow", () => {
    // no task row; no payment always; a routine's card offers only the routine
    expect(foldScopes(undefined, { allowKey: "stop:pay:stripe:x", taskAllowKey: "stop:pay:stripe:x" })).toEqual([]);
    expect(taskScopeOffered(undefined, { taskAllowKey: "stop:delete:/a" }, "stop:delete:/a")).toBe(false);
    expect(foldScopes(undefined, { allowKey: "stop:delete:/a", routineId: "r1", routineAllowKey: "stop:delete:/a" }).map((row) => row.scope)).toEqual(["routine"]);
    expect(foldScopes(undefined, { allowKey: "stop:delete:/a" }).map((row) => row.scope)).toEqual(["bot"]);
    expect(foldScopes(undefined, { allowKey: "stop:message:dana@acme.example" })).toEqual([]);
    expect(foldScopes(undefined, { allowKey: "Read" }).map((row) => row.target.kind)).toEqual(["native-tool"]);
  });

  it("every offered stop key is honored on the next identical ask; every key it saves answers it", () => {
    const hits: StopHit[] = [
      { kind: "delete", place: "/Users/alex/site/build", what: "Delete" },
      { kind: "delete", place: "app:github", what: "Delete on GitHub" },
      { kind: "message", place: "public:github:ferrox/murage", recipients: ["github:ferrox/murage"], what: "Post" },
      { kind: "pay", place: "stripe:brightline", what: "Pay" },
    ];
    for (const hit of hits) {
      const key = hit.kind === "message" ? `stop:${hit.place}` : `stop:${hit.kind}:${hit.place}`;
      const keys: CardKeys = { allowKey: key, taskAllowKey: key };
      const cls = classOf("stop-line", { stop: { kind: hit.kind, public: hit.kind === "message", placed: true, places: 1 } }, keys);
      for (const row of foldScopes(cls, keys)) {
        for (const saved of row.keys) {
          expect(stopLineKeyCovers(saved, hit)).toBe(true);
          const verdict = row.scope === "task"
            ? autoVerdict({}, "Bash", "x", { stopLine: hit, stopAllowedForTask: saved })
            : autoVerdict({ alwaysAllow: [saved] }, "Bash", "x", { stopLine: hit });
          expect(verdict.approve).not.toBeNull();
        }
      }
    }
    // a delete "always" covers a subfolder (the row says so), not a sibling
    expect(stopLineKeyCovers("stop:delete:/Users/alex/site/build", { kind: "delete", place: "/Users/alex/site/build/x", what: "" })).toBe(true);
    expect(stopLineKeyCovers("stop:delete:/Users/alex/site/build", { kind: "delete", place: "/Users/alex/site/dist", what: "" })).toBe(false);
  });

  it("the hidden task row on an unattended turn is one the reader would have ignored", () => {
    const hit: StopHit = { kind: "delete", place: "/Users/alex/site/build", what: "Delete" };
    const verdict = autoVerdict({}, "Bash", "x", { stopLine: hit, stopAllowedForTask: "stop:delete:/Users/alex/site/build", unattended: true });
    expect(verdict.approve).toBeNull();
  });
});
