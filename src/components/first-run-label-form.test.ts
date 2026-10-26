// The first-run cards connect an app the way Connected apps does (#758):
// Connect opens the label form, filled in with a label, and the sign-in
// starts only from the confirmed label. Nothing authorizes without one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

const connectAppModule = await import("@/lib/connect-app");
const { connectApp, CONNECT_APP_DEFAULT_LABEL, CONNECT_APP_NEEDS_LABEL } = connectAppModule as typeof connectAppModule & {
  CONNECT_APP_DEFAULT_LABEL: string;
  CONNECT_APP_NEEDS_LABEL: string;
};
const { FirstRunConnectView } = await import("./FirstRunJobsCard");

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

function recorder() {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: String(init?.method ?? "GET"), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (path.includes("/authorize")) return { url: "https://provider.example/consent" };
    return { services: { gmail: { connected: true, pending: false, status: "ACTIVE" } } };
  };
  return { request, calls };
}
const openExternal = async () => {};
const noWait = async () => {};

describe("connectApp asks for a confirmed label", () => {
  it("refuses with no label, or an empty one, before any request", async () => {
    for (const alias of [undefined, "", "   "]) {
      const { request, calls } = recorder();
      await expect(connectApp("gmail", { request, openExternal, desktop: true, wait: noWait, alias } as never))
        .rejects.toThrow(CONNECT_APP_NEEDS_LABEL);
      expect(calls, `alias ${JSON.stringify(alias)}`).toEqual([]);
    }
  });

  it("authorizes under the confirmed label, trimmed", async () => {
    const { request, calls } = recorder();
    await connectApp("gmail", { request, openExternal, desktop: true, wait: noWait, alias: "  work  " } as never);
    expect(calls[0]).toEqual({ path: "/api/connectors/gmail/authorize", method: "POST", body: JSON.stringify({ alias: "work" }) });
  });
});

describe("first-run connect screen", () => {
  const screen = {
    heading: "One thing first",
    lead: "Connect it and I can start.",
    rows: [
      { need: "gmail" as const, bold: "Gmail", small: "so I can read your mail" },
      { need: "flux" as const, bold: "Flux Router", small: "so I can think" },
    ],
    skipToInput: null,
    elsewhere: "Something else",
    appsUnreadable: false,
  };
  const noop = () => {};
  const render = (labelling: string) =>
    renderToStaticMarkup(createElement(FirstRunConnectView, {
      screen, busy: "", failure: "", desktop: true, onConnect: noop, onSkipToInput: noop, onElsewhere: noop,
      labelling, onConfirmLabel: noop, onCancelLabel: noop,
    } as never));

  it("opens the label form for the app, filled in with a label to confirm", () => {
    expect(CONNECT_APP_DEFAULT_LABEL).toBeTruthy();
    const markup = render("gmail");
    expect(markup).toContain('data-connect-label-form="gmail"');
    expect(markup).toContain(`value="${CONNECT_APP_DEFAULT_LABEL}"`);
    expect(markup).toContain(">Continue</button>");
    expect(markup).toContain('aria-label="Label for the new Gmail account"');
  });

  it("shows no form until Connect is pressed", () => {
    expect(render("")).not.toContain("data-connect-label-form");
  });
});

describe("the first-run cards start a sign-in only from the label form", () => {
  for (const file of ["./FirstRunJobsCard.tsx", "./FirstRunAppsCard.tsx"]) {
    it(file, () => {
      const text = source(file);
      // Every connectApp call carries the confirmed label.
      const calls = [...text.matchAll(/connectApp\([^)]*?\{([\s\S]*?)\}\)/g)];
      expect(calls.length, "no connectApp call found").toBeGreaterThan(0);
      for (const call of calls) expect(call[1]).toMatch(/^\s*alias,\s*$/m);
      // The form is what hands it over, filled in with the default label.
      expect(text).toContain("<ConnectLabelForm");
      // Filled in with the first label no account on the app holds yet.
      expect(text).toMatch(/initial=\{[^}]*firstFreeConnectLabel\(/);
    });
  }

  it("the apps card's Connect button opens the form and starts nothing", () => {
    const text = source("./FirstRunAppsCard.tsx");
    expect(text).toContain("onClick={() => askLabel(row.slug)}");
    const askLabel = text.slice(text.indexOf("const askLabel"), text.indexOf("const connect ="));
    expect(askLabel).not.toMatch(/connectApp|\/authorize/);
  });

  it("the jobs card's Connect opens the form and starts nothing", () => {
    const text = source("./FirstRunJobsCard.tsx");
    const connect = text.slice(text.indexOf("const connect = async (need: FirstRunJobNeed)"), text.indexOf("const confirmLabel"));
    expect(connect).toContain("setLabelling(");
    expect(connect).not.toMatch(/connectApp|\/authorize/);
  });

  it("follows the copy rules", () => {
    const text = source("./ConnectLabelForm.tsx");
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\b(un)?safe(ty)?\b/i);
    expect(text).not.toMatch(/composio/i);
  });
});
