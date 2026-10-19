// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerResponse } from "node:http";
import type { CloudDevice, CloudSessions } from "../cloud-sessions.ts";

export type CloudResponseBinding = Pick<CloudDevice, "id" | "scope" | "account"> & { accessHash: string };
/** All continuing responses use the same lifetime door, including media caps. */
export class CloudResponseSessions {
  private readonly sessions: CloudSessions;
  private readonly open = new Map<ServerResponse, { bindings: CloudResponseBinding[]; timer: ReturnType<typeof setInterval> }>();
  constructor(sessions: CloudSessions) {
    this.sessions = sessions;
    sessions.onInvalidation(id => {
      for (const [res, entry] of this.open) if (id === undefined || entry.bindings.some(binding => binding.id === id)) res.destroy();
    });
  }
  track(res: ServerResponse, bindings: CloudResponseBinding[]): void {
    if (!bindings.length || res.destroyed || res.writableEnded) return;
    const cleanup = () => { const entry = this.open.get(res); if (entry) clearInterval(entry.timer); this.open.delete(res); };
    const timer = setInterval(() => {
      let valid = true;
      try {
        valid = bindings.every(binding => {
          const current = this.sessions.resolveHash(binding.accessHash);
          return current?.id === binding.id && current.account === binding.account && current.scope === binding.scope;
        });
      } catch { valid = false; }
      if (!valid) res.destroy();
    }, 30_000);
    timer.unref?.();
    this.open.set(res, { bindings, timer });
    res.once("finish", cleanup); res.once("close", cleanup);
  }
}
