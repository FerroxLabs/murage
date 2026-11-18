// WIN-BACKUP-RT-1018: the elevated side of the real Windows backup helper, run in the ordinary Windows shard, whose
// account (the hosted runner's administrator) is elevated. Its companion, installation-windows-backup-roundtrip.test.ts,
// runs as a standard user and takes a real backup all the way back.
//
//   1. The real helper, launched by an elevated parent and sent an otherwise valid private-stage request through the
//      product's own transport, refuses with exit 72 and writes nothing to its control streams
//      (native/backup-age/transport.cpp:134 and :320; native/backup-age/elevated-fixture.mjs models the same).
//   2. The product sees the elevation before it spawns the helper and stops with BACKUP_STARTED_AS_ADMINISTRATOR,
//      whose sentence names the cause and the way out, instead of BACKUP_FOLDER_UNUSABLE ("couldn't make its
//      private working folder"), which is what a person who chose Run as administrator was told before.
//
// MURAGE_TEST_WIN_BACKUP_TOOLS and MURAGE_TEST_REQUIRE_WIN_BACKUP_RT are set by ci.yml ("Stage the real Windows
// backup helper and pinned age.exe"); with the second set, a missing setup or a token that is not elevated fails.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureFailureReason } from "../shared/backup-capture-failure.mjs";
import { setWindowsBackupRuntimeTestSeam } from "./installation-backup-encryption.ts";
import { writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { probePrivateStage } from "./testing/windows-private-stage-probe.ts";
import { readWindowsTokenElevation } from "./windows-token-elevation.ts";

const toolsSource = process.env.MURAGE_TEST_WIN_BACKUP_TOOLS;
const enabled = process.platform === "win32" && process.arch === "x64" && Boolean(toolsSource);
const required = process.env.MURAGE_TEST_REQUIRE_WIN_BACKUP_RT === "1";
const WHOAMI = "C:\\Windows\\System32\\whoami.exe";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); setWindowsBackupRuntimeTestSeam(null); });

function elevatedNow() {
  const groups = execFileSync(WHOAMI, ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const elevated = groups.includes("S-1-16-12288");
  console.info(`WINRT_ELEVATED_CASE_TOKEN_ELEVATED=${elevated} (whoami.exe by full path)`);
  return elevated;
}

describe("Windows: started as administrator, the backup helper refuses and Murage says why", () => {
  it.skipIf(!required)("is configured on the CI runner (cannot pass by skipping)", () => {
    expect(enabled).toBe(true);
  });

  it.skipIf(!enabled)("precondition: this shard's token is elevated, and the product's own check agrees", () => {
    expect(elevatedNow(), "whoami.exe shows a High mandatory level").toBe(true);
    expect(readWindowsTokenElevation()).toBe(true);
  });

  it.skipIf(!enabled)("the real helper, sent a valid private-stage request by an elevated parent, exits 72 and writes nothing", { timeout: 120_000 }, async () => {
    expect(elevatedNow()).toBe(true);
    // The product's own transport sends the same framing a backup sends (operation "private-stage"). If the helper admits
    // the request, the transport drives the whole protocol (PREPARED, then RELEASE plus EOF, then RELEASED) so the helper
    // exits cleanly, and the test then fails with "the helper admitted an elevated parent". The throwaway `nogate`
    // CI commit deletes only need(!elevation.TokenIsElevated) (native/backup-age/transport.cpp:134) and must fail here
    // with exactly that message: that run is the proof that this test tests the gate.
    // The cause, pinned as far as a silent helper allows (every need() failure is exit 72 with no output, and the
    // helper stays as it is): the request is the one probePrivateStage also sends from a standard user, where
    // installation-windows-backup-roundtrip.test.ts requires it to be ADMITTED, so only the parent's token differs;
    // the refusal comes at exactly the prepare step (parentProcess(), where the elevation check sits, runs before
    // PREPARED); and with only that check deleted the same request is admitted (nogate, CI run 42399852767).
    const probe = await probePrivateStage(toolsSource!, roots);
    console.info(`WINRT_ELEVATED_HELPER_EXIT=${String(probe.exitCode)} admitted=${probe.admitted} prepared=${probe.prepared} toolStep=${String(probe.toolStep)} stdoutBytes=${probe.stdoutBytes} controlBytes=${probe.controlBytes} code=${probe.code}`);
    if (probe.admitted || probe.prepared) throw new Error("the helper admitted an elevated parent");
    expect(probe.exitCode, "the helper refuses an elevated parent with exit 72").toBe(72);
    expect(probe.toolStep, "refused at exactly the prepare step, before PREPARED").toBe("prepare");
    expect(probe.code, "the transport's refusal code for a helper that exits before PREPARED").toBe("AGE_PROCESS_FAILED");
    expect(probe.stdoutBytes, "no output").toBe(0);
    expect(probe.controlBytes, "no control record").toBe(0);
  });

  it.skipIf(!enabled)("a backup started as administrator stops before the helper with BACKUP_STARTED_AS_ADMINISTRATOR and its sentence", { timeout: 120_000 }, async () => {
    expect(elevatedNow()).toBe(true);
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-win-elevated-"))); roots.push(root);
    const app = join(root, "installed"), resources = join(app, "resources"), tools = join(resources, "backup-tools", "x64");
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(app, "Murage.exe"), Buffer.from("MZ murage fixture executable\n"));
    for (const file of ["murage-backup-age.exe", "age.exe", "age-keygen.exe", "LICENSE"]) copyFileSync(join(toolsSource!, file), join(tools, file));
    setWindowsBackupRuntimeTestSeam({ host: { resourcesPath: resources, currentExecutable: join(app, "Murage.exe") } });
    const fixture = backupFixture(); roots.push(fixture.parent); fixture.db.close();
    const destination = join(fixture.parent, "backups"); mkdirSync(destination);
    const keygen = join(tools, "age-keygen.exe");
    const identity = execFileSync(keygen, [], { windowsHide: true, encoding: "utf8", env: { PATH: "" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4096 });
    const recipient = execFileSync(keygen, ["-y"], { windowsHide: true, input: identity, encoding: "utf8", env: { PATH: "" }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 4096 }).trim();
    const options = { ageExecutable: join(tools, "age.exe"), identity, recipient,
      selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const };
    const refusal = await writeEncryptedInstallationBackup(fixture.data, join(destination, "backup.age"), options).then(() => null, (error: unknown) => error as { code?: unknown });
    console.info(`WINRT_ELEVATED_PRODUCT_CODE=${String(refusal?.code)}`);
    expect(refusal?.code, "named for the cause, not the backup folder").toBe("BACKUP_STARTED_AS_ADMINISTRATOR");
    expect(captureFailureReason(refusal?.code)).toBe((JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>)["backup.stopped.administrator"]);
  });
});
