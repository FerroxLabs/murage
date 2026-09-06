import type { ExecFileOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: run }));

// Override only the delimiter, so a macOS/Linux run still catches Windows
// PATH corruption. Production refresh functions, not an unused helper, must
// pass the resulting value to the subprocess API.
async function listenerWithDelimiter(delimiter: string) {
  vi.resetModules();
  vi.doMock("node:path", async () => ({
    ...await vi.importActual<typeof import("node:path")>("node:path"),
    delimiter,
  }));
  return import("../src/listener.ts");
}

const windows64 = "C:\\Program Files\\Tailscale\\tailscale.exe";
const windows32 = "C:\\Program Files (x86)\\Tailscale\\tailscale.exe";
const fixtureStatus = JSON.stringify({ Self: {
  DNSName: "fixture.tail1234.ts.net.", TailscaleIPs: ["100.70.0.8"],
} });
type Reply = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void;
const missing = (reply: Reply) => reply(Object.assign(new Error("fixture: candidate absent"), { code: "ENOENT" }), "", "");

beforeEach(() => {
  run.mockReset();
  vi.stubEnv("ProgramFiles", undefined);
  vi.stubEnv("ProgramFiles(x86)", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:path");
  vi.resetModules();
});

describe("Tailscale executable discovery", () => {
  it.each([windows64, windows32])("finds the standard install at %s without shell quoting", async (installed) => {
    const listener = await listenerWithDelimiter(";");
    run.mockImplementation((cli: string, _args: string[], _options: ExecFileOptions, reply: Reply) => {
      if (cli === installed) reply(null, fixtureStatus, "");
      else missing(reply);
    });
    const candidates = listener.tailscaleCandidates("C:\\Users\\Fixture");
    expect(candidates).toContain(windows64);
    expect(candidates).toContain(windows32);
    expect(candidates.indexOf(windows64)).toBeLessThan(candidates.indexOf(windows32));
    expect(candidates.at(-1)).toBe("tailscale");

    await listener.refreshTailnetName();
    expect(listener.tailnetName()).toBe("fixture.tail1234.ts.net");
    expect(listener.tailnetSelfAddress()).toBe("100.70.0.8");
    const [cli, args, options] = run.mock.calls.at(-1)!;
    expect(cli).toBe(installed);
    expect(args).toEqual(["status", "--json"]);
    expect(options.shell).toBeUndefined();
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(5_000);
  });

  it.each([
    ["ProgramFiles", "D:\\Company Apps", "D:\\Company Apps\\Tailscale\\tailscale.exe"],
    ["ProgramFiles(x86)", "E:\\Legacy Apps", "E:\\Legacy Apps\\Tailscale\\tailscale.exe"],
  ])("honors %s on a custom drive", async (variable, directory, installed) => {
    vi.stubEnv(variable, directory);
    const listener = await listenerWithDelimiter(";");
    run.mockImplementation((cli: string, _args: string[], _options: ExecFileOptions, reply: Reply) => {
      if (cli === installed) reply(null, fixtureStatus, "");
      else missing(reply);
    });
    await listener.refreshTailnetName();
    expect(listener.tailnetName()).toBe("fixture.tail1234.ts.net");
    expect(run.mock.calls.at(-1)?.[0]).toBe(installed);
  });
});

describe("PATH reaching the actual CLI probes", () => {
  it.each([
    [";", "C:\\Windows\\System32;D:\\Tools With Spaces", "C:\\Windows\\System32;D:\\Tools With Spaces;/opt/homebrew/bin;/usr/local/bin;/usr/bin;/bin"],
    [":", "/fixture/bin", "/fixture/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
  ])("uses %j separators in the bare-name status attempt", async (delimiter, inheritedPath, expectedPath) => {
    vi.stubEnv("PATH", inheritedPath);
    const listener = await listenerWithDelimiter(delimiter);
    run.mockImplementation((cli: string, _args: string[], options: ExecFileOptions, reply: Reply) => {
      // A malformed PATH behaves like a failed lookup; the resulting cached
      // status must demonstrate that the correct environment reached execFile.
      if (cli === "tailscale" && options.env?.PATH === expectedPath) reply(null, fixtureStatus, "");
      else missing(reply);
    });
    await listener.refreshTailnetName();
    expect(listener.tailnetName()).toBe("fixture.tail1234.ts.net");
    expect(run.mock.calls.at(-1)?.[0]).toBe("tailscale");
    expect(run.mock.calls.every(([, , options]) => options.env.PATH === expectedPath)).toBe(true);
  });

  it("passes Windows PATH to the read-only Serve observer too", async () => {
    vi.stubEnv("PATH", "C:\\Windows\\System32;D:\\Tools");
    const listener = await listenerWithDelimiter(";");
    const expectedPath = "C:\\Windows\\System32;D:\\Tools;/opt/homebrew/bin;/usr/local/bin;/usr/bin;/bin";
    run.mockImplementation((cli: string, args: string[], options: ExecFileOptions, reply: Reply) => {
      expect(cli).toBe(windows64);
      expect(args).toEqual(["serve", "status", "--json"]);
      expect(options.env?.PATH).toBe(expectedPath);
      expect(options.killSignal).toBe("SIGKILL");
      expect(options.maxBuffer).toBe(1024 * 1024);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(5_000);
      reply(null, JSON.stringify({ Web: { "fixture.tail1234.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:8813" } },
      } } }), "");
    });
    await expect(listener.refreshBrowserServe(8813, { candidates: [windows64] })).resolves.toMatchObject({
      owner: "ours", origin: "https://fixture.tail1234.ts.net", problem: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
