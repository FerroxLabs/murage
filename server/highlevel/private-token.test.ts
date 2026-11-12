// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnQuiet, isOwnUnasked, OWN_BUILTINS } from "../../shared/own-servers.ts";
import { HIGHLEVEL_HELPER_NAMES, HIGHLEVEL_FAMILY_TOOLS, HIGHLEVEL_WRITE_TOOLS } from "../../shared/highlevel.ts";
import { buildMcpServers, piMountRecords } from "../drivers/mcp-mounts.ts";
import type { SendTurnInput } from "../contracts.ts";
import { HIGHLEVEL_CHECK_HOLD_MS, PrivateTokenLeaseSource, highlevelTokenFingerprint } from "./private-token.ts";

const TOKEN = "pit-TEST-0000-not-a-real-token";

function setup(options: { status?: number; body?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hl-pit-"));
  const file = join(dir, "highlevel", "connection.json");
  let token: string | undefined = TOKEN;
  let now = 1_000_000;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(options.body ?? { location: { id: "Loc12345", name: "Main Street Dental", companyId: "Comp1" } }), { status: options.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const source = new PrivateTokenLeaseSource({ token: () => token, file, fetch: fetchImpl, now: () => now });
  return { source, file, requests, setToken: (next: string | undefined) => { token = next; }, advance: (ms: number) => { now += ms; } };
}

describe("HighLevel Private Integration token source (HL-S2)", () => {
  it("publishes only the scope proved by the location check, ignoring response scope claims", async () => {
    const { source, setToken } = setup({ body: { scopes: ["contacts.write"], location: { id: "Loc12345", scopes: ["contacts.write"] } } });
    const check = await source.check("Loc12345");
    expect(check).toMatchObject({ scopes: ["locations.readonly"] });
    source.confirm(check.opId);
    expect(source.ownerView()).toMatchObject({ scopes: ["locations.readonly"] });
    expect(await source.connection("hl_Loc12345")).toMatchObject({ scopes: ["locations.readonly"] });
    setToken("pit-TEST-swapped");
    expect(source.ownerView()).toMatchObject({ scopes: [] });
    expect(await source.connection("hl_Loc12345")).toMatchObject({ scopes: [] });
  });

  it("is not connected until the owner checks and then confirms a location", async () => {
    const { source, requests } = setup();
    expect(await source.connection("hl_Loc12345")).toBeUndefined();
    const check = await source.check("Loc12345");
    expect(check.locationName).toBe("Main Street Dental");
    // the check alone connects nothing
    expect(await source.connection("hl_Loc12345")).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://services.leadconnectorhq.com/locations/Loc12345");
    expect(requests[0]!.init.redirect).toBe("error");
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const confirmed = source.confirm(check.opId);
    expect(confirmed).toMatchObject({ connectionId: "hl_Loc12345", state: "connected", locationName: "Main Street Dental" });
    expect(await source.connection("hl_Loc12345")).toMatchObject({ state: "connected", epoch: 1, companyId: "Comp1" });
  });

  it("never writes the token to the connection record or returns it to the owner view", async () => {
    const { source, file } = setup();
    source.confirm((await source.check("Loc12345")).opId);
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(highlevelTokenFingerprint(TOKEN));
    expect(JSON.stringify(source.ownerView())).not.toContain(TOKEN);
    expect(JSON.stringify(source.ownerView())).not.toContain(highlevelTokenFingerprint(TOKEN));
  });

  it("leases the token only for the confirmed connection and epoch", async () => {
    const { source } = setup();
    source.confirm((await source.check("Loc12345")).opId);
    const lease = await source.lease({ requestId: "r1", connectionId: "hl_Loc12345", connectionEpoch: 1, reason: "use" });
    expect(lease.accessToken).toBe(TOKEN);
    expect(lease.locationId).toBe("Loc12345");
    await expect(source.lease({ requestId: "r2", connectionId: "hl_Loc12345", connectionEpoch: 2, reason: "use" })).rejects.toThrow(/not connected/);
    await expect(source.lease({ requestId: "r3", connectionId: "hl_Other999", connectionEpoch: 1, reason: "use" })).rejects.toThrow(/not connected/);
    await expect(source.lease({ requestId: "r4", connectionId: "hl_Loc12345", connectionEpoch: 1, reason: "expired" })).rejects.toThrow(/did not accept/);
  });

  it("a new or cleared token puts the location back to waiting for a fresh check and confirm", async () => {
    const { source, setToken } = setup();
    source.confirm((await source.check("Loc12345")).opId);
    setToken("pit-TEST-another-token");
    expect((await source.connection("hl_Loc12345"))?.state).toBe("pending_browser_confirmation");
    await expect(source.lease({ requestId: "r1", connectionId: "hl_Loc12345", connectionEpoch: 1, reason: "use" })).rejects.toThrow(/token changed/);
    setToken(undefined);
    expect((await source.connection("hl_Loc12345"))?.state).toBe("pending_browser_confirmation");
    setToken("pit-TEST-another-token");
    source.confirm((await source.check("Loc12345")).opId);
    expect(await source.connection("hl_Loc12345")).toMatchObject({ state: "connected", epoch: 2 });
  });

  it("refuses a confirm after the hold, after a token change, or twice", async () => {
    const { source, advance, setToken } = setup();
    const late = await source.check("Loc12345");
    advance(HIGHLEVEL_CHECK_HOLD_MS + 1);
    expect(() => source.confirm(late.opId)).toThrow(/expired/);
    const changed = await source.check("Loc12345");
    setToken("pit-TEST-swapped");
    expect(() => source.confirm(changed.opId)).toThrow(/changed/);
    setToken(TOKEN);
    const once = await source.check("Loc12345");
    source.confirm(once.opId);
    expect(() => source.confirm(once.opId)).toThrow(/expired/);
  });

  it("refuses a bad id, a missing token, a rejected token and an answer for another location", async () => {
    await expect(setup().source.check("../x")).rejects.toThrow(/location id/);
    const noToken = setup();
    noToken.setToken("");
    await expect(noToken.source.check("Loc12345")).rejects.toThrow(/Save a HighLevel/);
    await expect(setup({ status: 401 }).source.check("Loc12345")).rejects.toThrow(/did not accept/);
    await expect(setup({ body: { location: { id: "Different1" } } }).source.check("Loc12345")).rejects.toThrow(/different location/);
  });

  it("after a disconnect nothing is connected or leasable, and the next confirm gets a higher epoch", async () => {
    const { source } = setup();
    source.confirm((await source.check("Loc12345")).opId);
    expect((await source.connection("hl_Loc12345"))?.epoch).toBe(1);
    expect(source.disconnect("hl_Loc12345")).toBe(true);
    expect(source.record()).toBeUndefined();
    expect(await source.connection("hl_Loc12345")).toBeUndefined();
    await expect(source.lease({ requestId: "r1", connectionId: "hl_Loc12345", connectionEpoch: 1, reason: "use" })).rejects.toThrow(/not connected/);
    expect(source.disconnect("hl_Loc12345")).toBe(false);
    source.confirm((await source.check("Loc12345")).opId);
    expect((await source.connection("hl_Loc12345"))?.epoch).toBe(2);
  });
});

describe("native HighLevel mount (HL-S2 ruling 1)", () => {
  it("family tools reach the host without an engine card; legacy change names stay unavailable", () => {
    expect(OWN_BUILTINS.highlevel).toBe("highlevel");
    for (const tool of [...Object.values(HIGHLEVEL_FAMILY_TOOLS), ...HIGHLEVEL_HELPER_NAMES]) {
      expect(isOwnUnasked("own:highlevel", tool)).toBe(true);
      expect(isOwnQuiet("own:highlevel", tool)).toBe(true);
    }
    for (const tool of HIGHLEVEL_WRITE_TOOLS) {
      expect(isOwnUnasked("own:highlevel", tool)).toBe(false);
      expect(isOwnQuiet("own:highlevel", tool)).toBe(false);
    }
    expect(isOwnQuiet("own:highlevel", "HIGHLEVEL_DELETE_CONTACT")).toBe(false);
  });

  it("only a turn that mounts native HighLevel owns the name; an owner's own server called highlevel stays custom and asks", () => {
    const custom = { custom: { highlevel: { command: "node", args: ["their-server.js"], env: {} } } } as unknown as SendTurnInput["integrations"];
    const without = { integrations: custom } as SendTurnInput;
    const withoutServers = buildMcpServers(without);
    expect(piMountRecords(without, withoutServers).find((record) => record.engineName === "highlevel")).toMatchObject({ mountId: "custom:highlevel", provenance: "custom" });
    const native = { integrations: { ...custom, highlevel: { command: "node", args: ["highlevel-proxy.js"], env: { MURAGE_CONTROL_TOKEN: "t" } } } } as unknown as SendTurnInput;
    const nativeServers = buildMcpServers(native);
    expect((nativeServers as Record<string, { args: string[] }>).highlevel.args).toEqual(["highlevel-proxy.js"]);
    expect(piMountRecords(native, nativeServers).find((record) => record.engineName === "highlevel")).toMatchObject({ mountId: "own:highlevel", provenance: "own" });
  });
});
