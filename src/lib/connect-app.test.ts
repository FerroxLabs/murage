import { describe, expect, it } from "vitest";

import {
  CONNECT_APP_DESKTOP_ONLY,
  CONNECT_APP_NO_URL,
  connectApp,
  connectAppSettled,
  confirmedConnectLabel,
  readConnectAppStatus,
} from "./connect-app";

const WORK = confirmedConnectLabel("work")!;

/** A fetch that answers from a script, and records what it was asked. */
function fakeRequest(plan: {
  authorize?: () => any;
  statuses?: Array<any>;
}) {
  const calls: Array<{ path: string; method: string }> = [];
  let read = 0;
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: String(init?.method ?? "GET") });
    if (path.includes("/authorize")) return plan.authorize ? plan.authorize() : { url: "https://provider.example/consent" };
    const answer = plan.statuses?.[Math.min(read, (plan.statuses.length ?? 1) - 1)];
    read += 1;
    if (answer instanceof Error) throw answer;
    return answer ?? { services: {} };
  };
  return { request, calls };
}

const opened: string[] = [];
const openExternal = async (url: string) => {
  opened.push(url);
};
const noWait = async () => {};

describe("connectApp", () => {
  it("refuses anywhere but the desktop app, before it asks for anything", async () => {
    for (const desktop of [false, null] as const) {
      const { request, calls } = fakeRequest({});
      await expect(connectApp("gmail", { request, openExternal, desktop, alias: WORK, wait: noWait }))
        .rejects.toThrow(CONNECT_APP_DESKTOP_ONLY);
      expect(calls).toEqual([]);
    }
  });

  it("authorizes, opens the real browser, then polls until the account is connected", async () => {
    opened.length = 0;
    const { request, calls } = fakeRequest({
      statuses: [
        { services: { gmail: { connected: false, pending: true, status: "INITIATED", accounts: [{ alias: "work", status: "INITIATED" }] } } },
        { services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ alias: "work", status: "ACTIVE" }] } } },
      ],
    });
    const status = await connectApp("gmail", { request, openExternal, desktop: true, alias: WORK, wait: noWait });
    expect(status).toEqual({ connected: true, pending: false, status: "ACTIVE", accounts: [{ alias: "work", status: "ACTIVE" }] });
    expect(opened).toEqual(["https://provider.example/consent"]);
    expect(calls[0]).toEqual({ path: "/api/connectors/gmail/authorize", method: "POST" });
    expect(calls[1].path).toBe("/api/connectors?services=gmail");
    // It stopped as soon as it settled rather than running out the clock.
    expect(calls).toHaveLength(3);
  });

  it("gives up quietly when the person has not finished in the browser", async () => {
    const { request } = fakeRequest({
      statuses: [{ services: { gmail: { connected: false, pending: true, status: "INITIATED", accounts: [{ alias: "work", status: "INITIATED" }] } } }],
    });
    const status = await connectApp("gmail", {
      request, openExternal, desktop: true, alias: WORK, wait: noWait, attempts: 3,
    });
    // Unfinished, not failed: nothing here is allowed to call it a failure
    // over the shoulder of someone still typing a password.
    expect(status).toEqual({ connected: false, pending: true, status: "INITIATED", accounts: [{ alias: "work", status: "INITIATED" }] });
  });

  it("keeps waiting through a status read that fails", async () => {
    const { request } = fakeRequest({
      statuses: [
        new Error("network"),
        { services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ alias: "work", status: "ACTIVE" }] } } },
      ],
    });
    const status = await connectApp("gmail", { request, openExternal, desktop: true, alias: WORK, wait: noWait });
    expect(status.connected).toBe(true);
  });

  it("stops on a provider's own expiry rather than polling a dead page", async () => {
    const { request, calls } = fakeRequest({
      statuses: [{ services: { gmail: { connected: false, pending: false, status: "EXPIRED", accounts: [{ alias: "work", status: "EXPIRED" }] } } }],
    });
    const status = await connectApp("gmail", { request, openExternal, desktop: true, alias: WORK, wait: noWait });
    expect(status.status).toBe("EXPIRED");
    expect(calls).toHaveLength(2);
  });

  it("waits for the account under the confirmed label, not another account on the same app", async () => {
    // "personal" is already active on Gmail; the person confirms "work".
    const personal = { alias: "personal", status: "ACTIVE" };
    const { request, calls } = fakeRequest({
      statuses: [
        { services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [personal] } } },
        { services: { gmail: { connected: true, pending: true, status: "ACTIVE", accounts: [personal, { alias: "Work", status: "INITIATED" }] } } },
        { services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [personal, { alias: "Work", status: "ACTIVE" }] } } },
      ],
    });
    const status = await connectApp("gmail", { request, openExternal, desktop: true, alias: WORK, wait: noWait });
    expect(status.connected).toBe(true);
    expect(status.status).toBe("ACTIVE");
    // Two reads went by with "work" missing, then in flight.
    expect(calls).toHaveLength(4);

    // A "work" sign-in that never lands is never finished, whatever else is active.
    const never = fakeRequest({
      statuses: [{ services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [personal] } } }],
    });
    const unfinished = await connectApp("gmail", { request: never.request, openExternal, desktop: true, alias: WORK, wait: noWait, attempts: 3 });
    expect(unfinished.connected).toBe(false);
    expect(never.calls).toHaveLength(4);

    // A dead "work" page ends the wait as not connected, with "personal" still active.
    const dead = fakeRequest({
      statuses: [{ services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [personal, { alias: "work", status: "FAILED" }] } } }],
    });
    const failed = await connectApp("gmail", { request: dead.request, openExternal, desktop: true, alias: WORK, wait: noWait });
    expect(failed).toMatchObject({ connected: false, status: "FAILED" });
    expect(dead.calls).toHaveLength(2);
  });

  it("says so when the authorize call hands back no page to open", async () => {
    const { request } = fakeRequest({ authorize: () => ({}) });
    await expect(connectApp("gmail", { request, openExternal, desktop: true, alias: WORK, wait: noWait }))
      .rejects.toThrow(CONNECT_APP_NO_URL);
  });

  it("lets a card that has left the screen stop the poll", async () => {
    const { request, calls } = fakeRequest({
      statuses: [{ services: { gmail: { connected: false, pending: true } } }],
    });
    const status = await connectApp("gmail", {
      request, openExternal, desktop: true, alias: WORK, wait: noWait, cancelled: () => true,
    });
    expect(status).toEqual({ connected: false, pending: true, status: "INITIATED" });
    expect(calls).toHaveLength(1);
  });

  it("escapes a slug rather than pasting it into a path", async () => {
    const { request, calls } = fakeRequest({ statuses: [{ services: {} }] });
    await connectApp("we ird/slug", { request, openExternal, desktop: true, alias: WORK, wait: noWait, attempts: 1 });
    expect(calls[0].path).toBe("/api/connectors/we%20ird%2Fslug/authorize");
    expect(calls[1].path).toBe("/api/connectors?services=we%20ird%2Fslug");
  });
});

describe("connectAppSettled", () => {
  it("waits on anything still in flight", () => {
    expect(connectAppSettled(undefined)).toBe(false);
    expect(connectAppSettled({ connected: false })).toBe(false);
    expect(connectAppSettled({ connected: false, pending: true, status: "INITIATED" })).toBe(false);
    // Connected AND still pending is the half-written state the dialog waits
    // through; treating it as done shows a tick before the account works.
    expect(connectAppSettled({ connected: true, pending: true })).toBe(false);
  });

  it("stops on a finished account or a dead page", () => {
    expect(connectAppSettled({ connected: true, pending: false })).toBe(true);
    expect(connectAppSettled({ connected: true })).toBe(true);
    expect(connectAppSettled({ connected: false, status: "expired" })).toBe(true);
    expect(connectAppSettled({ connected: false, status: "FAILED" })).toBe(true);
  });
});

describe("readConnectAppStatus", () => {
  it("answers undefined rather than throwing when the read fails", async () => {
    const thrown = async () => { throw new Error("offline"); };
    expect(await readConnectAppStatus("gmail", thrown)).toBeUndefined();
    const empty = async () => ({ services: {} });
    expect(await readConnectAppStatus("gmail", empty)).toBeUndefined();
  });

  it("keeps only the three fields the caller decides on", async () => {
    const request = async () => ({
      services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "a" }] } },
    });
    expect(await readConnectAppStatus("gmail", request)).toEqual({ connected: true, pending: false, status: "ACTIVE" });
  });
});
