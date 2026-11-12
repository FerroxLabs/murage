// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { answerDelegationPackRoute, type DelegationPackRouteHost } from "./delegation-pack-routes.ts";
import type { DelegationPack } from "./delegation-pack/types.ts";

function fixture() {
  const pack: DelegationPack = { id: "pack", delegation_id: "job", source_thread_id: "source", source_bot_id: "sable", target_bot_id: "ember", destination_thread_id: "target", refs: ["line", "unprepared"], prepared: ["line"], cut_at: 1, created_at: 1 };
  const host = {
    isOwnerRequest: vi.fn(() => true),
    getPack: vi.fn(() => pack),
    forgottenIds: vi.fn(() => new Set<string>()),
    readOwnerRow: vi.fn((threadId: string, id: string) => ({ id, threadId, author: "Sable", text: "Book The Garden" })),
  } satisfies DelegationPackRouteHost;
  const request = { method: "GET", path: "/api/delegation-packs/pack" };
  return { host, pack, request, read: () => answerDelegationPackRoute(request, host) };
}

describe("delegation pack owner sheet route", () => {
  it("owner-only: kills missing caller gate", () => {
    const f = fixture();
    expect(f.read().status).toBe(200);
    f.host.getPack.mockClear(); f.host.readOwnerRow.mockClear();
    f.host.isOwnerRequest.mockReturnValue(false);
    expect(f.read()).toMatchObject({ status: 404 });
    expect(f.read().body).toBeUndefined();
    expect(f.host.getPack).not.toHaveBeenCalled();
    expect(f.host.readOwnerRow).not.toHaveBeenCalled();
  });

  it("T-PREPARED: selects prepared, never refs; kills candidate sheet", () => {
    const f = fixture();
    expect(f.read().body).toEqual({ rows: [{ id: "line", state: "text", author: "Sable", text: "Book The Garden" }] });
    expect(f.host.readOwnerRow).toHaveBeenCalledExactlyOnceWith("source", "line");
    f.host.getPack.mockReturnValue({ ...f.pack, prepared: [] });
    f.host.readOwnerRow.mockClear();
    expect(f.read().body).toEqual({ rows: [] });
    expect(f.host.readOwnerRow).not.toHaveBeenCalled();
  });

  it("T-FORGET-SCOPED: rechecks current forget without reading forgotten text; kills cached words", () => {
    const f = fixture();
    expect(JSON.stringify(f.read().body)).toContain("Book The Garden");
    f.host.forgottenIds.mockReturnValue(new Set(["line"]));
    f.host.readOwnerRow.mockClear();
    expect(f.read().body).toEqual({ rows: [{ id: "line", state: "forgotten" }] });
    expect(f.host.readOwnerRow).not.toHaveBeenCalled();
    expect(f.read().headers).toEqual({ "Cache-Control": "no-store" });
  });

  it("T-FORGET-UNKNOWN: withholds when forget cannot be checked; kills fail-open", () => {
    const f = fixture();
    expect(f.read().status).toBe(200);
    f.host.forgottenIds.mockImplementation(() => { throw new Error("private details"); });
    f.host.readOwnerRow.mockClear();
    expect(f.read()).toMatchObject({ status: 503 });
    expect(JSON.stringify(f.read())).not.toContain("private details");
    expect(f.host.readOwnerRow).not.toHaveBeenCalled();
  });

  it("binds each row to its source thread; kills id-only lookup", () => {
    const f = fixture();
    expect(JSON.stringify(f.read().body)).toContain("Book The Garden");
    f.host.readOwnerRow.mockReturnValue({ id: "line", threadId: "another", author: "Sable", text: "Book The Garden" });
    expect(f.read().body).toEqual({ rows: [{ id: "line", state: "unavailable" }] });
  });

  it("T-FORGET-SCOPED: honors the row's forget stamp too; kills stamp bypass", () => {
    const f = fixture();
    const row = { id: "line", threadId: "source", author: "Sable", text: "Book The Garden", withheldFromBots: "forgotten" };
    expect(JSON.stringify(f.read().body)).toContain(row.text);
    f.host.readOwnerRow.mockReturnValue(row);
    expect(f.read().body).toEqual({ rows: [{ id: "line", state: "forgotten" }] });
  });

  it("a removed pack has no sheet body; kills stale pack fallback", () => {
    const f = fixture();
    expect(f.read().status).toBe(200);
    const host: DelegationPackRouteHost = { ...f.host, getPack: () => undefined };
    expect(answerDelegationPackRoute(f.request, host)).toEqual({ status: 404, headers: { "Cache-Control": "no-store" } });
  });

  it.each([
    { method: "POST", path: "/api/delegation-packs/pack" },
    { method: "GET", path: "/api/delegation-packs/pack/extra" },
    { method: "GET", path: "/api/delegation-packs/%2e%2e" },
  ])("only serves the declared GET route: %j; kills route widening", request => {
    const f = fixture();
    expect(f.read().status).toBe(200);
    f.host.getPack.mockClear();
    expect(answerDelegationPackRoute(request, f.host).status).toBe(404);
    expect(f.host.getPack).not.toHaveBeenCalled();
  });
});
