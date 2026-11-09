import { cloudTurnRenderContents } from "./cloud-home/turn-process.ts";
import { fluxDestination, type EffectiveDestination } from "./flux-destination.ts";
import { OpenCodeDestinationKey, type DestinationEnv } from "./opencode-destination-key.ts";
import { spawnCli, engineJob, awaitCliTreeStopped, forceCliTreeStopped, awaitCliRootClose } from "./procs.ts";
import { ProviderStopUnconfirmedError } from "./drivers/child-teardown.ts";

export interface DestinationContext {
  env: DestinationEnv; cwd: string; cli: string; signal: AbortSignal;
  model?: string; memoryOff: boolean; cliVersion?: string;
}
export type DestinationAnswer = EffectiveDestination & {
  model?: string;
  failureVersion?: string;
  forModel?(model: string | undefined, resumed?: boolean): EffectiveDestination;
};
type Config = { model?: string; provider?: Record<string, any> };
const unknown = (): EffectiveDestination => ({ unknown: "config" });
export function openCodeDestinationAnswer(config: Config, ctx: Pick<DestinationContext, "model" | "memoryOff">): DestinationAnswer {
  const providers = config.provider ?? {};
  if (!providers || typeof providers !== "object" || Array.isArray(providers)
    || Object.values(providers).some(value => !value || typeof value !== "object" || Array.isArray(value))) {
    return { ...unknown(), forModel: unknown };
  }
  const judge = (model: string | undefined, resumed = false): EffectiveDestination => {
    if (typeof model !== "string" || !model.includes("/")) return unknown();
    const slash = model.indexOf("/"), id = model.slice(0, slash), name = model.slice(slash + 1);
    const provider = providers[id];
    if (!provider) return resumed ? unknown() : { provider: id, urls: [] };
    const headerMaps = [provider.options?.headers, provider.models?.[name]?.headers];
    if (id === "flux" && ctx.memoryOff) {
      for (const owner of [provider.options, provider.models?.[name]]) {
        if (!owner || !Object.hasOwn(owner, "headers")) continue;
        const headers = owner.headers;
        if (!headers || typeof headers !== "object" || Array.isArray(headers)
          || Object.values(headers).some(value => typeof value !== "string")) return unknown();
      }
    }
    if (id === "flux" && ctx.memoryOff && headerMaps.some(headers => headers && Object.keys(headers).some(key => key.toLowerCase().startsWith("x-flux-memory")))) return unknown();
    const urls: unknown[] = [];
    for (const [object, key] of [[provider.options, "baseURL"], [provider.options, "endpoint"], [provider, "api"], [provider.models?.[name], "api"], [provider.models?.[name]?.provider, "api"], [provider.models?.[name]?.options, "baseURL"], [provider.models?.[name]?.options, "endpoint"]] as const) {
      if (object && Object.hasOwn(object, key)) urls.push(object[key]);
    }
    return { provider: id, urls };
  };
  const model = ctx.model || config.model;
  let destination: EffectiveDestination;
  if (model) destination = judge(model);
  else {
    destination = { provider: "__default__", urls: [] };
    for (const [id, provider] of Object.entries(providers)) {
      for (const name of new Set(["", ...Object.keys(provider.models ?? {})])) {
        const candidate = judge(`${id}/${name}`), result = fluxDestination(candidate, "flux");
        if (result.startsWith("refuse")) return { ...candidate, forModel: judge };
        if (result === "connector") destination = candidate;
      }
    }
  }
  return { ...destination, model, forModel: judge };
}
export async function probeOpenCodeDestination(ctx: DestinationContext): Promise<Config> {
  if (ctx.signal.aborted) throw new Error("stopped");
  const child = spawnCli(ctx.cli, ["debug", "config"], { cwd: ctx.cwd, env: ctx.env, stdio: ["pipe", "pipe", "pipe"] }, engineJob({ posixHostPower: true }));
  child.stdin.end();
  let output = "", bytes = 0, timer: ReturnType<typeof setTimeout>;
  let stop: Promise<void> | undefined;
  const stopChild = () => stop ??= (async () => {
    let confirmed = await awaitCliTreeStopped(child);
    if (!confirmed) confirmed = await forceCliTreeStopped(child);
    if (confirmed) confirmed = await awaitCliRootClose(child);
    if (!confirmed) throw new ProviderStopUnconfirmedError("opencodeGo", { closeConfirmed: false, reason: "timeout" });
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { void stopChild().then(() => reject(new Error("stopped")), reject); };
      ctx.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(cancel, 10_000);
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) cancel(); else output += chunk.toString(); });
      child.stderr.resume();
      child.once("error", () => { void stopChild().then(() => reject(new Error("spawn")), reject); });
      child.once("close", code => {
        ctx.signal.removeEventListener("abort", cancel);
        if (stop) void stop.then(() => reject(new Error("stopped")), reject);
        else if (code === 0) resolve(); else reject(new Error("probe"));
      });
    });
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config");
    return parsed;
  } finally { clearTimeout(timer!); if (stop) await stop; }
}
export class OpenCodeDestinationResolver {
  private keys = new OpenCodeDestinationKey();
  private cache = new Map<string, Config>();
  private probe: typeof probeOpenCodeDestination;
  private now: () => number;
  constructor(probe = probeOpenCodeDestination, now = Date.now) { this.probe = probe; this.now = now; }
  dispose(): void { this.keys.close(); this.cache.clear(); }
  async resolve(ctx: DestinationContext): Promise<DestinationAnswer> {
    if (process.env.MURAGE_CLOUD_ROLE === "home") {
      try {
        const route = cloudTurnRenderContents(ctx.env).route;
        return openCodeDestinationAnswer({ provider: route ? { [route.provider]: { options: { baseURL: route.baseUrl } } } : {} }, ctx);
      } catch { return { ...unknown(), forModel: unknown }; }
    }
    const start = performance.now();
    const before = this.keys.read(ctx.env, ctx.cwd, ctx.cli, this.now());
    // The compiled installation channel selects a different account database on
    // development builds. Unless the hand pins its path, do not cache a build
    // whose reported version cannot identify a release database.
    if (!ctx.env.OPENCODE_DB && !["1", "true"].includes(ctx.env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
      && ctx.cliVersion !== undefined && !/^(?:opencode\s+)?\d+\.\d+\.\d+$/.test(ctx.cliVersion.trim())) before.cacheable = false;
    let source = "probe", answer: DestinationAnswer;
    try {
      let config = before.cacheable ? this.cache.get(before.key) : undefined;
      if (config) source = "cache";
      else config = await this.probe(ctx);
      answer = openCodeDestinationAnswer(config, ctx);
      if (source === "probe") {
        const after = this.keys.read(ctx.env, ctx.cwd, ctx.cli, this.now());
        if (before.cacheable && after.cacheable && after.settled && before.key === after.key) {
          if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(after.key, config);
        }
      }
    } catch (error) {
      if (error instanceof ProviderStopUnconfirmedError) throw error;
      answer = { ...unknown(), forModel: unknown, failureVersion: ctx.cliVersion };
    }
    console.info(`opencode_dest outcome=${fluxDestination(answer, "flux")} source=${source} ms=${(performance.now() - start).toFixed(3)}`);
    return answer;
  }
}
