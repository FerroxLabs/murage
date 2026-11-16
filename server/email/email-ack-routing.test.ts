// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Private-port routing owner: email-ack. Cloud saver predicate owner: Cloud team.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createCloudEmailSaver } from "../cloud-home/email-keystore-server.ts";
import { applyEmailShellMessage, EmailSecretStore, isCloudEmailOwnerMessage, isEmailShellMessage, type EmailSecretsSaveMeta } from "./email-secrets.ts";

// Execute the actual production callback, including its ordering and early returns.
// Only unrelated private-port services are inert; both email handlers are real.
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const start = source.indexOf("const onUtilityParentMessage = ");
const end = source.indexOf('\nutilityParentPort?.on("message", onUtilityParentMessage);', start);
if (start < 0 || end < 0) throw new Error("Private parent handler anchor missing");
const callback = ts.transpileModule(source.slice(start, end) + "\nreturn onUtilityParentMessage;", { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;

function chain(cloudEmailStore: boolean, epoch = 100, pendingCloudSave = true) {
  const earlyEmailShellMessages: unknown[] = [];
  const saves: EmailSecretsSaveMeta[] = [];
  const desktop = new EmailSecretStore((_doc, meta) => { saves.push(meta); return true; });
  const desktopAck = vi.spyOn(desktop, "ack");
  const onSaved = vi.fn();
  const cloud = createCloudEmailSaver(3, () => epoch, { onSaved });
  const cloudAck = vi.spyOn(cloud, "ack");
  const sink = vi.fn((message: unknown) => applyEmailShellMessage(desktop, message));
  const bindings = { cloudHome: cloudEmailStore, cloudEmailStore, cloudEmailSaver: cloud, cloudEmailAvailability: { receive: () => false }, cloudEmailSignin: undefined, emailShellSink: sink, earlyEmailShellMessages, isCloudEmailOwnerMessage, isEmailShellMessage };
  const receive = new Function(...Object.keys(bindings), callback)(...Object.values(bindings)) as (event: { data: object }) => void;
  desktop.setBotKey("fixture", { token: "fixture-value", keyId: "key_desktop" });
  const save = pendingCloudSave ? cloud.message({ bots: { fixture: { token: "fixture-value", keyId: "key_cloud", label: "bot-email:fixture" } } }) : { epoch, gen: 3, rev: 1 };
  return { desktop, desktopAck, cloud, cloudAck, onSaved, sink, saves, save, receive: (data: object) => receive({ data }) };
}
const saved = (meta: object, keyIds = ["key_cloud"]) => ({ ...meta, type: "murage:email-secrets-saved", keyIds });

describe("email acknowledgements through onUtilityParentMessage", () => {
  it("desktop bypasses the inactive Cloud backend and a replay cannot confirm a later key", () => {
    const h = chain(false);
    const ack = saved(h.saves[0]!, ["key_desktop"]);
    h.receive(ack);
    expect(h.desktop.isDurable("key_desktop")).toBe(true);
    expect(h.cloudAck).not.toHaveBeenCalled();
    expect(h.desktopAck).toHaveBeenCalledTimes(1);
    expect(h.onSaved).not.toHaveBeenCalled();
    h.desktop.setBotKey("next", { token: "fixture-value", keyId: "key_next" });
    h.receive(ack);
    expect(h.desktop.isDurable("key_desktop")).toBe(true);
    expect(h.desktop.isDurable("key_next")).toBe(false);
    h.receive(saved(h.saves[1]!, ["key_desktop", "key_next"]));
    expect(h.desktop.isDurable("key_next")).toBe(true);
    expect(h.cloudAck).not.toHaveBeenCalled();
  });

  it("with both savers present, each acknowledgement reaches only its owner and Cloud applies once", async () => {
    const h = chain(true);
    expect(h.desktop.isDurable("key_desktop")).toBe(false);
    expect(h.cloud.saved()).toBe(false);
    h.receive(saved(h.saves[0]!, ["key_desktop"]));
    expect(h.desktop.isDurable("key_desktop")).toBe(true);
    expect(h.cloud.saved()).toBe(false);
    expect(h.onSaved).not.toHaveBeenCalled();
    const wait = h.cloud.wait(1000);
    h.receive(saved(h.save));
    expect(await wait).toBe(true);
    expect(h.onSaved).toHaveBeenCalledTimes(1);
    expect(h.desktopAck).toHaveBeenCalledTimes(1);
    h.receive(saved(h.save));
    expect(h.onSaved).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale epoch", { epoch: 99 }], ["foreign generation", { gen: 4 }],
    ["absent generation", { gen: undefined }], ["string epoch", { epoch: "100" }],
    ["future revision", { rev: 2 }], ["zero revision", { rev: 0 }],
    ["malformed read-back", { keyIds: [1] }],
  ])("%s completes neither saver and is offered to the desktop", (_name, patch) => {
    const h = chain(true);
    h.receive({ ...saved(h.save, ["key_cloud", "key_desktop"]), ...patch });
    expect(h.cloud.saved()).toBe(false);
    expect(h.desktop.isDurable("key_desktop")).toBe(false);
    expect(h.onSaved).not.toHaveBeenCalled();
    expect(h.sink).toHaveBeenCalledTimes(1);
  });

  it("an acknowledgement cannot own a save that was never pending", () => {
    const h = chain(true, 200, false);
    h.receive(saved(h.save));
    expect(h.desktop.isDurable("key_desktop")).toBe(false);
    expect(h.onSaved).not.toHaveBeenCalled();
    expect(h.sink).toHaveBeenCalledTimes(1);
  });

  it("restart with pending keys fences acknowledgements from the old desktop and Cloud runs", () => {
    const old = chain(true, 100), next = chain(true, 101);
    next.receive(saved(old.saves[0]!, ["key_desktop"]));
    next.receive(saved(old.save));
    expect(next.desktop.isDurable("key_desktop")).toBe(false);
    expect(next.cloud.saved()).toBe(false);
    expect(next.onSaved).not.toHaveBeenCalled();
    next.receive(saved(next.saves[0]!, ["key_desktop"]));
    next.receive(saved(next.save));
    expect(next.desktop.isDurable("key_desktop")).toBe(true);
    expect(next.cloud.saved()).toBe(true);
    expect(next.onSaved).toHaveBeenCalledTimes(1);
  });

  it("replaying a completed Cloud revision cannot complete a later pending save", () => {
    const h = chain(true);
    h.receive(saved(h.save));
    const next = h.cloud.message({ bots: { next: { token: "fixture-value", keyId: "key_next", label: "bot-email:next" } } });
    h.receive(saved(h.save));
    expect(h.cloud.saved()).toBe(false);
    expect(h.desktop.isDurable("key_desktop")).toBe(false);
    expect(h.onSaved).toHaveBeenCalledTimes(1);
    h.receive(saved(next, ["key_next"]));
    expect(h.cloud.saved()).toBe(true);
    expect(h.onSaved).toHaveBeenCalledTimes(2);
  });
});
