import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
// Synthetic tiny runtime; never release inputs. Caller removes root.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TARGETS, treeDigest } from '../signal-inventory.mjs';
import { syntheticSyncProof } from './signal-evidence.mjs';
import { pinSyntheticTree } from './signal-runtime-tree.mjs';
import { makeSyntheticEvidence } from './signal-test-evidence.mjs';
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const put = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
// A stored ZIP with one entry; the bytes are synthetic, never release evidence.
function jar(entry, bytes) {
  const name = Buffer.from(entry), data = Buffer.from(bytes);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
export function makeSyntheticRuntime(target = "linux-x64", sourceBuild = false) {
  const root = mkdtempSync(join(tmpdir(), "signal-runtime-"));
  const runtime = join(root, "runtime"), input = join(root, "input"), licenseRoot = join(root, "licenses");
  const sourceRoot = join(root, "sources");
  const native = TARGETS[target].native;
  put(runtime, "signal-cli.jar", "fake CLI jar");
  put(runtime, "lib/signal-network-2.15.3_unofficial_157.jar", "fake network jar");
  put(runtime, "lib/libsignal-client.jar", jar("Synthetic.class", "fake class"));
  put(runtime, `native/${native}`, "fake JNI");
  put(runtime, "jre/release", 'JAVA_VERSION="25.0.1"\nJAVA_RUNTIME_VERSION="25.0.1+1"\nIMPLEMENTOR="Eclipse Adoptium"\n');
  put(runtime, `jre/bin/${target === "win32-x64" ? "java.exe" : "java"}`, "fake Java");
  put(runtime, "jre/lib/modules", "fake modules");
  const sqlite = target === "win32-x64" ? "sqlitejdbc.dll" : target === "darwin-arm64" ? "libsqlitejdbc.dylib" : "libsqlitejdbc.so";
  put(runtime, `native/${sqlite}`, "fake sqlite");
  const jars = ["signal-cli.jar", "lib/signal-network-2.15.3_unofficial_157.jar", "lib/libsignal-client.jar"].map(path => ({ path, sha256: digest(readFileSync(join(runtime, path))) }));
  const version = "0.14.11-SNAPSHOT";
  const artifact = { jars, jre: { build: "25.0.1+1", sha256: treeDigest(join(runtime, "jre")) },
    libsignal: { version: "fixture-tag", sha256: digest("fake JNI"), provenance: sourceBuild
      ? { kind: "source-build", tag: "fixture-tag", buildLog: "fixture release runner log" }
      : { kind: "upstream-jar", jar: "lib/libsignal-client.jar", entry: native } } };
  const pin = { contract: "murage-signal-runtime-pin/1.0", signalCliVersion: version, rateLimitNotSentProof: null,
    g0: { signalCliVersion: version, citation: "fixture S1 evidence" },
    signalNetwork: { coordinate: "com.github.turasa:signal-network", version: "2.15.3_unofficial_157", sha256: jars[1].sha256,
      syncProof: structuredClone(syntheticSyncProof) },
    targets: Object.fromEntries(Object.keys(TARGETS).map(t => {
      const value = structuredClone(artifact);
      if (t !== "darwin-arm64") value.libsignal.provenance = { kind: "upstream-jar", jar: "lib/libsignal-client.jar", entry: native };
      return [t, value];
    })) };
  pin.releaseInputs = Object.fromEntries(Object.keys(TARGETS).map(t => [t, {
    layout: "prelinked-jre", url: `https://example.test/reviewed/${t}.tar.gz`, sha256: digest("synthetic reviewed inputs archive"),
  }]));
  const fixtureRoot = join(root, "synthetic-evidence");
  const documents = ["signal-cli", "libsignal", "temurin", "classpath-exception"].map(component => {
    const path = `${component}/LICENSE.txt`, bytes = `synthetic ${component} licence text`;
    put(licenseRoot, path, bytes); return { component, path, sha256: digest(bytes) };
  });
  put(licenseRoot, "manifest.json", JSON.stringify({ documents }));
  put(sourceRoot, "src/components/SignalSettings.tsx", 'Signal link disconnect notes-stuck offline resend leave-it');
  put(sourceRoot, "server/channels/signal/types.ts", 'export type SignalProblem = "notes-stuck" | "offline";\nexport type SignalAction = { action: "link" | "disconnect" } | { action: "resend" | "leave-it"; deliveryId: string };\nexport type RpcId = string | number;');
  put(sourceRoot, "server/index.ts", '"/api/signal/status"');
  put(sourceRoot, "src/lib/settings-card-registry.ts", '// channels.signal channels.signal-help\ncard("signal", "channels", "signal-heading", {}); card("signal-help", "channels", "signal-help-heading", {});');
  put(sourceRoot, "src/lib/settings-index.ts", 'export const APP_SETTINGS_ENTRIES = SETTINGS_CARDS.map(card => ({ id: card.id }));');
  const surfaces = [
    ...["card", "search"].flatMap(kind => ["channels.signal", "channels.signal-help"].map(id => ({ kind, id, path: "src/lib/settings-card-registry.ts", why: "Find Signal settings." }))),
    { kind: "route", id: "/api/signal/status", path: "server/index.ts", why: "Show connection status." },
    { kind: "problem", id: "notes-stuck", path: "src/components/SignalSettings.tsx", why: "Show held notes." },
    { kind: "problem", id: "offline", path: "src/components/SignalSettings.tsx", why: "Show connection status." },
    { kind: "recovery", id: "link", path: "src/components/SignalSettings.tsx", why: "Start a link." },
    { kind: "recovery", id: "disconnect", path: "src/components/SignalSettings.tsx", why: "Disconnect Signal." },
    { kind: "review", id: "resend", path: "src/components/SignalSettings.tsx", why: "Review an uncertain reply." },
    { kind: "review", id: "leave-it", path: "src/components/SignalSettings.tsx", why: "Keep an uncertain reply." },
  ];
  put(sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces }));
  cpSync(runtime, input, { recursive: true });
  safeWipeSync(join(input, "jre"));
  cpSync(join(runtime, "jre"), join(input, "jdk"), { recursive: true });
  const actual = pinSyntheticTree(runtime, target, licenseRoot);
  for (const t of Object.keys(TARGETS)) {
    const copy = structuredClone(actual);
    const sqliteOther = t === "win32-x64" ? "sqlitejdbc.dll" : t === "darwin-arm64" ? "libsqlitejdbc.dylib" : "libsqlitejdbc.so";
    const rename = path => path === `native/${native}` ? `native/${TARGETS[t].native}` : path === `native/${sqlite}` ? `native/${sqliteOther}` : path;
    copy.natives = copy.natives.map(n => ({ ...n, path: rename(n.path) }));
    copy.integrity.rows = copy.integrity.rows.map(r => ({ ...r, path: rename(r.path) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    pin.targets[t] = copy;
  }
  makeSyntheticEvidence(fixtureRoot, pin);
  cpSync(fixtureRoot, join(runtime, "g0"), { recursive: true });
  cpSync(licenseRoot, join(runtime, "licenses"), { recursive: true });
  return { root, runtime, input, pin, target, licenseRoot, sourceRoot, fixtureRoot, destination: join(root, "staged"), surfaces };
}
