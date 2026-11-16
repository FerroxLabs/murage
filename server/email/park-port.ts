// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The real ParkPort (restore park r3.1 sections 4 and 7): the owner view's window onto Batch A's park table, durable Keep and RemovalGate.
import type { EmailRuntime } from "./runtime.ts";
import { isGateRefusal } from "./removal-gate.ts";
import type { ParkPort, ParkRecord } from "./owner-view.ts";

export function createParkPort(runtime: Pick<EmailRuntime, "services">): ParkPort {
  return {
    list(): ParkRecord[] {
      const services = runtime.services();
      if (!services) return [];
      return services.store.parks().map(park => ({
        botId: park.botId, parkId: park.parkId, parkRev: park.parkRev, address: park.address, inboxId: park.inboxId, keyIds: park.keyId ? [park.keyId] : [],
        state: park.state === "keep_pending" ? "keep_pending" : park.state === "parked" ? "parked" : park.state === "key_release" ? "key_release" : "remove_authorized",
        remoteDeleted: park.remoteDeletedAt !== null,
      }));
    },
    async keep(botId, expect) {
      const services = runtime.services();
      const park = services?.store.getPark(botId);
      if (!services || !park || park.parkId !== expect.parkId || park.parkRev !== expect.parkRev) return { ok: false, status: 409, code: "confirm_expired" };
      const result = await services.bindings.keep(botId);
      return result.ok ? { ok: true } : { ok: false, status: result.status, code: result.code };
    },
    async remove(botId, by, expect) {
      const services = runtime.services();
      if (!services) return { ok: false, status: 409, code: "inbox_gone" };
      const auth = services.bindings.gate.authorize({ kind: "park", botId, parkId: expect.parkId, parkRev: expect.parkRev, by });
      if (isGateRefusal(auth)) return { ok: false, status: 409, code: auth.code === "keep_pending" ? "keep_pending" : "confirm_expired" };
      await services.bindings.continueRemoval(auth.start, auth.authority);
      return { ok: true };
    },
  };
}
