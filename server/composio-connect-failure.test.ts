// Starting a sign-in again with a label whose last attempt died (0.1.62, Bug 1).
// The broker counts a FAILED or EXPIRED attempt as a label in use, so "Try
// again" with the same label failed with "already in use". The dead attempt is
// cleared and the label tried once more; a live account's label is never touched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyManagedBrokerMessage, authorizeService, primeBrokerReadiness, resetManagedBrokerState } from "./composio.ts";
import type { AppConfig } from "./config.ts";

const TOKEN = "e".repeat(64);
const BASE = "https://flux.example.test/composio";
const cfg = (): AppConfig => ({}) as AppConfig;

let accounts: Array<{ id: string; alias?: string; status: string }> = [];
let log: string[] = [];

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace("/composio", "");
    const method = init?.method ?? "GET";
    log.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/health") return json(200, { ready: true });
    if (path === "/v1/connectors/connected") return json(200, { services: { slack: { connected: false, status: "EXPIRED", accounts } } });
    if (method === "DELETE" && path.startsWith("/v1/connectors/slack/accounts/")) {
      const id = path.split("/").pop();
      accounts = accounts.filter((account) => account.id !== id);
      return json(200, { removed: 1 });
    }
    if (method === "POST" && path === "/v1/connectors/slack/authorize") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { alias?: string };
      if (accounts.some((account) => account.alias === body.alias)) {
        return json(409, { error: `Account alias "${body.alias}" is already in use for slack` });
      }
      return json(200, { url: "https://connect.composio.dev/link/slack" });
    }
    return json(404, {});
  }));
}

beforeEach(async () => {
  accounts = [];
  log = [];
  resetManagedBrokerState();
  stub();
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: BASE,
    fluxAccess: { url: BASE, token: TOKEN },
    legacyUntil: "",
    legacyClaim: { state: "claimed" },
    accountKind: null,
    tokenError: null,
  });
  await primeBrokerReadiness();
  log = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetManagedBrokerState();
});

describe("trying again with the label of a dead attempt", () => {
  it("clears the expired attempt and starts the sign-in again", async () => {
    accounts = [{ id: "ca_dead", alias: "work", status: "EXPIRED" }];
    await expect(authorizeService(cfg(), "slack", "work")).resolves.toEqual({ url: "https://connect.composio.dev/link/slack" });
    expect(log.filter((line) => line.startsWith("POST /v1/connectors/slack/authorize"))).toHaveLength(2);
    expect(log.filter((line) => line.startsWith("DELETE"))).toEqual(["DELETE /v1/connectors/slack/accounts/ca_dead"]);
  });

  it("never touches an account that is still live", async () => {
    accounts = [{ id: "ca_live", alias: "work", status: "ACTIVE" }];
    await expect(authorizeService(cfg(), "slack", "work")).rejects.toThrow(/already in use/);
    expect(log.filter((line) => line.startsWith("DELETE"))).toEqual([]);
  });

  it("review F10: never deletes a disabled connection that carries the label", async () => {
    accounts = [{ id: "ca_off", alias: "work", status: "INACTIVE" }];
    await expect(authorizeService(cfg(), "slack", "work")).rejects.toThrow(/already in use/);
    expect(log.filter((line) => line.startsWith("DELETE"))).toEqual([]);
  });

  it("tries the label only once more, so a stubborn broker cannot loop", async () => {
    accounts = [{ id: "ca_dead", alias: "work", status: "FAILED" }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.replace("/composio", "");
      log.push(`${init?.method ?? "GET"} ${path}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (path === "/health") return json(200, { ready: true });
      if (path === "/v1/connectors/connected") return json(200, { services: { slack: { connected: false, status: "FAILED", accounts: [{ id: "ca_dead", alias: "work", status: "FAILED" }] } } });
      if (init?.method === "DELETE") return json(200, { removed: 1 });
      return json(409, { error: 'Account alias "work" is already in use for slack' });
    }));
    await expect(authorizeService(cfg(), "slack", "work")).rejects.toThrow(/already in use/);
    expect(log.filter((line) => line.startsWith("POST /v1/connectors/slack/authorize"))).toHaveLength(2);
  });
});
