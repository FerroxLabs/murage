import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { database } from "./database.ts";
import { rebaseArtifactSourceRoots } from "./artifact-paths.ts";
import { rebaseStoredPath } from "./stored-paths.ts";
import { cwdConstructors } from "./turn-paths.ts";
import { readConnectorManifest } from "./flux-connector.ts";
import { insertMessage, readMessage, rebaseMessageAttachmentPaths, rowsNamingImage } from "./message-db.ts";
import { currentScopeHome, registerScopeReconstructor, resetScopeBookkeeping, scopeId, scopeSourceOf, scopedCliHome, SCOPE_MARKER } from "./drivers/scoped-cli-home.ts";
import { containerComputerAction, containerComputerStatus, perBotLocalVmTarget, IMAGE, MANAGED_LABEL, DRIVER_LABEL, BASE_IMAGE_LABEL, IMAGE_LAYER_LABEL, IMAGE_LAYER_VERSION, WORKSPACE_LABEL, CUA_DRIVER_VERSION, BASE_IMAGE_DIGEST, TARGET_LABEL, VM_WORKSPACE_GUEST, type CommandRunner } from "./container-computer.ts";

const old = join(DATA_DIR, "old-root");
function moved() {
  ensureDirs();
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
}

describe("S5 phase 2 moved data folder", () => {
  it("site 9 regenerates a scope at its new hash and keeps the real home's login", () => {
    moved();
    const home = join(DATA_DIR, "providers", "s5-account");
    const priorHome = join(old, "providers", "s5-account");
    mkdirSync(priorHome, { recursive: true });
    writeFileSync(join(priorHome, "auth.json"), "login-only-in-real-home");
    const priorScope = scopedCliHome({ kind: "s5move", botId: "s5-bot", realHome: priorHome, share: ["auth.json"] });
    mkdirSync(join(DATA_DIR, "providers"), { recursive: true });
    renameSync(priorHome, home);
    const scope = scopedCliHome({ kind: "s5move", botId: "s5-bot", realHome: home, share: ["auth.json"] });
    expect(scope).not.toBe(priorScope);
    expect(JSON.parse(readFileSync(join(scope, SCOPE_MARKER), "utf8")).realHome).toBe(home);
    expect(readFileSync(join(scope, "auth.json"), "utf8")).toBe("login-only-in-real-home");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("login-only-in-real-home");
  });

  it("site 9 a resumed copied scope reconstructs its recorded realHome before rebuilding or reading credentials", () => {
    moved();
    const priorHome=join(old,"providers","resume-account"),home=join(DATA_DIR,"providers","resume-account");
    mkdirSync(priorHome,{recursive:true});writeFileSync(join(priorHome,"auth.json"),"resumed-login");
    const spec=(realHome: string)=>({kind:"s5resume",botId:"resume-bot",realHome,share:["auth.json"],generated:()=>({"settings.json":"fresh"})});
    registerScopeReconstructor("s5resume",({realHome})=>spec(realHome));
    const copied=scopedCliHome(spec(priorHome));
    const before=readFileSync(join(copied,SCOPE_MARKER),"utf8");
    mkdirSync(join(DATA_DIR,"providers"),{recursive:true});renameSync(priorHome,home);
    resetScopeBookkeeping();
    expect(scopeSourceOf(copied)).toBe(home);
    const resumed=currentScopeHome("s5resume",copied)!;
    expect(resumed).not.toBe(copied);
    expect(JSON.parse(readFileSync(join(resumed,SCOPE_MARKER),"utf8")).realHome).toBe(home);
    expect(readFileSync(join(resumed,"auth.json"),"utf8")).toBe("resumed-login");
    expect(readFileSync(join(copied,SCOPE_MARKER),"utf8")).toBe(before);
  });

  it("site 9 refuses a linked destination for the new scope before writing through it", () => {
    moved();
    const priorHome=join(old,"providers","guard-account"),home=join(DATA_DIR,"providers","guard-account");
    mkdirSync(priorHome,{recursive:true});writeFileSync(join(priorHome,"auth.json"),"guard-login");
    const spec=(realHome: string)=>({kind:"s5guard",botId:"guard-bot",realHome,share:["auth.json"],generated:()=>({"settings.json":"fresh"})});
    registerScopeReconstructor("s5guard",({realHome})=>spec(realHome));
    const copied=scopedCliHome(spec(priorHome));
    mkdirSync(join(DATA_DIR,"providers"),{recursive:true});renameSync(priorHome,home);
    const outside=join(DATA_DIR,"scope-link-target");mkdirSync(outside);
    symlinkSync(outside,join(DATA_DIR,"native","s5guard-scope",scopeId(home,"guard-bot")),process.platform==="win32"?"junction":"dir");
    resetScopeBookkeeping();
    expect(()=>currentScopeHome("s5guard",copied)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("site 13 migrates saved-file source roots before filtering, preserving id and unknown user folders", () => {
    moved();
    const db = database();
    const add = db.prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,'text','text/plain',1,?,'txt',1,'bot-s5','thread-s5','',?,'a.txt','old')");
    add.run("s5-artifact", "a", "a", join(old, "workspaces", "bot-s5", "threads", "thread-s5"));
    add.run("s5-user-artifact", "b", "b", "/user/chosen-folder");
    expect(rebaseArtifactSourceRoots(db, row => cwdConstructors({ id: row.botId }, row.threadId))).toBe(1);
    expect(db.prepare("SELECT source_root FROM artifacts WHERE id='s5-artifact'").get()?.source_root).toBe(join(DATA_DIR, "workspaces", "bot-s5", "threads", "thread-s5"));
    expect(db.prepare("SELECT source_root FROM artifacts WHERE id='s5-user-artifact'").get()?.source_root).toBe("/user/chosen-folder");
    expect(rebaseArtifactSourceRoots(db, row => cwdConstructors({ id: row.botId }, row.threadId))).toBe(0);
  });

  it("site 15 moves structured image bodies and rebuilds the image index without rewriting legacy tags", () => {
    moved();
    const prior = join(old, "attachments", "s5-image.png"), next = join(DATA_DIR, "attachments", "s5-image.png");
    const text = `<attached-image path="${prior}">`;
    insertMessage("s5-image-thread", { id: "s5-image", at: 1, role: "user", kind: "text", text, attachments: [{ kind: "image", path: prior, mime: "image/png" }] });
    expect(rebaseMessageAttachmentPaths()).toBeGreaterThanOrEqual(1);
    expect(readMessage("s5-image-thread", "s5-image")).toMatchObject({ text, attachments: [{ path: next }] });
    expect(rowsNamingImage("s5-image-thread", next)).toHaveLength(1);
  });

  it("site 19 reconstructs only Flux snapshot filenames under a recorded previous root", () => {
    moved();
    const manifest = join(DATA_DIR, "s5-flux.json"), name = "2026-11-13T04-00-00-000Z.123.backup";
    const prior = join(old, "flux-connector-backups", "opencode", name);
    writeFileSync(manifest, JSON.stringify({ version: 1, tools: { opencode: { tool: "opencode", backupPath: prior }, bad: { tool: "bad", backupPath: join(old, "flux-connector-backups", "bad", "unowned") } } }));
    const result = readConnectorManifest(manifest);
    expect(result.tools.opencode?.backupPath).toBe(join(DATA_DIR, "flux-connector-backups", "opencode", name));
    expect(result.tools.bad?.backupPath).toBe(join(old, "flux-connector-backups", "bad", "unowned"));
    expect(JSON.parse(readFileSync(manifest, "utf8")).tools.opencode.backupPath).toBe(result.tools.opencode?.backupPath);
  });

  it("never infers a previous root from a path's shape", () => {
    expect(rebaseStoredPath(join(old, "workspaces", "b", "threads", "t"), cwdConstructors({ id: "b" }, "t"), { previous: [] })).toEqual({ keep: true });
  });

  it("site 21 tells an external MCP client to replace its configuration when the saved config path is unavailable", async () => {
    const child = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./drivers/browser-extension-mcp.ts", import.meta.url))], { env: { ...process.env, MURAGE_BROWSER_MCP_CONFIG: join(DATA_DIR, "missing-client.json") }, timeout: 15_000 }).then(value => value, error => error);
    expect(child.stderr).toContain("data folder moved");
    expect(child.stderr).toContain("replace its configuration");
    expect(child.stdout).toBe("");
  });

  it("site 22 recognizes only the exact recorded old bind of an owned per-bot VM", async () => {
    moved();
    const target = perBotLocalVmTarget("s5-vm");
    const labels = { [MANAGED_LABEL]: "1", [DRIVER_LABEL]: CUA_DRIVER_VERSION, [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST, [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION, [TARGET_LABEL]: target.label, [WORKSPACE_LABEL]: "1" };
    let source = join(old, "vm-homes", target.workspaceDir.split(/[\\/]/).at(-1)!);
    const run: CommandRunner = async (command, args) => {
      if (command.endsWith("which")) { if (args[0] === "docker") return { stdout: "docker" }; throw new Error("not installed"); }
      if (args[0] === "info") return { stdout: "29" };
      if (args[0] === "image") return { stdout: JSON.stringify([{ Id: "sha256:s5", Config: { Labels: labels } }]) };
      if (args[0] === "inspect") return { stdout: JSON.stringify([{ Config: { Image: IMAGE, Labels: labels }, Image: "sha256:s5", State: { Running: false }, Mounts: [{ Type: "bind", Source: source, Destination: VM_WORKSPACE_GUEST, RW: true }] }]) };
      throw new Error("unexpected command");
    };
    expect((await containerComputerStatus(run, "linux", target)).workspaceMoved).toBe(true);
    source += "-someone-else";
    expect((await containerComputerStatus(run, "linux", target)).workspaceMoved).toBe(false);
  });

  it("site 22 refuses an invalid destination before removing the old owned VM", async () => {
    moved();
    const target=perBotLocalVmTarget("s5-vm-invalid-target");
    mkdirSync(join(DATA_DIR,"vm-homes"),{recursive:true});writeFileSync(target.workspaceDir,"preserve");
    const labels={ [MANAGED_LABEL]:"1",[DRIVER_LABEL]:CUA_DRIVER_VERSION,[BASE_IMAGE_LABEL]:BASE_IMAGE_DIGEST,[IMAGE_LAYER_LABEL]:IMAGE_LAYER_VERSION,[TARGET_LABEL]:target.label,[WORKSPACE_LABEL]:"1" };
    let removed=false;
    const run: CommandRunner=async(command,args)=>{
      if(command.endsWith("which")){if(args[0]==="docker")return{stdout:"docker"};throw Error("not installed");}
      if(args[0]==="info")return{stdout:"29"};
      if(args[0]==="image")return{stdout:JSON.stringify([{Id:"sha256:s5",Config:{Labels:labels}}])};
      if(args[0]==="inspect"){if(removed)throw Error("not found");return{stdout:JSON.stringify([{Config:{Image:IMAGE,Labels:labels},Image:"sha256:s5",State:{Running:false},Mounts:[{Type:"bind",Source:join(old,"vm-homes",target.workspaceDir.split(/[\\/]/).at(-1)!),Destination:VM_WORKSPACE_GUEST,RW:true}]}])};}
      if(args[0]==="rm"){removed=true;return{stdout:""};}
      throw Error("unexpected command");
    };
    await expect(containerComputerAction("run",run,"linux",target)).rejects.toThrow();
    expect(removed).toBe(false);expect(readFileSync(target.workspaceDir,"utf8")).toBe("preserve");
  });
});

it("site 19 preserves parsed receipts and reports a failed migration write", async () => {
  moved();
  const manifest = join(DATA_DIR, "s5-flux-write-failure.json"), name = "2026-11-13T04-00-00-000Z.456.backup";
  const original = JSON.stringify({ version: 1, tools: { opencode: { tool: "opencode", backupPath: join(old, "flux-connector-backups", "opencode", name), managedHash: "existing-hash" } } });
  writeFileSync(manifest, original);
  const atomic = await import("./atomic.ts"), real = atomic.writeFileAtomic;
  const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, bytes, options) => {
    if (path === manifest) throw Object.assign(new Error("fixture write denied"), { code: "EACCES" });
    return real(path, bytes, options);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(readConnectorManifest(manifest).tools.opencode).toMatchObject({ tool: "opencode", managedHash: "existing-hash", backupPath: join(DATA_DIR, "flux-connector-backups", "opencode", name) });
    expect(readFileSync(manifest, "utf8")).toBe(original);
    expect(warning).toHaveBeenCalledExactlyOnceWith("[flux-connector] Receipt migration could not be saved; valid receipts were retained.");
  } finally { write.mockRestore(); warning.mockRestore(); }
});
