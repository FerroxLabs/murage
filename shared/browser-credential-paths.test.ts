// secret-scan: fixture
import { expect, it, vi } from "vitest";
import { gateHit } from "./gate-files.ts";
import { dataCredentialHit } from "./data-credential-paths.ts";
import { credentialGlobHit } from "./sensitive-globs.ts";

it.each([
  ["linux", "/home/Jane Doe/.murage"], ["darwin", "/Users/Jane Doe/Library/Application Support/murage"],
  ["win32", "C:/Users/Jane Doe/AppData/Roaming/murage"], ["linux", "/data"],
] as const)("covers browser descriptor and native writer names on %s at %s", (platform, root) => {
  for (const file of ["browser-connection.json", "browser-connection.json.42.12345678-abcd.tmp", "cua-connection.json.42.12345678-abcd.tmp",
    "browser-extension/client-configs/client.json.new-42", "browser-extension/client-configs/client.json.42.12345678-abcd.tmp",
    "bx-run/browser-0123456789abcdef.json.new-42", "bx-run/native-host.json.new-42"]) {
    expect(dataCredentialHit([root + "/" + file], [root]), file).not.toBeNull();
    expect(credentialGlobHit([root + "/" + file.replace(/42$/, "*") + (file.endsWith("42") ? "" : "*")], { platform, roots: { temp: ["/tmp"], data: [root] } }), file).not.toBeNull();
  }
  for (const file of ["browser-engine/bot/history.db", "bx-run/activity.log", "browser-extension/client-configs/readme.txt"]) {
    expect(dataCredentialHit([root + "/" + file], [root]), file).toBeNull();
  }
});

it("uses the desktop userData root when it differs from the harness data folder", () => {
  vi.stubEnv("MURAGE_USER_DATA", "/desktop/user data");
  try {
    expect(gateHit(["/desktop/user data/browser-connection.json"])).not.toBeNull();
    expect(gateHit([], ["/desktop/user data/browser-connection.*"])).not.toBeNull();
    expect(gateHit(["/desktop/user data/browser-history.db"])).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});
