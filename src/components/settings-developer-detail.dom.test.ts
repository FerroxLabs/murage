// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 Settings pass, Computer & browser: a person who never opens a terminal sees what to do in plain words. The
// commands (brew install podman ...), the pinned image references (name@sha256:...), the Linux capability paragraph and
// the SSH config alias are all still there, inside a closed "details" the person opens on purpose.
import { createElement as h } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";

const fixture = vi.hoisted(() => ({ state: { config: { vps: { configured: false, sshAlias: "" } } } as any, dispatch: () => {}, status: {} as any }));
vi.mock("@/state/store", async original => ({ ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: vi.fn(async () => fixture.status),
}));
import { LocalComputerSection } from "./LocalComputerSection";
import { VpsConnection } from "./ApiKeys";

const DIGEST = "ghcr.io/fixture/cua-desktop@sha256:" + "a".repeat(64);
const status = (over: Record<string, unknown> = {}) => ({
  // Nothing set up yet, so every step is open: the install, download and create commands all have a place to show.
  platform: "darwin", runtime: null, available: [], daemonUp: false, image: false, imageMatches: false, managed: true,
  container: "missing", network: "loopback", security: "hardened", persistence: "durable", desktopReady: false, ready: false, problem: null,
  image_ref: DIGEST, base_image_ref: DIGEST, driver_version: "0.0.0-fixture", container_name: "murage-fixture", workspace_path: "/tmp/fixture-ws",
  workspace_guest_path: "/home/cua/workspace", idle_timeout_ms: 1, mode: "shared", max_instances: 2,
  commands: { install: "brew install podman; podman machine init; podman machine start", runtimeStart: "podman machine init; podman machine start",
    pull: `podman pull ${DIGEST}`, run: `podman run -d ${DIGEST}`, start: null, stop: null, remove: null, view: "" },
  ...over,
});

const shownText = () => document.body.textContent ?? "";
const toggles = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-developer-detail] > button"));
async function openAll() { for (const button of toggles()) if (button.getAttribute("aria-expanded") !== "true") button.click(); await settle(); }
const DEVELOPER_TEXT = ["brew install podman", "podman machine start", "@sha256:", "Linux capabilities", "SSH config alias"];

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });

describe("Computer & browser keeps developer text behind a closed detail", () => {
  it.each(["shared", "per-bot"])("Local VM (%s): commands, image digest and capability limits only after Details for developers", async mode => {
    fixture.status = status({ mode });
    mount(h(LocalComputerSection));
    // The download and create commands come from the loaded status, so their details appearing means it has loaded.
    for (let i = 0; i < 20 && toggles().length < 4; i++) await settle();
    expect(shownText()).toContain("Open the Podman installation guide");
    const shown = shownText();
    for (const text of DEVELOPER_TEXT) expect(shown, text).not.toContain(text);
    expect(shown).not.toContain("dropped-capability");
    expect(shown).toContain("Details for developers");
    expect(shown).toContain("Open the Podman installation guide");
    // Install, base-image download, create, and the protection limits.
    expect(toggles().length).toBe(4);
    for (const button of toggles()) expect(button.getAttribute("aria-expanded")).toBe("false");
    // Nothing was removed: it is all there for whoever opens it.
    await act(openAll);
    const opened = shownText();
    expect(opened).toContain("brew install podman");
    expect(opened).toContain("@sha256:");
    expect(opened).toContain(`podman run -d ${DIGEST}`);
    expect(opened).toContain(mode === "shared" ? "Linux capabilities" : "dropped-capability");
  });

  it("Self-hosted VPS: the SSH alias field and wording stay closed until a server is saved, then show", async () => {
    fixture.state = { config: { vps: { configured: false, sshAlias: "" } } };
    let app = mount(h(VpsConnection));
    await settle();
    expect(shownText()).toContain("Self-hosted VPS");
    expect(shownText()).not.toContain("SSH config alias");
    expect(document.querySelector('input[aria-label="Self-hosted VPS SSH config alias"]')).toBeNull();
    await act(openAll);
    expect(shownText()).toContain("SSH config alias");
    app.unmount(); document.body.replaceChildren();
    fixture.state = { config: { vps: { configured: true, sshAlias: "fixture-host" } } };
    app = mount(h(VpsConnection));
    await settle();
    expect(shownText()).toContain("SSH config alias");
    app.unmount();
  });
});
