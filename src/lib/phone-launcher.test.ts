// 1.0.16 F3: the "Your computers" entry in the You menu, phone app only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  callNative: vi.fn(async (..._args: unknown[]) => true as unknown),
  inNativeShell: vi.fn(() => true),
  nativeAvailable: vi.fn(async (_method: string) => true),
}));
vi.mock("@/lib/native-shell", () => native);

import { showYourComputers } from "./phone-launcher";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

beforeEach(() => {
  native.callNative.mockReset().mockResolvedValue(true);
});

describe("showYourComputers", () => {
  it("asks the app to show its computer list, with no arguments", async () => {
    await showYourComputers();
    expect(native.callNative).toHaveBeenCalledTimes(1);
    expect(native.callNative).toHaveBeenCalledWith("showLauncher");
  });

  it("leaves the workspace as it was when the app cannot do it", async () => {
    native.callNative.mockRejectedValue(Object.assign(new Error("no"), { code: "native-unavailable" }));
    await expect(showYourComputers()).resolves.toBeUndefined();
  });
});

describe("the You menu entry", () => {
  const sidebar = read("../components/Sidebar.tsx");

  it("is added only when the phone app lists showLauncher, and is the first row", () => {
    expect(sidebar).toContain("const phoneLauncher = usePhoneLauncher();");
    const items = sidebar.slice(sidebar.indexOf("const youItems: YouMenuItem[] = ["));
    expect(items.slice(0, 400)).toContain('...(phoneLauncher ? [{ key: "your-computers", label: t("nav.yourComputers")');
    expect(items.slice(0, 400)).toContain("showYourComputers()");
  });

  it("only the phone app can show it: the hook needs the native shell and the method", () => {
    const hook = read("./phone-launcher.ts");
    expect(hook).toContain("if (!inNativeShell()) return;");
    expect(hook).toContain('nativeAvailable("showLauncher")');
    expect(hook).toContain("useState(false)");
  });

  it("showLauncher is a method the web side already knows", () => {
    expect(read("./native-shell.ts")).toContain('"showLauncher"');
  });
});

describe("Your computers in the language packs", () => {
  const codes = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
  const pack = (code: string): Record<string, string> => JSON.parse(read(`../locales/${code}.json`));

  it("reads Your computers in English", () => {
    expect(pack("en")["nav.yourComputers"]).toBe("Your computers");
  });

  it("is in every shipped pack, with no em or en dash", () => {
    for (const code of codes) {
      const text = pack(code)["nav.yourComputers"];
      expect(text, code).toBeTruthy();
      expect(text, code).not.toMatch(/[–—]/);
    }
  });

  it("is recorded against the English source in every translated pack", () => {
    const hashes = JSON.parse(read("../locales/source-hashes.json")).locales as Record<string, Record<string, string>>;
    const expected = createHash("sha256").update("Your computers").digest("hex");
    for (const code of codes.filter((c) => c !== "en")) expect(hashes[code]!["nav.yourComputers"], code).toBe(expected);
  });
});
