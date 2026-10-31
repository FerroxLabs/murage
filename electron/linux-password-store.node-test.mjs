import assert from "node:assert/strict";
import test from "node:test";
import { configureLinuxPasswordStore, KEYRING_PROBE_TIMEOUT_MS, probeSessionKeyring } from "./linux-password-store.mjs";

const reply = names => `array [\n${names.map(name => `string "${name}"`).join("\n")}\n]`;
for (const [names, expected] of [
  [["org.freedesktop.secrets"], "gnome-libsecret"],
  [["org.kde.kwalletd5"], "kwallet5"],
  [["org.kde.kwalletd6"], "kwallet6"],
  [["org.kde.kwalletd5", "org.kde.kwalletd6"], "kwallet6"],
  [["org.freedesktop.secrets", "org.kde.kwalletd6"], "gnome-libsecret"],
  [["org.freedesktop.secrets.fake"], null],
  [[], null],
]) test(`session owners ${names.join(",")} select ${expected}`, () => {
  const appended = [];
  const commandLine = { hasSwitch: () => false, appendSwitch: (...args) => appended.push(args) };
  const backend = configureLinuxPasswordStore({ platform: "linux", env: {}, commandLine,
    probe: () => probeSessionKeyring(() => reply(names)) });
  assert.equal(backend, expected);
  assert.deepEqual(appended, expected ? [["password-store", expected]] : []);
});

for (const desktop of [undefined, "", "unknown", "i3", "sway"])
  test(`unknown desktop ${desktop} probes`, () => {
    assert.equal(configureLinuxPasswordStore({ platform: "linux", env: { XDG_CURRENT_DESKTOP: desktop },
      commandLine: { hasSwitch: () => false, appendSwitch: () => {} }, probe: () => "gnome-libsecret" }), "gnome-libsecret");
  });

test("explicit switches, known desktops and other platforms are left alone", () => {
  for (const [platform, desktop, explicit] of [["linux", "sway", true], ["linux", "ubuntu:GNOME", false], ["linux", "KDE", false], ["darwin", "", false], ["win32", "", false]]) {
    let probes = 0;
    assert.equal(configureLinuxPasswordStore({ platform, env: { XDG_CURRENT_DESKTOP: desktop },
      commandLine: { hasSwitch: name => { assert.equal(name, "password-store"); return explicit; }, appendSwitch: () => assert.fail("switch changed") },
      probe: () => { probes++; return "gnome-libsecret"; } }), null);
    assert.equal(probes, 0);
  }
});

test("the bus probe has a hard short timeout and missing bus or command is harmless", () => {
  for (const code of ["ETIMEDOUT", "ENOENT", "ECONNREFUSED"]) {
    let invocation;
    assert.equal(probeSessionKeyring((command, args, options) => {
      invocation = { command, args, options };
      throw Object.assign(new Error("injected probe failure"), { code });
    }), null);
    // Assertions stay outside the probe's catch, which intentionally swallows failures.
    const { command, args, options } = invocation;
    assert.equal(command, "dbus-send");
    assert.ok(args.includes("--session"));
    assert.ok(args.includes("--reply-timeout=500"));
    assert.ok(args.includes("org.freedesktop.DBus.ListNames"));
    assert.equal(options.timeout, KEYRING_PROBE_TIMEOUT_MS);
    assert.ok(options.timeout > 0 && options.timeout <= 1000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 64 * 1024);
  }
});
