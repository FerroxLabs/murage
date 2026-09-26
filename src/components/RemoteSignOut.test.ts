import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemoteSignOut, RemoteSignOutCard } from "./RemoteSignOut";
import { doorSessionConfirmed } from "../lib/session-check";

const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");

describe("the remote sign-out control", () => {
  it("starts as one clearly named button that does nothing until confirmed", () => {
    const html = renderToStaticMarkup(createElement(RemoteSignOutCard));
    expect(html).toContain("Sign out this device");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("Signing out");
  });

  // M9: a plain browser on the harness's port is remote too, but has no door.
  it("renders nothing until the door has answered for this device", () => {
    expect(renderToStaticMarkup(createElement(RemoteSignOut))).toBe("");
  });

  it("trusts only the door's own answer, not the harness's SPA shell", async () => {
    const answer = (status: number, type: string, body: unknown) => async () => ({
      status,
      headers: new Headers({ "content-type": type }),
      json: async () => body,
    });
    expect(await doorSessionConfirmed(answer(200, "application/json; charset=utf-8", { device: { name: "Pixel" }, expiresAt: 1 }))).toBe(true);
    // localhost:8799 with no door: GET /session is the SPA fallback
    expect(await doorSessionConfirmed(answer(200, "text/html", null))).toBe(false);
    expect(await doorSessionConfirmed(answer(200, "application/json", { ok: true }))).toBe(false);
    expect(await doorSessionConfirmed(answer(401, "application/json", { error: "sign in" }))).toBe(false);
    expect(await doorSessionConfirmed(answer(404, "application/json", { error: "no such route" }))).toBe(false);
    expect(await doorSessionConfirmed(async () => { throw new TypeError("offline"); })).toBe(false);
  });

  it("appears only on a confirmed remote surface, in General", () => {
    const general = settings.slice(settings.indexOf('{section === "general" && ('), settings.indexOf('{desktop === true && section === "backups"'));
    expect(general).toContain("{desktop === false && <RemoteSignOut />}");
  });
});
