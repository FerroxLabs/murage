// Host CUA is shared, but ordinary model turns are not computer operations.
// Keep the trusted driver behind the harness and reserve it only while an
// admitted tool call (including transport cleanup) is actually outstanding.
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";

export type HostComputerSpec = { command: string; args: string[]; env: Record<string, string> };
const refused = () => Object.assign(new Error("Computer control changed or this turn is no longer active; its result cannot be delivered."), { status: 409 });

export class HostComputerBroker {
  private active: object | undefined;
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private readonly start: (spec: HostComputerSpec) => EngineClient;
  constructor(start: (spec: HostComputerSpec) => EngineClient = startHeadlessEngine) { this.start = start; }

  dispatch(spec: HostComputerSpec, method: string, params: Record<string, unknown> = {}, authorize: () => boolean = () => false): Promise<unknown> {
    const allowed = () => { if (this.closing || !authorize()) throw refused(); };
    allowed();
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported computer method");
    if (method === "tools/call" && (typeof params.name !== "string" || !params.name)) throw new Error("Invalid computer tool call");
    const claim = method === "tools/call" ? {} : undefined;
    if (claim && this.active) throw Object.assign(new Error("Another computer action is in progress. This call was not performed; inspect the screen again before retrying."), { status: 409 });
    if (claim) this.active = claim;
    const operation = (async () => {
      let client: EngineClient | undefined;
      let closed = false;
      let result: unknown;
      let actionStarted = false;
      let actionReplied = false;
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        client = this.start({ ...spec, env: { ...env, ...spec.env } });
        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-host-computer", version: "1" } });
        await client.notify?.("notifications/initialized");
        allowed();
        actionStarted = Boolean(claim);
        result = await client.request(method, params);
        actionReplied = true;
        allowed();
      } finally {
        // The MCP child proxies a separate host daemon. Closing that child
        // cannot prove a timed-out daemon action stopped. Retain exclusion
        // without a matching reply; only normal confirmed replies recycle it.
        if (client) { await client.close(); closed = true; }
        else closed = true;
        if (closed && (!actionStarted || actionReplied) && claim && this.active === claim) this.active = undefined;
      }
      allowed();
      return result;
    })();
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    if (this.active) throw new Error("Host computer operation cleanup is unconfirmed");
  }
}
