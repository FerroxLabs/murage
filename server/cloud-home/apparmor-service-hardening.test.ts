// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit GLM-1 / GLM-8: explicit AppArmor denies for the sandboxed payloads and
// filesystem hardening for the home unit that stays compatible with setuid sudo.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const text = (name: string) => readFileSync(fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url)), "utf8");
const section = (source: string, start: string) => { const i = source.indexOf(start); expect(i).toBeGreaterThan(-1); const j = source.indexOf("\n}\n", i); return source.slice(i, j); };
const denies = (body: string) => body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("deny "));

it("turn payload profile denies host state, secrets and writes to code, but not workspaces or engine homes", () => {
  const file = text("bwrap.apparmor");
  const payload = denies(section(file, "profile unpriv_bwrap"));
  for (const rule of ["deny /data/browser/{,**} rwklmx,", "deny /data/proxy/{,**} rwklmx,", "deny /etc/murage-home/{,**} rwklmx,", "deny /run/murage-turn-requests/{,**} rwklmx,", "deny /run/murage-digest-cache/{,**} rwklmx,", "deny /root/{,**} rwklmx,", "deny /etc/shadow* rwklmx,", "deny /etc/sudoers rwklmx,", "deny /etc/sudoers.d/{,**} rwklmx,", "deny /data/home/secrets{,/**} rwklmx,", "deny /data/home/[^w]** rwklmx,", "deny /data/home/w[^o]** rwklmx,", "deny /usr/local/libexec/{,**} wl,", "deny /opt/murage/{,**} wl,"]) expect(payload).toContain(rule);
  // Workspaces live at /data/home/workspaces/<id> and the engine home at /data/engine-homes/<engine>.
  expect(payload.join("\n")).not.toMatch(/\/data\/home\/(\{|\*\*|workspaces)/);
  expect(payload.join("\n")).not.toContain("/data/engine-homes");
  expect(payload.join("\n")).not.toMatch(/\/(usr|opt\/murage)[^\n]* (r|x|rw)[a-z]*,/);
  // The launching bwrap profile stays unconfined by the denies; only the stacked child carries them.
  expect(denies(section(file, "profile bwrap /usr/bin/bwrap"))).toEqual([]);
  expect(file).toContain("profile unpriv_bwrap flags=(attach_disconnected)");
});

it("browser payload profile denies server state, engine homes and host secrets", () => {
  const file = text("browser-bwrap.apparmor");
  const payload = denies(section(file, "profile murage-browser flags"));
  for (const rule of ["deny /data/home/{,**} rwklmx,", "deny /data/engine-homes/{,**} rwklmx,", "deny /data/proxy/{,**} rwklmx,", "deny /etc/murage-home/{,**} rwklmx,", "deny /run/murage-turn-requests/{,**} rwklmx,", "deny /run/murage-digest-cache/{,**} rwklmx,", "deny /root/{,**} rwklmx,", "deny /etc/shadow* rwklmx,", "deny /etc/sudoers* rwklmx,", "deny /etc/sudoers.d/{,**} rwklmx,"]) expect(payload).toContain(rule);
  expect(payload.join("\n")).not.toContain("/data/browser");
  expect(denies(section(file, "profile murage-browser-bwrap"))).toEqual([]);
});

it("home unit gets filesystem hardening that keeps setuid sudo and the root launcher working", () => {
  const unit = text("murage-home.service");
  const lines = unit.split("\n").filter((l) => !l.startsWith("#"));
  for (const line of ["ProtectSystem=full", "ReadWritePaths=/etc/murage-home", "ProtectHome=yes", "ProtectKernelModules=yes"]) expect(lines).toContain(line);
  // Masking any part of /proc stops pasta and bwrap mounting a fresh /proc for a turn (seen on a real home).
  expect(lines.some(line => line.startsWith("ProtectKernelLogs="))).toBe(false);
  for (const name of ["NoNewPrivileges", "PrivateTmp", "ProtectKernelTunables", "ProtectControlGroups", "RestrictAddressFamilies", "SystemCallFilter", "RestrictNamespaces", "RestrictSUIDSGID", "CapabilityBoundingSet", "ProtectClock", "ProtectHostname"]) expect(lines.some((l) => l.startsWith(name + "="))).toBe(false);
  expect(lines).not.toContain("ProtectSystem=strict");
});
it("automatic upgrades never restart Murage units", () => {
  const build = text("build-image.sh");
  expect(build).toContain("/etc/needrestart/conf.d/50-murage.conf");
  expect(build).toContain("$nrconf{restart} = 'l';");
  expect(build).toContain("$nrconf{override_rc}{qr(^murage-)} = 0;");
});
