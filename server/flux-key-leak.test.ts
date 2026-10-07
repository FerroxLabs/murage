// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Nothing that is not an sk-flux- key reaches api.fluxrouter.ai: not on start
// (refreshDue), not from the Test button (refresh), not for images (the
// resolved row must be disabled). And Flux's own answer to Murage's catalog
// call is what marks a key refused (Fuigo falls back to bundled models and
// exits 0 on a 401, so its exit code cannot).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateProviderBank } from "../electron/provider-connections.mjs";
import { ProviderConnectionsService } from "./provider-connections.ts";
import { legacyFluxError } from "./flux-config.ts";

const REAL = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BAD = ["https://api.fluxrouter.ai/v1", "abc12345xyz", "sk-0123456789abcdef0123456789abcdef"];
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function service(options: { legacy?: string; bank?: string; onCatalogOutcome?: (c: { id: string; key: string }, o: "ok" | "refused") => void; status?: number }) {
  const cacheDir = mkdtempSync(join(tmpdir(), "flux-leak-"));
  roots.push(cacheDir);
  const fetcher = vi.fn<typeof fetch>(async () => options.status && options.status !== 200 ? new Response("", { status: options.status }) : new Response(JSON.stringify({ data: [{ id: "flux-auto", name: "Auto" }] })));
  const svc = new ProviderConnectionsService({
    readBank: () => options.bank ?? "[]", cacheDir, fetch: fetcher,
    ...(options.onCatalogOutcome ? { onCatalogOutcome: options.onCatalogOutcome } : {}),
    legacyConnections: () => options.legacy === undefined ? [] : [{ id: "legacy-flux", preset: "flux", label: "Flux Router", key: options.legacy, enabled: !legacyFluxError(options.legacy), ...(legacyFluxError(options.legacy) ? { legacyError: legacyFluxError(options.legacy)! } : {}), revision: "rev", legacy: true, managedIn: "connections" }],
  });
  return { svc, fetcher };
}
const bearers = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(call => String((call[1] as RequestInit | undefined)?.headers && JSON.stringify((call[1] as RequestInit).headers)));

describe("H1: a value that is not an sk-flux- key is never an enabled Flux connection", () => {
  it("legacyFluxError flags every bad value and passes a real key", () => {
    for (const value of BAD) expect(legacyFluxError(value), value).toMatch(/not a Flux Router key/);
    expect(legacyFluxError(REAL)).toBeUndefined();
    expect(legacyFluxError("")).toBeUndefined();
  });

  for (const value of BAD) {
    it(`sends nothing to Flux for ${value.slice(0, 12)} on start, Test or images`, async () => {
      const { svc, fetcher } = service({ legacy: value });
      await svc.refreshDue();
      await expect(svc.refresh("legacy-flux")).rejects.toMatchObject({ status: 409 });
      expect(svc.resolve("legacy-flux")?.enabled).toBe(false);
      expect(svc.list().find(row => row.id === "legacy-flux")?.enabled).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      expect(bearers(fetcher)).toEqual([]);
    });

    it(`disables a saved bank row with ${value.slice(0, 12)} (saved before the upgrade) and never sends it`, async () => {
      const created = mutateProviderBank("[]", { action: "create", preset: "flux", key: REAL }, () => "rec-1");
      const bank = JSON.stringify(created).replace(REAL, value);
      expect(bank).toContain(value);
      const { svc, fetcher } = service({ bank });
      await svc.refreshDue();
      const row = svc.list().find(item => item.preset === "flux");
      expect(row?.enabled).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  it("still refreshes a real key", async () => {
    const { svc, fetcher } = service({ legacy: REAL });
    await svc.refreshDue();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(bearers(fetcher)[0]).toContain(REAL);
  });
});

describe("M1: Murage's own Flux catalog call reports whether the key was refused", () => {
  it.each([401, 403])("reports refused on HTTP %i", async status => {
    const seen: string[] = [];
    const { svc } = service({ legacy: REAL, status, onCatalogOutcome: (c, o) => { seen.push(`${c.id}:${o}`); } });
    const catalog = await svc.refresh("legacy-flux");
    expect(["unauthorized", "forbidden"]).toContain(catalog.error?.code);
    expect(seen).toEqual(["legacy-flux:refused"]);
  });

  it("reports ok on a good answer and nothing on a network-style failure", async () => {
    const ok: string[] = [];
    await service({ legacy: REAL, onCatalogOutcome: (_c, o) => { ok.push(o); } }).svc.refresh("legacy-flux");
    expect(ok).toEqual(["ok"]);
    const down: string[] = [];
    await service({ legacy: REAL, status: 503, onCatalogOutcome: (_c, o) => { down.push(o); } }).svc.refresh("legacy-flux");
    expect(down).toEqual([]);
  });
});
