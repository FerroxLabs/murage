// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone tool call (S13, design 4.1): the one function a phone-jobs MCP call reaches. It decides, in a fixed order and failing closed,
// whether this call may open a job on the owner's phone. Nothing here trusts the model: authority is re-checked at call time against the
// live PhoneAuthorities, the grant and the phone's own report are re-read, and the arguments are validated before a job exists.
import type { InternalCapability } from "../internal-capabilities.ts";
import type { MessageOrigin } from "../store.ts";
import { PHONE_ACTIONS, PHONE_TOOL_NAMES, actionArgsSchema, type PhoneToolName } from "../../shared/phone-jobs-contract.ts";
import { locationPrecision, phoneTools, type PhoneApps } from "../../shared/phone-apps.ts";
import { PHONE_COPY } from "../../shared/phone-copy.ts";
import type { PhoneAuthorities } from "./authority.ts";
import type { PhoneRpcCopy } from "./copy.ts";
import type { FailCode, PhoneJobs } from "./jobs.ts";
import type { PhoneRegistration, PhoneRegistry } from "./registry.ts";

export type RpcRefusal = "refused" | "invalid_args";

export type { PhoneRpcCopy };

export interface PhoneRpcIdentity {
  botName: string;
  workspace: string;
  provider: { id: string; name: string };
}

export interface PhoneRpcDeps {
  authorities: PhoneAuthorities;
  dispatchFacts(generation: string): { automationSource?: unknown; origin?: MessageOrigin } | null;
  grant(botId: string): PhoneApps;
  registry: PhoneRegistry;
  jobs: PhoneJobs;
  markThread(threadId: string): void;
  copy: PhoneRpcCopy;
  /** Bot name, workspace name and the AI company for the phone's card. Null when they cannot be named: the call is refused. */
  identity(botId: string, threadId: string): PhoneRpcIdentity | null;
}

export type PhoneRpcResult = { ok: true; text: string } | { ok: false; code: RpcRefusal | FailCode; text: string };


function isTool(name: unknown): name is PhoneToolName {
  return typeof name === "string" && (PHONE_TOOL_NAMES as readonly string[]).includes(name);
}

/** The phone a tool would run on, or null: the registry's pick for the tool's capability, if that phone's report and the grant allow the tool. */
export function phoneForTool(grant: PhoneApps, registry: PhoneRegistry, tool: PhoneToolName): PhoneRegistration | null {
  const reg = registry.chooseFor(PHONE_ACTIONS[tool].capability);
  if (reg === null) return null;
  return phoneTools(grant, reg.capabilities).includes(tool) ? reg : null;
}

/** The tools a turn may be offered right now: grant intersected with what a registered phone reports, in catalog order. */
export function offeredPhoneTools(grant: PhoneApps, registry: PhoneRegistry): PhoneToolName[] {
  return PHONE_TOOL_NAMES.filter((tool) => phoneForTool(grant, registry, tool) !== null);
}

const refuse = (copy: PhoneRpcCopy, code: RpcRefusal, log?: (code: string) => void): PhoneRpcResult => {
  log?.(code);
  return { ok: false, code, text: code === "invalid_args" ? copy.invalidArgs : copy.refused };
};

export async function phoneRpc(claim: InternalCapability, call: { tool: PhoneToolName; args: unknown }, deps: PhoneRpcDeps): Promise<PhoneRpcResult> {
  const { copy } = deps;
  // A refused call logs the code only: never the arguments, never a phone's answer.
  const no = (code: RpcRefusal): PhoneRpcResult => refuse(copy, code, (c) => console.warn(`[phone] call refused: ${c}`));
  try {
    // 1. the authority is live for this very generation, on this thread and this bot
    const authority = deps.authorities.live(claim.generation);
    if (authority === null || authority.generation !== claim.generation || authority.threadId !== claim.threadId || authority.botId !== claim.botId) return no("refused");
    // 2. F5: the turn was dispatched with no automation source, from the owner's desktop or companion
    const facts = deps.dispatchFacts(claim.generation);
    if (facts === null || (facts.automationSource !== undefined && facts.automationSource !== null)) return no("refused");
    if (facts.origin !== "desktop" && facts.origin !== "companion") return no("refused");
    // 3. F1: the tool is one the grant allows on a phone that reports it
    if (!isTool(call.tool)) return no("refused");
    const grant = deps.grant(claim.botId);
    const phone = phoneForTool(grant, deps.registry, call.tool);
    if (phone === null) return no("refused");
    // 4. the arguments parse, and a location ask is no more precise than the grant and the report allow
    const action = PHONE_ACTIONS[call.tool];
    const parsed = actionArgsSchema[action.action].safeParse(call.args);
    if (!parsed.success) return no("invalid_args");
    if (call.tool === "phone_location_get") {
      const allowed = locationPrecision(grant, phone.capabilities);
      const asked = (parsed.data as { precision: "approximate" | "precise" }).precision;
      if (allowed === null || (asked === "precise" && allowed !== "precise")) return no("refused");
    }
    const identity = deps.identity(claim.botId, claim.threadId);
    if (identity === null) return no("refused");
    // 5. the thread is marked before the job, so even a job that fails marks it (design 4.6, whatever the job's outcome)
    deps.markThread(claim.threadId);
    // authority is re-read once more right at the request: nothing between step 1 and here awaits, but this keeps the check next to the act
    if (deps.authorities.live(claim.generation) === null) return no("refused");
    const { outcome } = deps.jobs.request({
      authority, deviceId: phone.deviceId, capability: action.capability, action: action.action, args: parsed.data, say: (PHONE_COPY.say as Record<string, string>)[action.action] ?? PHONE_COPY.sayFallback,
      provider: identity.provider, phoneName: phone.name, botName: identity.botName, workspace: identity.workspace,
    });
    const done = await outcome;
    switch (done.kind) {
      // the phone name is appended last (plan 4.4)
      case "done": return { ok: true, text: JSON.stringify({ result: done.result, phone: done.phoneName }) };
      case "declined": return { ok: false, code: "declined", text: done.line };
      case "did_not_run": return { ok: false, code: "denied", text: done.line };
      case "may_have_run": return { ok: false, code: "timeout", text: done.line };
    }
  } catch {
    // fail closed: anything unexpected is a plain refusal, with no detail
    return no("refused");
  }
}
