// Fixture owner: c3-memrevoked. Consuming admission producer owner: sfx-fixture.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SendTurnInput } from "../contracts.ts";

/** Catalog fixtures use the same server-owned peer and persistent native shim
 * connection as a real mounted turn. The fake engine cannot publish a marker
 * by spawning an unrelated child with copied environment fields. */
export function c11FixtureIntegrations(integrations: NonNullable<SendTurnInput["integrations"]>, spec: {
  catalogs: Record<string, readonly string[] | null>; catalogVariants?: Array<Record<string, readonly string[] | null>>;
  resources?: boolean; resourceVariants?: boolean[]; skipMarker?: string;
}, root: string): NonNullable<SendTurnInput["integrations"]> {
  const result = { ...integrations };
  for (const key of ["agents", "memory", "composio"] as const) {
    const entry = result[key];
    if (!entry) continue;
    const name = key === "agents" ? result.agents?.serverName ?? "agents" : key === "memory" ? "murage-memory" : "murage_connectors";
    result[key] = { ...entry, command: process.execPath, args: [fileURLToPath(new URL("./fake-c11-mcp.mjs", import.meta.url))], env: { ...entry.env,
      FIXTURE_CATALOGS: JSON.stringify((spec.catalogVariants ?? [spec.catalogs]).map(catalog => catalog[name] ?? null)),
      FIXTURE_RESOURCE_VARIANTS: JSON.stringify(spec.resourceVariants ?? [spec.resources ?? false]),
      FIXTURE_LAUNCHES: join(root, `mount-${name.replace(/[^a-zA-Z0-9-]/g, "_")}.jsonl`),
      ...(spec.skipMarker === name ? { FIXTURE_NO_CATALOG: "1" } : {}),
    } };
  }
  return result;
}
