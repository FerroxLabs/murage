import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const {
  backendNodeIdFromRef,
  browserAddressAllowed,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserProfilePartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
} = require("./browser-snapshot.cjs");

const node = (role, name, backendDOMNodeId, extra = {}) => ({
  role: { value: role },
  name: { value: name },
  backendDOMNodeId,
  ...extra,
});

describe("browser snapshot", () => {
  it("keeps only interactive elements, in document order, as stable refs", () => {
    const { elements } = snapshotFromAxNodes([
      node("RootWebArea", "Example", 1),
      node("generic", "", 2),
      node("link", "  Pricing\n  plans ", 7),
      node("button", "Sign in", 9, { properties: [{ name: "disabled", value: { value: true } }] }),
      node("textbox", "", 12, { value: { value: "hello" } }),
      node("paragraph", "lots of text", 13),
      node("checkbox", "Remember me", 14, { properties: [{ name: "checked", value: { value: true } }] }),
      node("link", "hidden", 15, { ignored: true }),
      { role: { value: "link" }, name: { value: "no backend id" } },
    ]);
    expect(elements).toEqual([
      { ref: "b7", role: "link", name: "link" },
      { ref: "b9", role: "button", name: "button", disabled: true },
      { ref: "b12", role: "textbox", name: "protected field" },
      { ref: "b14", role: "checkbox", name: "checkbox", checked: true },
    ]);
  });

  it("drops unnamed non-editable elements and caps the list", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node("button", `b${i}`, i + 1));
    expect(snapshotFromAxNodes(nodes)).toMatchObject({ total: 300, truncated: true });
    expect(snapshotFromAxNodes(nodes).elements).toHaveLength(250);
    expect(snapshotFromAxNodes([node("button", "", 3)])).toEqual({ elements: [], total: 0, truncated: false });
  });

  it("genericizes every editable name in the bare AX fallback", () => {
    expect(snapshotFromAxNodes([
      node("textbox", "API key abc-123", 20, { value: { value: "abc-123" } }),
      node("searchbox", "one-time code 654321", 21),
      node("combobox", "Ordinary country picker", 22),
    ]).elements).toEqual([
      { ref: "b20", role: "textbox", name: "protected field" },
      { ref: "b21", role: "searchbox", name: "protected field" },
      { ref: "b22", role: "combobox", name: "protected field" },
    ]);
  });

  it("never exposes independent label or heading names in the bare fallback", () => {
    expect(snapshotFromAxNodes([
      node("heading", "Verification code 654321", 30),
      node("link", "download?token=secret", 31),
      node("textbox", "Verification code 654321", 32),
    ]).elements).toEqual([
      { ref: "b30", role: "heading", name: "heading" },
      { ref: "b31", role: "link", name: "link" },
      { ref: "b32", role: "textbox", name: "protected field" },
    ]);
  });

  it("formats one line per element with flags the model can read", () => {
    const text = formatSnapshot({
      title: "Shop",
      url: "https://shop.example/cart",
      elements: [
        { ref: "b1", role: "link", name: "Home" },
        { ref: "b2", role: "button", name: "Buy", disabled: true },
        { ref: "b3", role: "textbox", name: "Search", value: "shoes" },
      ],
    });
    expect(text).toBe(
      'Browser snapshot — Shop: https://shop.example/cart\nb1 link "Home"\nb2 button "Buy" (disabled)\nb3 textbox "Search" (value="shoes")',
    );
    expect(formatSnapshot({ title: "", url: "", elements: [] })).toContain("No interactive elements found.");
  });

  it("only ever navigates to web pages", () => {
    expect(browserNavigationUrl("example.com/path")).toBe("https://example.com/path");
    expect(browserNavigationUrl("about:blank")).toBe("about:blank");
    for (const bad of [
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,hi",
      "",
      "   ",
      "https://",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://[::1]/",
      "http://[::127.0.0.1]/",
      "http://[fc00::1]/",
      "http://[fec0::1]/",
      "http://[2001::1]/",
      "http://[2001:2::1]/",
      "http://[3fff::1]/",
      "http://[5f00::1]/",
    ]) {
      expect(() => browserNavigationUrl(bad)).toThrow();
      expect(browserNavigationAllowed(bad)).toBe(false);
    }
    expect(browserNavigationAllowed("https://example.com")).toBe(true);
    expect(browserAddressAllowed("93.184.216.34")).toBe(true);
    expect(browserAddressAllowed("2606:4700:4700::1111")).toBe(true);
    for (const address of ["127.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "::7f00:1", "2001::1", "2001:2::1", "3fff::1", "5f00::1", "fec0::1", "fe80::1", "::ffff:7f00:1", "not-an-ip"])
      expect(browserAddressAllowed(address)).toBe(false);
  });

  it("presents as the Chrome it is", () => {
    expect(
      browserUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Murage/0.1.38 Chrome/140.0.0.0 Electron/43.4.0 Safari/537.36"),
    ).toBe("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  });

  it("derives one durable partition per bot from safe characters only", () => {
    expect(browserPartition("bot_1-A")).toBe("persist:murage-browser-bot_1-A");
    expect(browserPartition("../../evil")).toBe("persist:murage-browser-evil");
    expect(() => browserPartition("")).toThrow();
    expect(() => browserPartition("../")).toThrow();
  });

  it("maps exact canonical and migrated profile partition ids without normalization", () => {
    expect(browserProfilePartition("work-2")).toBe("persist:murage-browser-profile-work-2");
    expect(browserProfilePartition("Work-2")).toBe("persist:murage-browser-profile-Work-2");
    for (const alias of ["work.2", "../work-2", "work-2!", "guest", ""]) {
      expect(() => browserProfilePartition(alias)).toThrow(/valid browser profile partition id/);
    }
  });

  // The bundle is generated from third_party/playwright-injected/entry.ts,
  // which the rebrand script deliberately skips; browser-surface.cjs is not
  // skipped. That asymmetry once left the writer exporting one global name
  // and the reader probing another, so every page silently fell back to the
  // bare accessibility tree. Nothing else catches it: the surface tests stub
  // `evaluate` by matching the reader's own string, so both halves can drift
  // and still go green. Compare the shipped bytes instead.
  it("injects the same browser global that the surface probes for", () => {
    const bundle = readFileSync(join(here, "resources", "browser-snapshot.js"), "utf8");
    const surface = readFileSync(join(here, "browser-surface.cjs"), "utf8");
    const exported = bundle.match(/window\.(__\w+Browser)\s*=/)?.[1];
    const probed = [...surface.matchAll(/window\.(__\w+Browser)\b/g)].map((match) => match[1]);
    expect(exported).toBeDefined();
    expect(probed.length).toBeGreaterThan(0);
    expect(new Set(probed)).toEqual(new Set([exported]));
  });

  it("decodes refs and rejects anything that is not one", () => {
    expect(backendNodeIdFromRef("b42")).toBe(42);
    expect(backendNodeIdFromRef(" b7 ")).toBe(7);
    for (const bad of ["42", "b", "bx", "b-1", "", undefined, "b12345678901234"]) {
      expect(() => backendNodeIdFromRef(bad)).toThrow(/stale|invalid/);
    }
  });
});
