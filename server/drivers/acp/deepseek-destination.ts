// Owners: new3-g3b owns destination resolution; op-misc owns DeepSeek's
// provider configuration; op-resend owns ACP admission and resume revalidation.
import { readDeepseekEnv } from "./deepseek-env.ts";
import { registerBusyloopPayloadSite } from "../../../shared/flux-route.ts";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { parseDocument } from "yaml";
import { probeCliDestination, type DestinationAnswer, type DestinationContext } from "../../opencode-destination.ts";
import type { EffectiveDestination } from "../../flux-destination.ts";

const unknown = (): EffectiveDestination => ({ unknown: "deepseek-config" });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const PROVIDER = "deepseek-official";
const PUBLIC_BASE = "https://api.deepseek.com/anthropic";

/** dsh composes its bundle, profile, home and argv patches without evaluating
 * !!js in --dump-config. Dynamic route settings remain unknown, never native.
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/dump-config.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek-api-key/src/config.ts */
export async function deepseekDestinationAnswer(text: string, ctx: Pick<DestinationContext, "env" | "cwd" | "model"> & { signal?: AbortSignal }): Promise<DestinationAnswer> {
  try {
    if (ctx.signal?.aborted) throw new Error("stopped");
    // Windows folds inherited variable names. Do not guess which spelling
    // survived a duplicate-key environment handoff.
    if (process.platform === "win32" && Object.keys(ctx.env).some(name => ["DSH_HOME", "DSH_SNAPSHOT", "HOME", "USERPROFILE", "DEEPSEEK_BASE_URL"].includes(name.toUpperCase()) && name !== name.toUpperCase())) throw new Error("config");
    // Replay boots cordis.snapshot.yml rather than the tree dumped here.
    if (ctx.env.DSH_SNAPSHOT) throw new Error("config");
    const document = parseDocument(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: () => ({ dynamic: true }) }] });
    if (document.errors.length || document.warnings.length) throw new Error("config");
    const tree: unknown = document.toJS({ maxAliasCount: 32 });
    if (!Array.isArray(tree)) throw new Error("config");
    const entries: Record<string, unknown>[] = [];
    const visit = (rows: unknown[], depth = 0) => {
      if (depth > 16) throw new Error("config");
      for (const row of rows) {
        if (!record(row)) throw new Error("config");
        if (row.disabled === true) continue;
        if (row.disabled !== undefined && row.disabled !== false) {
          if (row.group === true || row.name === "@deepseek-ai/dsh-llm-deepseek-api-key" || row.name === "@deepseek-ai/dsh-acp") throw new Error("config");
          continue;
        }
        entries.push(row);
        if (row.group === true) {
          if (!Array.isArray(row.config)) throw new Error("config");
          visit(row.config, depth + 1);
        }
      }
    };
    visit(tree);
    const providers = entries.filter(row => row.name === "@deepseek-ai/dsh-llm-deepseek-api-key");
    if (providers.length !== 1) throw new Error("config");
    const config = providers[0].config ?? {};
    if (!record(config)) throw new Error("config");
    let base: unknown = config.baseURL;
    if (base === undefined) {
      // dsh permits endpoint overrides in the process and Harness-home .env;
      // a project .env endpoint is rejected even when a higher layer wins.
      // See upstream packages/boot/app-boot/src/index.ts:loadLayeredEnv.
      const valueOf = (values: Record<string, string | undefined>) => process.platform === "win32"
        ? Object.entries(values).reverse().find(([key]) => key.toUpperCase() === "DEEPSEEK_BASE_URL")?.[1]
        : values.DEEPSEEK_BASE_URL;
      base = valueOf(ctx.env);
      const ownerHome = process.platform === "win32" ? ctx.env.USERPROFILE : ctx.env.HOME;
      const home = ctx.env.DSH_HOME || (ownerHome && join(ownerHome, ".dsh"));
      // Relative or absent homes cannot be resolved from the server's cwd or
      // account: the probe and native child must consult the same .env file.
      if (!home || !isAbsolute(home)) throw new Error("config");
      const paths = [join(ctx.cwd, ".env"), join(home, ".env")];
      const layers = await readDeepseekEnv(paths, ctx.signal);
      for (const [index, text] of layers.entries()) {
        const values = parseEnv(text);
        if (index === 0 && paths[0] !== paths[1] && Object.keys(values).some(key => key.toUpperCase() === "DEEPSEEK_BASE_URL")) throw new Error("config");
        base ??= valueOf(values);
      }
      base ??= PUBLIC_BASE;
    }
    if (typeof base !== "string") throw new Error("config");
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("config");
    const acp = entries.filter(row => row.name === "@deepseek-ai/dsh-acp");
    const defaults = acp.length === 1 && record(acp[0].config) ? acp[0].config : undefined;
    const defaultModel = defaults && typeof defaults.provider === "string" && typeof defaults.model === "string"
      ? JSON.stringify([defaults.provider, defaults.model]) : undefined;
    const judge = (model: string | undefined): EffectiveDestination => {
      if (!model) return unknown();
      let pair: unknown;
      try { pair = registerBusyloopPayloadSite("read", JSON.parse(model)); } catch { pair = model.split(/\/(.*)/s).slice(0, 2); }
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== PROVIDER || typeof pair[1] !== "string" || !pair[1]) return unknown();
      return { provider: PROVIDER, urls: [base] };
    };
    const model = ctx.model || defaultModel;
    if (ctx.signal?.aborted) throw new Error("stopped");
    return { ...judge(model), model, forModel: judge };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return { ...unknown(), forModel: unknown };
  }
}

export async function resolveDeepseekDestination(ctx: DestinationContext): Promise<DestinationAnswer> {
  try {
    return await probeCliDestination(ctx, "deepseekAgent", ["--profile", "acp", "--dump-config"], text => deepseekDestinationAnswer(text, ctx));
  } catch (error) {
    // A failed stop is an ownership failure, not an ordinary unknown config.
    if ((error as { code?: string }).code === "provider_stop_unconfirmed" || ctx.signal.aborted) throw error;
    return { ...unknown(), forModel: unknown };
  }
}
