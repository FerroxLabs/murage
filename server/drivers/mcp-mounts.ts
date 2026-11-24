/** The integration -> stdio MCP mount builder shared by Pi and the OpenAI-chat engines (OPENAI-TOOLS-109 s1.2): moved
 *  unchanged out of pi.ts, which re-exports it. */
import type { SendTurnInput } from "../contracts.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";
import { connectedAppsServerName } from "../../shared/connected-app-names.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Mirror of the Claude driver's integration → stdio MCP mount: every entry is
 * a JSON-RPC 2.0 stdio server the pi-mcp-extension consumes. Returns null when
 * there is nothing to mount (the common case). */
export function buildMcpServers(turn: SendTurnInput, options: { askBeforeCustom?: boolean } = {}): Record<string, unknown> | null {
  assertConsumingMountAdmission(turn, "server");
  const servers: Record<string, unknown> = {};
  // A session an earlier release started keeps the older name its history calls by.
  if (turn.integrations?.composio) servers[connectedAppsServerName(turn.integrations.composio.env)] = { ...turn.integrations.composio };
  if (turn.integrations?.computer) {
    servers.computer = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
    };
  } else if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind
      // a permission card; isolated computers deliberately omit it.
      ...(local.scope ? { scope: local.scope } : {}),
    };
  }
  if (turn.integrations?.browser) servers.browser = { ...turn.integrations.browser };
  if (turn.integrations?.memory) servers["murage-memory"] = { ...turn.integrations.memory };
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  // 1.0.9 S13b: the owner's phone; asks on every call like any non-listed own mount.
  if (turn.integrations?.phoneJobs) servers.phoneJobs = { ...turn.integrations.phoneJobs };
  if (turn.integrations?.browser) servers.browser = { ...turn.integrations.browser };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  // The owner's own servers (command or link). Not pre-allowed anywhere: the
  // extension gates a `custom` scope behind the same permission card as the
  // host computer, so every call asks, as Claude's Allow/Deny card does. An
  // instance that runs without asks (Full access) mounts them ungated, which
  // is what Claude's bypass mode does for the same servers.
  for (const mount of customMountEntries(turn.integrations?.custom, (name) => name in servers)) {
    // Rule 11: a name holding `__` cannot be told apart from its tools.
    if (mount.name.includes("__")) continue;
    servers[mount.name] = {
      command: mount.command,
      args: mount.args,
      env: mount.env,
      ...(options.askBeforeCustom === false ? {} : { scope: "custom" }),
    };
  }
  for (const [name, entry] of Object.entries(servers)) servers[name] = turn.mountAdmission!.mount(entry as Record<string, unknown>);
  return Object.keys(servers).length ? Object.freeze(servers) : null;
}

/** Rule 54: one record per server in the mcp.json written for the MCP
 * extension. No external records. */
export function piMountRecords(turn: SendTurnInput, servers: Record<string, unknown> | null): McpMountRecord[] {
  const own = new Map<string, string>([["murage-memory", "own:memory"], ["agents", "own:agents"], ["phone", "own:phone"], ["dweb", "own:dweb"], ["computer", "own:computer"]]);
  if (turn.integrations?.browser) own.set("browser", "own:browser");
  // only a turn that mounts the phone owns that name; no other server may claim `own:phoneJobs`
  if (turn.integrations?.phoneJobs) own.set("phoneJobs", "own:phoneJobs");
  if (turn.integrations?.composio) own.set(connectedAppsServerName(turn.integrations.composio.env), "own:connector");
  const records: McpMountRecord[] = [];
  for (const name of Object.keys(servers ?? {})) {
    admittedMcpMount(servers![name]);
    if (name.includes("__")) continue;
    const mountId = own.get(name);
    records.push(mountId ? { engineName: name, mountId, provenance: "own" } : { engineName: name, mountId: `custom:${name}`, provenance: "custom" });
  }
  return records;
}

import { assertConsumingBinding, refuseConsumingTurn, registerConsumingDescriptor, type ConsumingTurnBinding } from "../consuming-turn-response.ts";
import { createProxyReleaseAuthority, createConsumingIngress } from "../consuming-turn-ingress.ts";
import type { ReleaseEnvelope } from "../consuming-turn-ingress.ts";
import { deferringPendingFence, isPendingFenceDeferral } from "../memory/send-fence.ts";
export interface AdmittedMcpMount {
  readonly ingress: ReturnType<typeof createConsumingIngress>;
  readonly enveloped: boolean;
  accept(line: string, write: (frame: string) => void, delimiter?: "\n"): ReleaseEnvelope | undefined;
  /** 1.0.20 revkill2: void a reply that met a pending check (see accept); nothing of it is released. */
  drop?(): void;
  close(): void;
}
const admittedMounts = new WeakMap<object, AdmittedMcpMount>();
const admissions = new WeakSet<object>();
const freshAdmissions = new WeakMap<object, (binding: ConsumingTurnBinding) => McpMountAdmission>();
/** Server-only, one-shot successor capability. Disposal never revives an
 * admission or its release instances; retry allocates fresh mount slots but retains the generation release budget. */
export function freshMcpMountAdmission(previous: McpMountAdmission, binding: ConsumingTurnBinding): McpMountAdmission {
  assertConsumingBinding(binding);
  if (previous.binding !== binding) throw new Error("MEMORY_CONTEXT_REVOKED");
  const fresh = freshAdmissions.get(previous);
  if (!fresh) throw new Error("MEMORY_CONTEXT_REVOKED");
  return fresh(binding);
}
export interface McpMountAdmission {
  readonly binding: ConsumingTurnBinding;
  mount(entry: Record<string, unknown>): Record<string, unknown>;
  dispose(): void;
}
/** A grant is an in-process object held by the server, never a configuration flag. */
export function createMcpMountAdmission(binding: ConsumingTurnBinding, authority: ReturnType<typeof createProxyReleaseAuthority>, url: string): McpMountAdmission {
  assertConsumingBinding(binding);
  const disposals = new Set<() => void>();
  let disposed = false;
  const admission: McpMountAdmission = Object.freeze({ binding,
    dispose() { if (disposed) return; disposed = true; for (const dispose of disposals) dispose(); disposals.clear(); },
    mount(entry: Record<string, unknown>) {
    assertConsumingBinding(binding);
    // No count of mounts refuses the turn (MAIN-RULING cause22-no-transport-caps); a disposed admission still does.
    if (disposed) refuseConsumingTurn(binding);
    if (!entry || typeof entry.command !== "string" || !entry.command
      || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === "string")))
      || (entry.env !== undefined && (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)
        || Object.values(entry.env).some(value => typeof value !== "string")))) refuseConsumingTurn(binding);
    const args = entry.args as string[] | undefined;
    const role = entry.command === process.execPath ? Object.entries(SPAWNED_PROXIES).find(([, path]) => args?.[0] === path)?.[0] : undefined;
    // External Pi and the nested VPS pipe have no same-process final acceptance.
    if (role === "cliMountShim" || role === "vpsRelayMcp" || role === "piMcpExtension" || role === "piPermissionGate") refuseConsumingTurn(binding);
    let descriptor: ReturnType<typeof registerConsumingDescriptor>;
    try { descriptor = registerConsumingDescriptor(`proxy:${role ?? "custom"}:frame`, "body"); }
    catch {
      console.warn(`[memory] mount admission refused cause=unregistered-descriptor role=${role ?? "custom"}`);
      return refuseConsumingTurn(binding);
    }
    // Internal stored-content routes have already staged provenance in Area A;
    // external MCP output has no Murage stored-source refs. No child supplies refs.
    const instance = authority.register(binding, descriptor, () => []);
    disposals.add(instance.dispose);
    let sequence = 0;
    const env = { ...(entry.env as Record<string, string> ?? {}), ...(role ? {
      MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: url,
    } : {}) };
    const result = Object.freeze({ ...entry, args: Object.freeze([...(args ?? [])]), env: Object.freeze(env) });
    // 1.0.20 revkill2: a frame that met held context still checking:pending keeps its envelope; the relay offers the same line once more.
    let held: { line: string; envelope: ReleaseEnvelope } | undefined;
    admittedMounts.set(result, Object.freeze({ ingress: instance.ingress, enveloped: Boolean(role), close: instance.dispose,
      drop() { held = undefined; instance.ingress.drop(); },
      accept(line: string, write: (frame: string) => void, delimiter?: "\n") {
      return deferringPendingFence(() => {
        const retry = held?.line === line ? held.envelope : undefined;
        held = undefined;
        // Third-party stdout ends at this server-owned acceptance callback. It
        // cannot receive a raw passthrough to a CLI or mint its own permit.
        const envelope = retry ?? (role ? decodeReleaseEnvelope(line, instance.ingress.ownerTurn)
          : instance.ingress.issue({ instanceId: instance.instanceId, sequence: sequence + 1, frame: line, descriptor, refs: [] }));
        if (!role) sequence = envelope.sequence;
        try { instance.ingress.deliver(envelope, write, delimiter); }
        catch (error) { if (isPendingFenceDeferral(error) && !instance.ingress.sealed) held = { line, envelope }; throw error; }
        return role ? envelope : undefined;
      });
    } }));
    return result;
  } });
  admissions.add(admission);
  freshAdmissions.set(admission, current => {
    assertConsumingBinding(current);
    if (!disposed || current !== binding) throw new Error("MEMORY_CONTEXT_REVOKED");
    freshAdmissions.delete(admission);
    return createMcpMountAdmission(binding, authority, url);
  });
  return admission;
}
import { decodeReleaseEnvelope } from "../consuming-turn-ingress.ts";
export function admittedMcpMount(entry: unknown): AdmittedMcpMount {
  const admitted = entry && typeof entry === "object" ? admittedMounts.get(entry) : undefined;
  if (!admitted) throw new Error("MEMORY_CONTEXT_REVOKED");
  return admitted;
}
export function assertConsumingMountAdmission(turn: SendTurnInput, destination: "external" | "server" = "external", required = false): void {
  const mounted = required || Object.values(turn.integrations ?? {}).some(value => value && (typeof value !== "object" || Object.keys(value).length > 0));
  if (!mounted) return;
  const binding = turn.releaseBinding;
  if (!binding) throw new Error("MEMORY_CONTEXT_REVOKED");
  assertConsumingBinding(binding);
  if (destination !== "server" || !turn.mountAdmission || !admissions.has(turn.mountAdmission) || turn.mountAdmission.binding !== binding) refuseConsumingTurn(binding);
}
