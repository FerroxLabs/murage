import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface FuigoIsolation {
  command: string;
  prefix: string[];
  cleanup(): Promise<void>;
}
const unavailable = () => Object.assign(new Error("Private Fuigo update isolation is unavailable on this computer. Keep the selected engine."), { code: "FUIGO_PROBE_UNQUALIFIED" });
async function nativeHelper(): Promise<string> {
  const target = `${process.platform}-${process.arch}`;
  if (!["linux-x64", "win32-x64"].includes(target)) throw unavailable();
  const source = process.env.MURAGE_RESOURCES_PATH
    ? join(process.env.MURAGE_RESOURCES_PATH, "fuigo-probe")
    : fileURLToPath(new URL(`../dist-native/fuigo-probe/${target}`, import.meta.url));
  try {
    const root = await realpath(source), executable = process.platform === "win32" ? "launcher.exe" : "launcher";
    const cli = join(root, executable), manifestPath = join(root, "manifest.json");
    const [binaryStat, manifestStat] = await Promise.all([lstat(cli), lstat(manifestPath)]);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.size > 8 * 1024 * 1024 || !manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw unavailable();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.schema !== 1 || manifest.target !== target || manifest.executable !== executable || !/^[a-f0-9]{64}$/.test(manifest.binarySha256)) throw unavailable();
    if (createHash("sha256").update(await readFile(cli)).digest("hex") !== manifest.binarySha256 || await realpath(dirname(cli)) !== root) throw unavailable();
    return cli;
  } catch { throw unavailable(); }
}

/** Launch only exact verified candidate bytes, with no customer-installed runtime. */
export async function createFuigoIsolation(cli: string, home: string, env: NodeJS.ProcessEnv): Promise<FuigoIsolation> {
  if (process.platform === "darwin") {
    const policy = join(home, "outbound.sb");
    await writeFile(policy, "(version 1)\n(allow default)\n(deny network-outbound)\n", { mode: 0o600, flag: "wx" });
    try { await exec("/usr/bin/sandbox-exec", ["-f", policy, "/usr/bin/true"], { cwd: home, env, timeout: 15000, maxBuffer: 65536 }); }
    catch { throw unavailable(); }
    return { command: "/usr/bin/sandbox-exec", prefix: ["-f", policy, cli], cleanup: async () => {} };
  }
  const helper = await nativeHelper();
  if (process.platform === "linux") return { command: helper, prefix: ["run", cli, home], cleanup: async () => {} };
  const name = `murage-fuigo-probe-${randomUUID()}`;
  let sid: string;
  try {
    sid = (await exec(helper, ["setup", cli, home, name], { cwd: home, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 })).stdout.trim();
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr ?? "").includes("FUIGO_PROBE_CLEANUP")) throw Object.assign(new Error("Fuigo verification profile cleanup is pending."), { code: "FUIGO_PROBE_CLEANUP", profileName: name });
    throw unavailable();
  }
  if (!/^S-1-15-2-(?:\d+-)*\d+$/.test(sid)) throw Object.assign(new Error("Fuigo verification profile identity could not be confirmed; cleanup is pending."), { code: "FUIGO_PROBE_CLEANUP", profileName: name });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    try { await exec(helper, ["cleanup", name, sid], { cwd: home, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 }); cleaned = true; }
    catch { throw Object.assign(new Error("Fuigo verification profile cleanup is pending."), { code: "FUIGO_PROBE_CLEANUP", profileName: name, profileSid: sid }); }
  };
  try {
    const [original, copied] = await Promise.all([readFile(cli), readFile(join(home, "probe-fuigo.exe"))]);
    if (!original.equals(copied)) throw unavailable();
  } catch (error) { await cleanup(); throw error; }
  return { command: helper, prefix: ["run", name, sid, home], cleanup };
}
