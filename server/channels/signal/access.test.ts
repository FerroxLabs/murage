// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SignalEvent } from "./types.ts";
const aci = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", friend = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = 10 * 86400000;
const context = () => ({ binding: { connectionId: "fixture", generation: 1, ownAci: aci, ownDeviceId: 2, linkedAt: now - 86400000, chiefBotId: "chief" },
  now, isCurrent: true, hasSentTimestamp: () => false, isTombstoned: () => false });
const note = (): Extract<SignalEvent, { variant: "sync-sent" }> => ({ sourceAci: aci, sourceDevice: 1, destinationAci: aci, envelopeDestination: null,
  timestamp: now, group: false, expiresInSeconds: null, longText: false, variant: "sync-sent", body: "hello", control: null });
async function access() {
  expect(existsSync(new URL("./access.ts", import.meta.url)), "B4 must implement authenticated Signal admission").toBe(true);
  const path = "./access.ts";
  return await import(path) as typeof import("./access.ts");
}
it.each([
  ["A1 not-owner", { sourceAci: friend }, "not-owner"], ["A2 own-device", { sourceDevice: 2 }, "own-device"],
  ["A3 data message", { variant: "other", body: null }, "not-note-to-self"],
  ["A4 friend", { destinationAci: friend }, "not-note-to-self"], ["A4 missing", { destinationAci: null }, "not-note-to-self"],
  ["A4b PNI", { envelopeDestination: `PNI:${aci}` }, "not-note-to-self"], ["A5 group", { group: true }, "group"],
  ["A6 empty", { body: " \n " }, "empty"], ["A7 history", { timestamp: now - 86400000 - 300001 }, "history"],
  ["A7 future", { timestamp: now + 300001 }, "future"],
  ["A6c long attachment", { longText: true }, "too-long"], ["A6b wrapper expansion", { body: "[UNTRUSTED A]".repeat(269) }, "too-long"],
] as const)("T-%s: paired note changes only this guard", async (_name, delta, reason) => {
  const { decideSignal } = await access();
  expect(decideSignal(note(), context())).toBe("accept");
  expect(decideSignal({ ...note(), ...delta } as SignalEvent, context())).toBe(reason);
});
it.each(["echo", "not-current", "deleted"] as const)("T-admission %s is independently enforced before size refusal", async reason => {
  const { decideSignal } = await access(), c = context();
  expect(decideSignal(note(), c)).toBe("accept");
  if (reason === "echo") c.hasSentTimestamp = () => true;
  if (reason === "deleted") c.isTombstoned = () => true;
  if (reason === "not-current") c.isCurrent = false;
  expect(decideSignal({ ...note(), body: "x".repeat(7000) }, c)).toBe(reason);
});
it("T-A7 permits offline notes and a phone 30 seconds behind link; window is not last-frame time", async () => {
  const { decideSignal } = await access(), c = context();
  expect(decideSignal({ ...note(), timestamp: now - 6 * 3600000 }, c)).toBe("accept");
  expect(decideSignal({ ...note(), timestamp: c.binding.linkedAt - 30000 }, c)).toBe("accept");
  expect(decideSignal({ ...note(), timestamp: c.binding.linkedAt - 300000 }, c)).toBe("accept");
});
it("T-WRAP-SIZE accepts exactly 6000 wrapped characters and refuses 6001", async () => {
  const { decideSignal } = await access();
  const { wrapUntrusted } = await import("../core/wrap.ts");
  const overhead = wrapUntrusted("SIGNAL", { body: "x" }).length - 1;
  expect(decideSignal({ ...note(), body: "x".repeat(6000 - overhead) }, context())).toBe("accept");
  expect(decideSignal({ ...note(), body: "x".repeat(6001 - overhead) }, context())).toBe("too-long");
});
it("T-NORM validates only the normalized contract; no raw wire shapes are guessed", async () => {
  const { parseSignalEvent } = await access();
  expect(parseSignalEvent(note())).toEqual(note());
  expect(parseSignalEvent({ ...note(), sourceAci: `{${aci.toUpperCase()}}` })?.sourceAci).toBe(aci);
  for (const delta of [{ sourceAci: `PNI:${aci}` }, { sourceAci: null }, { sourceDevice: 0 }, { sourceDevice: 1.5 },
    { sourceDevice: undefined }, { timestamp: NaN }, { expiresInSeconds: -1 }, { group: undefined }, { control: { kind: "delete", target: now } }]) {
    expect(parseSignalEvent({ ...note(), ...delta })).toBeNull();
  }
  expect(parseSignalEvent({ envelope: { sourceUuid: aci } })).toBeNull();
});
it("T-CONTROL authenticates textless delete before note and timer without admitting them as text", async () => {
  const { decideSignal, decideSignalControl } = await access();
  for (const control of [{ kind: "delete", target: now - 1 }, { kind: "timer", seconds: 60 }] as const) {
    const event: SignalEvent = { ...note(), variant: "sync-control", body: null, control };
    expect(decideSignalControl(event, context())).toBe(true);
    expect(decideSignal(event, context())).toBe("not-note-to-self");
    for (const delta of [{ sourceAci: friend }, { sourceDevice: 2 }, { destinationAci: friend }, { group: true }, { timestamp: now + 300001 }]) {
      expect(decideSignalControl({ ...event, ...delta }, context())).toBe(false);
    }
    expect(decideSignalControl(event, { ...context(), isCurrent: false })).toBe(false);
  }
  expect(decideSignalControl({ ...note(), variant: "sync-control", body: null, control: { kind: "delete", target: now - 2 * 86400000 } }, context())).toBe(false);
});
it("T-NOLOG rejected projected data stays out of diagnostics; missing projector admits nothing", async () => {
  const { createSignalAccess } = await access();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(createSignalAccess().parse(note())).toBeNull();
    const adapter = createSignalAccess(raw => raw);
    expect(adapter.parse({ ...note(), sourceAci: "private stranger marker" })).toBeNull();
    expect(adapter.decide(note(), context())).toBe("accept");
    expect(adapter.decide({ ...note(), group: true }, context())).toBe("drop");
    expect(diagnostic).not.toHaveBeenCalled();
  } finally { diagnostic.mockRestore(); }
});
