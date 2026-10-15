// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The guards of the typed hand-off boundary hold at run time as well as at compile time (review round 7, R7-03): a constructor reached by a cast
// makes nothing, worker text has no public way back to a string, the row sink has no public append, a decorator cannot add text, and a built
// body is frozen all the way down.
import { describe, expect, it } from "vitest";
import * as murageStatus from "./murage-status.ts";
import { EgressViolation, ReleasedText, WorkerText } from "./released-text.ts";
import { MurageStatus, status } from "./murage-status.ts";
import { RowSink, botBody, writeBotRow } from "./bot-egress.ts";
import { released } from "./testing/released.ts";
import type { Message } from "./store.ts";

const asAny = (value: unknown) => value as any;

describe("nothing can be made past the capability", () => {
  it("a released-text constructor reached by a cast makes nothing and registers nothing", () => {
    const real = released("fine");
    expect(() => new (asAny(ReleasedText))("SECRET", undefined)).toThrow(EgressViolation);
    expect(() => Reflect.construct(asAny(ReleasedText), ["SECRET", undefined, Symbol("guess")])).toThrow(EgressViolation);
    // the one real kind is unaffected, and a look-alike with the private field's shape is not accepted
    expect(ReleasedText.is(real)).toBe(true);
    expect(ReleasedText.is(Object.create(ReleasedText.prototype))).toBe(false);
    expect(() => botBody({ text: Object.create(ReleasedText.prototype) })).toThrow(EgressViolation);
  });
  it("a status constructor reached by a cast makes nothing", () => {
    expect(() => new (asAny(MurageStatus))("withheld", "SECRET", undefined, [])).toThrow(EgressViolation);
    expect(() => Reflect.construct(asAny(MurageStatus), ["withheld", "SECRET", undefined, [], Symbol("guess")])).toThrow(EgressViolation);
  });
  it("the capabilities are handed out once, and the gate and the host wrapper already hold them", async () => {
    await import("./result-egress.ts");
    await import("./host-words.ts");
    expect(() => ReleasedText.claim()).toThrow(EgressViolation);
    expect(() => WorkerText.claimUnseal()).toThrow(EgressViolation);
    expect(() => MurageStatus.claimHost()).toThrow(EgressViolation);
  });
  it("worker text has no public unseal, and no string wrapper is exported from the status module", () => {
    expect(asAny(WorkerText).unseal).toBeUndefined();
    expect(asAny(MurageStatus).host).toBeUndefined();
    expect("hostLine" in murageStatus).toBe(false);
  });
  it("the row sink has no public append, and holds its store out of reach", () => {
    expect(asAny(RowSink).append).toBeUndefined();
    const sink = new RowSink({ appendMessage: () => { throw new Error("not called"); } });
    expect(Object.keys(sink)).toEqual([]);
    expect(Object.isFrozen(sink)).toBe(true);
  });
  it("a table line cannot be made for a key outside the table", () => {
    expect(() => asAny(status)("host_line", { line: { words: "SECRET" } })).toThrow(EgressViolation);
    expect(() => asAny(status)("constructor", {})).toThrow();
  });
});

describe("rows carry only the words the gate released", () => {
  const sink = () => {
    const written: Array<Omit<Message, "id" | "at">> = [];
    return { written, rows: new RowSink({ appendMessage: (_thread, message) => { written.push(message); return { ...message, id: "m", at: 1 } as Message; } }) };
  };
  it("a function passed where a decorator used to go changes nothing", () => {
    const { written, rows } = sink();
    writeBotRow(rows, "t", {}, released("the checked words"), asAny(() => "raw words"));
    expect(written[0].text).toBe("the checked words");
  });
});

describe("a built body is frozen all the way down", () => {
  it("its arrays cannot be changed after the checks", () => {
    const body = botBody({ recentActivity: [status("activity_text", { text: released("one") })] }) as Record<string, unknown>;
    const activity = body.recentActivity as string[];
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(activity)).toBe(true);
    expect(() => activity.push("raw words")).toThrow();
    expect(() => { activity[0] = "raw words"; }).toThrow();
    expect(activity.map(line => line)).toEqual(["text: one"]);
  });
});
