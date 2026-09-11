import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "wipe-race-"));
const data = join(root, ".murage"); const native = join(data, "native");
mkdirSync(native, { recursive: true });
for (const d of ["attachments", "events", "workspaces", "memory"]) { mkdirSync(join(data, d)); writeFileSync(join(data, d, "f"), "x"); }
for (const f of ["messages.db", "config.json", "bots.json"]) writeFileSync(join(data, f), "x");
for (let i = 0; i < 200; i++) writeFileSync(join(native, `t${i}.ndjson`), "x".repeat(50_000));
const before = statSync(data).birthtimeMs;
// the "live app": appends a transcript into native/ continuously (mkdir -p first, like appendNative's NATIVE_DIR ensure)
const app = spawn(process.execPath, ["-e", `
  const fs=require("node:fs"); const p=${JSON.stringify(native)};
  setInterval(()=>{ try{ fs.appendFileSync(p+"/live-"+Date.now()+".ndjson","x"); }catch{} }, 0);
`], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 50));
let error = null;
try { rmSync(data, { recursive: true, force: true }); } catch (e) { error = e.code; }
app.kill();
console.log("rmSync error:", error);
console.log("data dir survived:", existsSync(data), existsSync(data) && statSync(data).birthtimeMs === before ? "(same inode)" : "");
console.log("entries left:", existsSync(data) ? readdirSync(data) : []);
console.log("native survived:", existsSync(native), "files now in native:", existsSync(native) ? readdirSync(native).length : 0);
rmSync(root, { recursive: true, force: true });
