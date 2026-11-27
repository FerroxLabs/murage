import { mountedTurn } from "../drivers/cli-mount-relay.ts";
import { fencedTurnInput } from "../drivers/engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
// control: isolated admission for mount-shape/transport fixtures. No live app data.
import { afterAll, onTestFinished } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderAdapter, SendTurnInput } from "../contracts.ts";
import { existsSync } from "node:fs";
import { InternalCapabilities } from "../internal-capabilities.ts";
// Baseline controls use the real pre-admission adapter and mount records.
// In particular, external-admission red cases must reach sendTurn and fail
// their rejection assertion, rather than fail to import this test support.
const hasIngress = existsSync(new URL("../consuming-turn-ingress.ts", import.meta.url));
const fixtureApi = hasIngress ? await import("./consuming-fixture.ts") : undefined;
const ingressApi = hasIngress ? await import("../consuming-turn-ingress.ts") : undefined;
const mountApi = hasIngress ? await import("../drivers/mcp-mounts.ts") : undefined;
const hasAdmission = typeof mountApi?.createMcpMountAdmission === "function";
const consumingFixture = (...args: Parameters<NonNullable<typeof fixtureApi>["consumingFixture"]>) => fixtureApi!.consumingFixture(...args);
const createMcpMountAdmission = (...args: Parameters<NonNullable<typeof mountApi>["createMcpMountAdmission"]>) => mountApi!.createMcpMountAdmission(...args);
// Bundled children ask the dispatcher for real release permits. A dead URL
// only worked while fake CLIs never initialized the mounted proxies.
const authorities = new Map<InternalCapabilities, ReturnType<NonNullable<typeof ingressApi>["createProxyReleaseAuthority"]>>();
const releaseServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/internal/turn-release/v1/verdict") { res.writeHead(404).end(); return; }
  const owner = [...authorities].map(([caps, authority]) => ({ claim: caps.resolve(req.headers.authorization), authority })).find(entry => entry.claim);
  try {
    if (!owner?.claim) throw new Error("fixture authority missing");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error("fixture request limit");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body?.operation === "upstream") {
      owner.authority.reserveUpstream(owner.claim, body);
      res.end(JSON.stringify({ reserved: true }));
    } else res.end(JSON.stringify(owner.authority.verdict(owner.claim, body)));
  } catch {
    if (owner?.claim) owner.authority.seal(owner.claim);
    res.writeHead(409).end();
  }
});
await new Promise<void>(resolve => releaseServer.listen(0, "127.0.0.1", resolve));
const releaseUrl = `http://127.0.0.1:${(releaseServer.address() as AddressInfo).port}`;
afterAll(async () => {
  releaseServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => releaseServer.close(error => error ? reject(error) : resolve()));
});
/** Attach transport authority to an existing isolated retained turn without replacing its parents. */
export function fixtureBoundTurn(turn: SendTurnInput): SendTurnInput {
  const binding = turn.releaseBinding;
  if (!binding || !hasAdmission) return turn;
  const caps = new InternalCapabilities(); caps.begin(binding.identity.botId, turn.threadId, binding.identity.dispatchGeneration);
  const authority = ingressApi!.createProxyReleaseAuthority(caps); authorities.set(caps, authority);
  const mountAdmission = turn.mountAdmission ?? createMcpMountAdmission(binding, authority, releaseUrl);
  onTestFinished(() => { mountAdmission.dispose(); authorities.delete(caps); });
  const input = { ...turn, mountAdmission };
  if (input.fencedWrite) return input;
  return fencedTurnInput({ ...input, prompt: buildPrompt(binding.turn, [promptPart(turn.text, [noneRef("owner-turn")])]) },
    { db: binding.db, retained: binding.turn, reader: checkedOpenTurns(binding.turn)[0]!.reader! });
}
/** ownerTurn: bind the owner's own turn (the production owner path); default is a non-owner turn. */
export function fixtureMountTurn(turn: SendTurnInput, onRefused?: (verdict: import("../memory/lineage-types.ts").LineageVerdict) => void,
  { ownerTurn = false }: { ownerTurn?: boolean } = {}): SendTurnInput {
  if (!hasAdmission) return turn;
  const fixture = consumingFixture(undefined, { threadId: turn.threadId, botId: turn.warmIdentity?.botId ?? turn.threadId, onRefused, ownerTurn });
  const caps = new InternalCapabilities(); caps.begin(fixture.binding.identity.botId, turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = ingressApi!.createProxyReleaseAuthority(caps);
  authorities.set(caps, authority);
  const mountAdmission = createMcpMountAdmission(fixture.binding, authority, releaseUrl);
  // Driver afterEach hooks must stop their processes before the dispatcher
  // fixture closes its memory database. Otherwise late teardown uses a revoked
  // binding merely because the harness disposed its context first.
  onTestFinished(() => { try { mountAdmission.dispose(); } finally { authorities.delete(caps); fixture.close(); } });
  const bound = fencedTurnInput({ ...turn, releaseBinding: fixture.binding, mountAdmission,
    prompt: buildPrompt(fixture.turn, [promptPart(turn.text, [noneRef("owner-turn")])]) },
    { db: fixture.f.db, retained: fixture.turn, reader: checkedOpenTurns(fixture.turn)[0]!.reader! });
  // Legacy send controls mint their attempt in beforeSubmit. A synthesized
  // beforePrepare would consume that callback before the driver's write site.
  return turn.beforePrepare ? bound : { ...bound, beforePrepare: undefined };
}
/** control: native-answer scenarios retain the exact turn's real binding.
 * This does not grant external MCP admission or change any submitted mount. */
const boundAdapters = new WeakSet<ProviderAdapter>();
const fixtureInputs = new WeakMap<ProviderAdapter, SendTurnInput>();
export const fixtureSubmittedInput = (adapter: ProviderAdapter): SendTurnInput => {
  const input = fixtureInputs.get(adapter);
  if (!input) throw new Error("fixture has no submitted input");
  return input;
};
export function bindFixtureAdapter(adapter: ProviderAdapter, options: { mountsOnly?: boolean } = {}): void {
  if (boundAdapters.has(adapter)) return;
  boundAdapters.add(adapter);
  const send = adapter.sendTurn.bind(adapter);
  // null explicitly selects a non-consuming control; omitted binding allocates a fixture generation.
  adapter.sendTurn = turn => {
    fixtureInputs.set(adapter, turn);
    const bound = options.mountsOnly && !mountedTurn(turn) ? turn : turn.releaseBinding !== undefined ? turn : fixtureMountTurn(turn);
    // Preserve the legacy attempt hook at the actual send boundary.
    return send(turn.beforeSubmit && !turn.beforePrepare && !turn.prepareSubmit
      ? {...bound, beforePrepare: undefined, prepareSubmit: undefined} : bound);
  };
}
export function fixtureMcpServers(servers: Record<string, unknown>): Record<string, unknown> {
  if (!hasAdmission) return servers;
  // These legacy transport controls model independent sessions. Production's
  // buildMcpServers shares one binding; the same-turn refusal tests cover that.
  return Object.fromEntries(Object.entries(servers).map(([name, entry]) => {
    const turn = fixtureMountTurn({ threadId: "T", text: "fixture" });
    return [name, turn.mountAdmission!.mount((entry ?? {}) as Record<string, unknown>)];
  }));
}
/** Preserve a legacy fake driver's scenario while supplying the server-owned
 * retained ingress now required by the consuming transport. */
export async function admittedFixtureInstance<T extends { adapter: ProviderAdapter }>(pending: Promise<T>): Promise<T> {
  const instance = await pending;
  bindFixtureAdapter(instance.adapter);
  return instance;
}

/** A positive steer control owns the same retained fence as a dispatched turn. */
export function fixtureEngineFence(threadId: string): import("../drivers/engine-input.ts").EngineFence {
  const f = consumingFixture(undefined, { threadId, empty: true });
  onTestFinished(() => f.close());
  return { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! };
}
