// Owners: composio-429-e owns this transport fixture and its supervisor consumers.
import { createSupervisorPort as productionPort } from "../cloud-home/supervisor-port.ts";
import { connectedAppsCredentials } from "../cloud-home/credential-projection.ts";

type Options = Parameters<typeof productionPort>[0] & {
  mintRetryDelaysMs?: number[];
  remintConnectedApps?: (credentials: Record<string, string>, options: { force: boolean }) => Promise<Record<string, string>>;
  revokeBrokerToken?: (url: string, token: string) => Promise<unknown>;
};
const admissionRecords = new WeakMap<Options["store"], unknown[]>();
/** Preserve old scenario fixtures at the transport boundary of the real authority. */
export function createSupervisorPort(options: Options) {
  let force = false;
  const transport: typeof fetch = async (url, init) => {
    const text = String(url);
    if (text.endsWith("/v1/tokens") && options.remintConnectedApps) {
      const next = await options.remintConnectedApps(connectedAppsCredentials(options.store.getAll()), { force });
      return Response.json({ token: next.fluxComposioBrokerToken,
        expiresAt: Number.isFinite(Date.parse(next.fluxComposioBrokerTokenExpiresAt ?? "")) ? next.fluxComposioBrokerTokenExpiresAt : new Date(Date.now() + 30 * 86400_000).toISOString(),
        accountKind: next.fluxComposioAccountKind });
    }
    if (text.endsWith("/v1/tokens/current") && options.revokeBrokerToken) {
      const token = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      return new Response(null, { status: await options.revokeBrokerToken(text.slice(0, -"/v1/tokens/current".length), token) ? 200 : 503 });
    }
    throw new Error("Unexpected supervisor fixture transport");
  };
  const started = options.now?.() ?? Date.now(), initialWall = Date.now();
  const port = productionPort({ ...options,
    store: { getAll: () => options.store.getAll(), patch: patch => options.store.patch(patch),
      readBack: () => options.store.readBack ? options.store.readBack() : options.store.getAll(),
      patchDurable: patch => { if (options.store.patchDurable) return options.store.patchDurable(patch); options.store.patch(patch); return { durable: true }; } },
    admissionNow: options.admissionNow ?? (() => initialWall + (options.now?.() ?? Date.now()) - started),
    admissionMonotonic: options.admissionMonotonic ?? options.now ?? Date.now,
    admissionStore: options.admissionStore ?? {
      load: () => structuredClone(admissionRecords.get(options.store) ?? []) as ReturnType<NonNullable<Options["admissionStore"]>["load"]>,
      save: rows => { admissionRecords.set(options.store, structuredClone(rows)); },
    },
    composioTransport: options.composioTransport ?? transport,
  });
  const settle = async () => { for (let i = 0; i < 1200; i++) await Promise.resolve(); };
  return { ...port,
    admissionRecords: () => structuredClone(admissionRecords.get(options.store) ?? []) as { notBefore: number }[],
    async handle(input: unknown, generation?: number) {
      force = (input as { type?: string })?.type === "murage:flux-composio-token-rejected";
      await port.handle(input, generation); await settle();
    },
    async configure() { force = false; await port.configure(); await settle(); },
    async remintConnectedApps() { force = true; await port.remintConnectedApps(); await settle(); },
  };
}
