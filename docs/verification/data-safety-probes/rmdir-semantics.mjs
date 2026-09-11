import { mkdirSync, mkdtempSync, openSync, rmSync, watch, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "rmdir-sem-"));
const mk = (name) => { const d = join(root, name, "native"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "t.ndjson"), "x"); writeFileSync(join(root, name, "messages.db"), "x"); return join(root, name); };
const report = (label, dir) => console.log(label.padEnd(28), existsSync(dir) ? `SURVIVED: ${JSON.stringify(readdirSync(dir))} native=${existsSync(join(dir,"native"))}` : "fully removed");
// 1: open fd on the native dir
const a = mk("openfd"); const fd = openSync(join(a, "native"), "r");
try { rmSync(a, { recursive: true, force: true, maxRetries: 0 }); } catch (e) { console.log("openfd rmSync error:", e.code); }
report("open fd on native/", a);
// 2: fs.watch on native dir
const b = mk("watch"); const w = watch(join(b, "native"), () => {});
try { rmSync(b, { recursive: true, force: true, maxRetries: 0 }); } catch (e) { console.log("watch rmSync error:", e.code); }
report("fs.watch on native/", b); w.close();
// 3: child process cwd = native
const c = mk("cwd");
const child = spawn("sleep", ["30"], { cwd: join(c, "native"), stdio: "ignore" });
await new Promise(r => setTimeout(r, 300));
try { rmSync(c, { recursive: true, force: true, maxRetries: 0 }); } catch (e) { console.log("cwd rmSync error:", e.code); }
report("child cwd = native/", c); child.kill();
// 4: rm -rf with child cwd
const d = mk("cwd-rm"); const child2 = spawn("sleep", ["30"], { cwd: join(d, "native"), stdio: "ignore" });
await new Promise(r => setTimeout(r, 300));
await new Promise(r => { const p = spawn("rm", ["-rf", d], { stdio: ["ignore", "inherit", "inherit"] }); p.on("exit", r); });
report("rm -rf, child cwd = native/", d); child2.kill();
// 5: open fd on a FILE inside native (append handle, like a transcript writer)
const e = mk("openfile"); openSync(join(e, "native", "t.ndjson"), "a");
try { rmSync(e, { recursive: true, force: true, maxRetries: 0 }); } catch (err) { console.log("openfile rmSync error:", err.code); }
report("open file fd in native/", e);
rmSync(root, { recursive: true, force: true });
