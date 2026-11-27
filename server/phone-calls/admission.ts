// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F1 provides admission and the turn context; F3 consumes it in the service.
import { PHONE_ENGINE_ABSENT } from "../drivers/phone-tool-schemas.ts";
import { serviceNoLimits } from "../service-no-limits.ts";
import type { PhoneAdmissionDeps, PhoneMountInput, PhoneMountVerdict, PhoneToolClaim } from "./contracts.ts";
import { phoneCallsSupported, phoneKeyPresent } from "./phone-secrets.ts";
import { admittedPhoneTurn } from "./phone-turns.ts";
import type { PhoneCallService } from "./service.ts";

export function phoneMount(input: PhoneMountInput): PhoneMountVerdict {
  if (!phoneCallsSupported() || !phoneKeyPresent() || !input.ownerAudience || input.projectRole) return { mounted: false, line: null };
  if (!input.agentsMcp) return { mounted: false, line: PHONE_ENGINE_ABSENT };
  if (!input.botAllowed) return { mounted: false, line: "This bot isn't allowed to phone businesses. Change it in Settings > Connected apps > Phone calls." };
  return { mounted: true };
}

/** The internal route behind both engine tools (index.ts `/api/internal/phone/<tool>`). Channel people never get here
 *  (internal-route-authority.ts). Every call is checked against the generation's phone-mount record (phone-turns.ts), so an
 *  automation run, a project-role turn or any turn the mount did not admit gets `not_set_up` and no call even when it holds an
 *  agents capability; a claim that is not the owner's audience gets the same. Answers are the
 *  section-4 shape or one fixed error code, never vendor text. The service must already be ready. */
export async function servePhoneTool(service: () => PhoneCallService | null, tool: "phone_call_place" | "phone_call_result", claim: PhoneToolClaim, body: Record<string, unknown>, deps: PhoneAdmissionDeps, fenced?: (botId: string) => boolean): Promise<Record<string, unknown>> {
  const unavailable = () => ({ error: "not_set_up", ...(serviceNoLimits(claim.generation ?? "", claim.threadId, claim.botId) ? { text: "Phone calls are off. Set them up in Settings → Connected apps → Phone calls." } : {}) });
  const record = admittedPhoneTurn(claim);
  if (!record) return unavailable();
  if (!claim.botId || claim.notOwnerAudience === true || !phoneKeyPresent() || !deps.botMayPhone(claim.botId)) return unavailable();
  const ready = service();
  if (!ready) return unavailable();
  const outcome = tool === "phone_call_place"
    ? await ready.place(body, { botId: record.botId, intent: record.intent, ...(fenced ? { fenced: () => fenced(record.botId) } : {}) })
    : await ready.result(body);
  return outcome.ok ? outcome.value : { error: outcome.error };
}
