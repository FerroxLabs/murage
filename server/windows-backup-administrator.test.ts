// WIN-BACKUP-RT-1018: a person who started Murage with Run as administrator is told so, in every language, before
// the backup helper (which refuses an elevated token with its generic exit 72) is ever started. The real helper and
// the real Windows token are covered by installation-windows-backup-elevated.test.ts on windows-latest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_CAPTURE_CODES, captureFailureReason, captureFailureSentence } from "../shared/backup-capture-failure.mjs";
import { PACK_CODES } from "../scripts/locale-partitions.mjs";

const mocks = vi.hoisted(() => ({ resources: vi.fn() }));
vi.mock("./windows-backup-resources.ts", () => ({ createWindowsBackupResourceResolver: mocks.resources }));
const { resolveWindowsBackupRuntime, setWindowsElevationTestAnswer } = await import("./installation-backup-encryption.ts");
const { readWindowsTokenElevation, windowsWhoamiPath } = await import("./windows-token-elevation.ts");

const KEY = "backup.stopped.administrator";
const catalogue = (code: string) => JSON.parse(readFileSync(new URL(`../src/locales/${code}.json`, import.meta.url), "utf8")) as Record<string, string>;
const descriptors = Object.fromEntries(["platform", "arch"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)!]));
function pretendWindows() { Object.defineProperty(process, "platform", { value: "win32" }); Object.defineProperty(process, "arch", { value: "x64" }); }
afterEach(() => {
  for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, key, descriptor);
  setWindowsElevationTestAnswer(null);
  mocks.resources.mockReset();
});

describe("Run as administrator: named before the helper starts", () => {
  it("stops with BACKUP_STARTED_AS_ADMINISTRATOR before the helper is resolved or spawned", async () => {
    pretendWindows();
    setWindowsElevationTestAnswer(() => true);
    await expect(resolveWindowsBackupRuntime("C:\\Murage\\resources\\backup-tools\\x64\\age.exe")).rejects.toMatchObject({ code: "BACKUP_STARTED_AS_ADMINISTRATOR" });
    expect(mocks.resources, "nothing about the helper was touched").not.toHaveBeenCalled();
  });

  it("a standard token, or one that can't be read, goes on to the helper (whose own refusal stays the gate)", async () => {
    pretendWindows();
    const executable = "C:\\Murage\\resources\\backup-tools\\x64\\murage-backup-age.exe";
    mocks.resources.mockReturnValue(async () => ({ executable }));
    for (const answer of [false, null]) {
      setWindowsElevationTestAnswer(() => answer);
      await expect(resolveWindowsBackupRuntime("C:\\Murage\\resources\\backup-tools\\x64\\age.exe")).resolves.toMatchObject({ ageExecutable: "C:\\Murage\\resources\\backup-tools\\x64\\age.exe" });
    }
    expect(mocks.resources).toHaveBeenCalledTimes(2);
  });

  it("reads the token with whoami.exe by its full path and an empty PATH, never through PATH", () => {
    const seen: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const answer = (stdout: string, status = 0) => (command: string, args: string[], options: { env: Record<string, string> }) => { seen.push({ command, args, env: options.env }); return { status, stdout }; };
    expect(readWindowsTokenElevation(answer("Mandatory Label\\High Mandatory Level Label S-1-16-12288"), { SystemRoot: "D:\\Windows" })).toBe(true);
    expect(readWindowsTokenElevation(answer("Mandatory Label\\Medium Mandatory Level Label S-1-16-8192"), {})).toBe(false);
    expect(readWindowsTokenElevation(answer("no label at all"), {})).toBeNull();
    expect(readWindowsTokenElevation(answer("S-1-16-12288", 1), {})).toBeNull();
    expect(readWindowsTokenElevation(() => { throw new Error("spawn failed"); }, {})).toBeNull();
    expect(seen.map(call => call.command)).toEqual(["D:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\whoami.exe"]);
    expect(seen.every(call => call.args.join(" ") === "/groups" && call.env.PATH === "")).toBe(true);
    // A SystemRoot that is not a plain drive folder is not used to find the program.
    expect(windowsWhoamiPath({ SystemRoot: "\\\\server\\share\\Windows" })).toBe("C:\\Windows\\System32\\whoami.exe");
    expect(windowsWhoamiPath({ SystemRoot: "relative" })).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it("the sentence names the cause and the way out, plainly, and matches the catalogue in every language", () => {
    expect(BACKUP_CAPTURE_CODES).toContain("BACKUP_STARTED_AS_ADMINISTRATOR");
    const english = captureFailureReason("BACKUP_STARTED_AS_ADMINISTRATOR");
    expect(english).toBe(catalogue("en")[KEY]);
    expect(english).toMatch(/administrator/);
    expect(english).toMatch(/open it again without Run as administrator/);
    expect(english).not.toMatch(/—|\bsafe(ly)?\b|\bfree\b|private working folder|[A-Z]{2,}_[A-Z_]+/i);
    expect(captureFailureSentence({ stage: "precondition", code: "BACKUP_STARTED_AS_ADMINISTRATOR" })).toContain(english);
    const hashes = JSON.parse(readFileSync(new URL("../src/locales/source-hashes.json", import.meta.url), "utf8")) as { locales: Record<string, Record<string, string>> };
    for (const code of PACK_CODES) {
      const text = catalogue(code)[KEY];
      expect(typeof text === "string" && text.length > 0 && text !== english, `${code} has its own translation`).toBe(true);
      expect(text, `${code} has no em dash`).not.toMatch(/—/);
      expect(hashes.locales[code][KEY], `${code} was accepted against this English`).toBe(createHash("sha256").update(english).digest("hex"));
    }
  });
});
