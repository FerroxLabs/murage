// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S15: the push hooks of the job state machine. park sends the device-job push for a newly parked job to the one phone it
// is for; withdraw removes it (or replaces what the phone shows) when the job ends unleased. The push carries ids and the capability name
// at most, never args, say or result: the phone fetches the job itself with its own bearer.
import type { PushOutbox } from "../mobile-push-outbox.ts";
import type { PhoneJobInfo, PhoneJobsDeps } from "./jobs.ts";

export interface DeviceJobPushDeps {
  /** The push binding of a phone, by its device id (push_bindings.device_id). */
  bindingIdForDevice(deviceId: string): string | null;
  outbox: Pick<PushOutbox, "enqueueDeviceJob" | "resolve">;
  warn?(hook: string, error: unknown): void;
}

export function deviceJobPush(deps: DeviceJobPushDeps): PhoneJobsDeps["push"] {
  const warn = deps.warn ?? (() => {});
  return {
    park(job: PhoneJobInfo): void {
      try {
        const bindingId = deps.bindingIdForDevice(job.deviceId);
        if (bindingId) deps.outbox.enqueueDeviceJob({ bindingId, botId: job.botId, threadId: job.threadId, operationId: job.operationId, expiresAt: job.expiresAt });
      } catch (error) { warn("device-job-park", error); }
    },
    withdraw(job: PhoneJobInfo): void {
      try { deps.outbox.resolve(job.threadId, job.operationId, "elsewhere"); } catch (error) { warn("device-job-withdraw", error); }
    },
  };
}
