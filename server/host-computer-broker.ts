// Host CUA is shared, but ordinary model turns are not computer operations.
// Keep the trusted driver behind the harness and reserve it only while an
// admitted tool call (including transport cleanup) is actually outstanding.
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";

export type HostComputerSpec = { command: string; args: string[]; env: Record<string, string> };
const refused = () => Object.assign(new Error("Computer control changed or this turn is no longer active; its result cannot be delivered."), { status: 409 });
// A stop withdraws the action (MCP notifications/cancelled) but cannot recall
// input the driver already sent to the OS, so the wording never claims it can.
const cancelled = (sent: boolean) => Object.assign(new Error(sent
  ? "Stopped: this computer action was cancelled. An action already sent to the computer may still have taken effect; inspect the screen before continuing."
  : "Stopped before this computer action was sent; nothing was performed."), { status: 409, code: "cancelled", sent });

export class HostComputerBroker {
  private active: object | undefined;
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private readonly start: (spec: HostComputerSpec) => EngineClient;
  constructor(start: (spec: HostComputerSpec) => EngineClient = startHeadlessEngine) { this.start = start; }

  /** `signal` is the stop: it answers the caller at once and withdraws the
   * action, while exclusion is still held until the driver really replies. */
  dispatch(spec: HostComputerSpec, method: string, params: Record<string, unknown> = {}, authorize: () => boolean = () => false, signal?: AbortSignal): Promise<unknown> {
    const allowed = () => { if (this.closing || !authorize()) throw refused(); };
    allowed();
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported computer method");
    if (method === "tools/call" && (typeof params.name !== "string" || !params.name)) throw new Error("Invalid computer tool call");
    const claim = method === "tools/call" ? {} : undefined;
    if (claim && this.active) throw Object.assign(new Error("Another computer action is in progress. This call was not performed; inspect the screen again before retrying."), { status: 409 });
    if (signal?.aborted) throw cancelled(false);
    if (claim) this.active = claim;
    let actionStarted = false;
    const operation = (async () => {
      let client: EngineClient | undefined;
      let closed = false;
      let result: unknown;
      let actionReplied = false;
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        client = this.start({ ...spec, env: { ...env, ...spec.env } });
        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-host-computer", version: "1" } });
        await client.notify?.("notifications/initialized");
        allowed();
        if (signal?.aborted) throw cancelled(false);
        actionStarted = Boolean(claim);
        result = await client.request(method, params, { signal });
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
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
      const stop = () => reject(cancelled(actionStarted));
      signal.addEventListener("abort", stop, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    if (this.active) throw new Error("Host computer operation cleanup is unconfirmed");
  }
}
