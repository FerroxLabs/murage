// secret-scan: fixture
import { afterEach, expect, it } from "vitest";
import { gateHit } from "./gate-files.ts";
import { setRuntimeCredentialRoot } from "./runtime-credential-paths.ts";
afterEach(() => { for (const kind of ["browser", "tunnel", "backup"] as const) setRuntimeCredentialRoot(kind, undefined); });
it.each(["/relocated/Jane Doe", "C:/Users/Jane Doe/runtime", "/data/runtime"])("holds runtime credential files under %s", root => {
  for (const [kind, files] of [
    ["browser", ["browser-0123456789abcdef.json", "native-host.json.new-123"]],
    ["tunnel", ["connector-abc.token"]],
    ["backup", ["ssh-Ab12Cd/key", "remote-ref/7/ssh-Zy12Ab/key"]],
  ] as const) {
    setRuntimeCredentialRoot(kind, root);
    for (const file of files) {
      expect(gateHit([root + "/" + file]), file).not.toBeNull();
      expect(gateHit([], [root + "/" + file.replace(/[^/]+$/, "*")]), file).not.toBeNull();
    }
    expect(gateHit([root + "/ordinary.txt"])).toBeNull();
    expect(gateHit([], [root + "/*/"])).toBeNull();
    setRuntimeCredentialRoot(kind, undefined);
    expect(gateHit([root + "/" + files[0]])).toBeNull();
  }
});
