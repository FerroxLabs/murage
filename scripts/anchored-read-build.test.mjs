import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { buildAnchoredRead } from "./build-anchored-read.mjs";
function fixture() {
  const headerDirectory = path.resolve("fixture headers"), outputRoot = path.resolve("fixture output");
  const files = new Map(), calls = [];
  for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"]) files.set(path.join(headerDirectory, name), name);
  files.set(path.join(headerDirectory, "node_version.h"), "#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 20\n#define NODE_PATCH_VERSION 0\n");
  const io = { existsSync: f => files.has(f), readFileSync: (f, e) => files.has(f) ? (e ? String(files.get(f)) : Buffer.from(files.get(f))) : readFileSync(f, e), writeFileSync: (f,s) => files.set(f,s), mkdirSync: () => {}, rmSync: f => files.delete(f) };
  const exec = (command,args) => { calls.push([command,args]); if(command === "/usr/bin/xcrun") files.set(args.at(-1),"Mach-O"); if(command === "cl.exe") files.set(args.find(a=>a.startsWith("/Fe")).slice(3),"PE"); };
  return { calls, files, options:{io,exec,headerDirectory,outputRoot,nodeVersion:"24.20.0",arch:"x64",env:{VSCMD_ARG_TGT_ARCH:"x64"}} };
}
it("builds both mac architectures with openat and verifies each machine", () => {
  const f=fixture(); expect(buildAnchoredRead({...f.options,platform:"darwin"}).map(r=>r.target)).toEqual(["darwin-arm64","darwin-x64"]);
  expect(f.calls.map(c=>c[0])).toEqual(["/usr/bin/xcrun","/usr/bin/lipo","/usr/bin/xcrun","/usr/bin/lipo"]);
  expect(f.calls[0][1]).toContain("-std=gnu11"); expect(f.calls[0][1]).toContain("-Werror"); expect(f.calls[0][1].join(" ")).toContain("anchored-posix.c");
});
it("builds Windows C11 with static runtime and all common N-API imports", () => {
  const f=fixture(); expect(buildAnchoredRead({...f.options,platform:"win32"}).map(r=>r.target)).toEqual(["win32-x64"]);
  expect(f.calls.map(c=>c[0])).toEqual(["lib.exe","cl.exe"]); expect(f.calls[1][1]).toEqual(expect.arrayContaining(["/std:c11","/MT","/DELAYLOAD:node.exe"]));
  const def=[...f.files].find(([name])=>name.endsWith("node.def"))[1];
  for(const name of ["napi_create_arraybuffer","napi_get_value_string_utf16","napi_is_exception_pending","napi_call_function"]) expect(def).toContain(name);
  expect(()=>buildAnchoredRead({...f.options,platform:"win32",arch:"arm64"})).toThrow("ARCH_UNSUPPORTED");
});
it("links the Windows host hook and binds it into the source receipt", () => {
  const f = fixture();
  const [receipt] = buildAnchoredRead({...f.options, platform:"win32"});
  const hook = path.resolve(import.meta.dirname, "../native/anchored-read/host-hook.c");
  expect(f.calls[1][1]).toContain(hook);
  const source = ["anchored-win.c", "common.h", "host-hook.c"].map(name =>
    readFileSync(path.resolve(import.meta.dirname, "../native/anchored-read", name), "utf8")).join("");
  expect(receipt.sourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
  f.files.set(hook, readFileSync(hook, "utf8") + "\n/* changed hook */\n");
  expect(buildAnchoredRead({...f.options, platform:"win32"})[0].sourceSha256).not.toBe(receipt.sourceSha256);
  const mac = fixture();
  buildAnchoredRead({...mac.options, platform:"darwin"});
  expect(mac.calls.flatMap(c => c[1])).not.toContain(hook);
});
it("refuses mismatched headers and clears stale output before compilation", () => {
  const f=fixture(); expect(()=>buildAnchoredRead({...f.options,platform:"darwin",nodeVersion:"0.0.0"})).toThrow("HEADER_VERSION_MISMATCH");
  const output=path.join(f.options.outputRoot,"win32-x64","anchored-read.node"),receipt=path.join(f.options.outputRoot,"win32-x64","build.json");f.files.set(output,"old");f.files.set(receipt,"old");
  expect(()=>buildAnchoredRead({...f.options,platform:"win32",exec:()=>{throw Error("compiler failure");}})).toThrow("compiler failure");
  expect(f.files.has(output)).toBe(false);expect(f.files.has(receipt)).toBe(false);
});

it("packaged smoke uses the supplied target executable and fails on a missing or bad receipt", async () => {
  const fs = await import("node:fs"), os = await import("node:os");
  const { proveAnchoredReadResource, ANCHORED_RESOURCE_PROBE } = await import("./anchored-read-resource.mjs");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"anchored-packaging-test-")), file=path.join(root,"anchored-read.node");
  try {
    expect(()=>proveAnchoredReadResource(file,"target",()=>"PASS")).toThrow();
    fs.writeFileSync(file,Buffer.alloc(1024));
    let calls=0;
    expect(proveAnchoredReadResource(file,"target",(command,args,options)=>{
      calls++;expect(command).toBe("target");expect(args).toEqual(["-e",ANCHORED_RESOURCE_PROBE,file]);expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
      return "PASS T-A12 packaged.anchoredAddonLoads win32-x64\n";
    })).toBe("PASS T-A12 packaged.anchoredAddonLoads win32-x64");
    expect(calls).toBe(1);
    expect(()=>proveAnchoredReadResource(file,"target",()=>"PASS")).toThrow("PROOF_FAILED");
    expect(()=>proveAnchoredReadResource(file,"target",()=>{throw Error("native load failed");})).toThrow("native load failed");
    expect(ANCHORED_RESOURCE_PROBE).toContain("addon.read(fs.realpathSync.native(root)");
    expect(ANCHORED_RESOURCE_PROBE).toContain("finally { fs.rmSync(root");
  } finally {removeTempDirSync(root);}
});

// 1.0.20 hlstrip: the error class lived in server/highlevel/anchored-read.ts, removed with Murage's own HighLevel.

it("restores the Windows attack after the native held-directory handle closes", async () => {
  const { swapAndRestoreHook } = await import('./anchored-read-swap.mjs');
  let held = false, linked = false, open = true;
  const fs = {
    renameSync(from) {
      if (from.endsWith('held')) {
        if (open) throw Object.assign(Error('held handle'), {code:'EPERM'});
        held = false;
      } else { held = true; }
    },
    symlinkSync() { linked = true; },
    unlinkSync() { expect(linked).toBe(true); linked = false; },
  };
  const attack = swapAndRestoreHook(fs, '/fixture', '/outside', 'dir', 'win32');
  attack.step({kind:'dir'}); expect(held && linked).toBe(true);
  attack.step({kind:'file'}); expect(held).toBe(true); expect(linked).toBe(false);
  attack.step({kind:'read'}); expect(held).toBe(true);
  open = false; attack.restore(); expect(held).toBe(false);
  const failure = swapAndRestoreHook({...fs,renameSync(){throw Object.assign(Error('unexpected'),{code:'EIO'});}}, '/fixture', '/outside', 'root', 'win32');
  expect(() => failure.step({kind:'root'})).toThrow('unexpected');
});

it("uses the physical filesystem and native canonical root in packaged Electron", async () => {
  const { runInNewContext } = await import('node:vm');
  const nodePath = await import('node:path');
  const { ANCHORED_RESOURCE_PROBE } = await import('./anchored-read-resource.mjs');
  const reads = [], steps = ['root','dir','file','read'];
  const realpathSync = () => { throw Error('virtual filesystem path'); };
  realpathSync.native = () => '/physical/fixture';
  const fs = {realpathSync, mkdtempSync:()=>'/alias/fixture', mkdirSync(){}, writeFileSync(){},linkSync(){},rmSync(){}};
  const addon = {version:()=>1, read(root,parts,max,hook){
    reads.push(root); expect(root).toBe('/physical/fixture');
    if(parts[0]==='..')throw Object.assign(Error(),{code:'invalid_name'});
    if(parts[0]==='hardlink')throw Object.assign(Error(),{code:'hard_link'});
    steps.forEach(kind=>hook({kind}));
    return {bytes:Buffer.from('anchored-package-fixture'),size:24,volume:'1',fileId:'fixture'};
  }};
  const context = {Buffer, process:{versions:{electron:'fixture'},argv:['fixture','addon'],platform:'darwin',arch:'arm64'}, console:{log(){}},require(name){
    if(name==='original-fs')return fs;
    if(name==='node:os')return {tmpdir:()=>'/alias'};
    if(name==='addon')return addon;
    if(name==='node:path')return nodePath;
    if(name==='node:assert/strict')return {
      equal:(a,b)=>expect(a).toBe(b), ok:a=>expect(Boolean(a)).toBe(true),
      match:(a,b)=>expect(a).toMatch(b), deepEqual:(a,b)=>expect(JSON.stringify(a)).toBe(JSON.stringify(b)),
      throws:(fn,expected)=>{try{fn();}catch(error){expect(error.code).toBe(expected.code);return;}throw Error('expected refusal');},
    };
    throw Error(name);
  }};
  runInNewContext(ANCHORED_RESOURCE_PROBE, context);
  expect(reads).toHaveLength(3);
  addon.read = (root, parts, max, hook) => {
    hook({kind:'root'});
    throw Object.assign(Error('Anchored file read refused'), {code:'changed'});
  };
  try { runInNewContext(ANCHORED_RESOURCE_PROBE, {...context}); throw Error('expected native refusal'); }
  catch (error) {
    expect(error.code).toBe('changed');
    expect(error.message).toBe('Anchored file read refused (native checkpoints: root)');
  }
  addon.read = () => { throw Object.assign(Error('Anchored file read refused (phase=root.open errno=13)'), {code:'changed'}); };
  try { runInNewContext(ANCHORED_RESOURCE_PROBE, {...context}); throw Error('expected native refusal'); }
  catch (error) {
    expect(error.code).toBe('changed');
    expect(error.message).toBe('Anchored file read refused (phase=root.open errno=13) (native checkpoints: none)');
  }

});

// A Linux-only diagnostic unit: adapt SDK spellings, not macOS qualification.
// Compile the production reader and clobber errno in close() to prove that
// cleanup cannot replace the errno belonging to the failed operation.
it.skipIf(process.platform !== "linux")("reports the native refusal phase and saved errno without changing the guards", async () => {
  const fs = await import("node:fs"), os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anchored-diagnostic-"));
  try {
    const source = path.resolve(import.meta.dirname, "../native/anchored-read/anchored-posix.c");
    const adapter = path.join(root, "diagnostic.c"), binary = path.join(root, "diagnostic.node");
    fs.writeFileSync(adapter, `
#include <unistd.h>
#include <errno.h>
static int diagnostic_close(int fd) { int result = close(fd); errno = EBADF; return result; }
#define close diagnostic_close
#define O_NOFOLLOW_ANY 0
#define st_mtimespec st_mtim
#include ${JSON.stringify(source)}
`);
    const headers = path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../include/node");
    execFileSync("cc", ["-std=gnu11", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-I", headers, adapter, "-o", binary], { timeout: 30000 });
    const addon = createRequire(import.meta.url)(binary);
    const dir = path.join(root, "dir"), file = path.join(dir, "fixture");
    fs.mkdirSync(dir); fs.writeFileSync(file, "fixture");
    expect(Buffer.from(addon.read(root, ["dir", "fixture"], 64).bytes).toString()).toBe("fixture");
    const refusal = (read, code, phase, errno) => {
      let error;
      try { read(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`Anchored file read refused (phase=${phase} errno=${errno})`);
    };
    refusal(() => addon.read(path.join(root, "absent"), ["fixture"], 64), "changed", "root.open", os.constants.errno.ENOENT);
    refusal(() => addon.read(root, ["absent", "fixture"], 64), "changed", "dir.open", os.constants.errno.ENOENT);
    refusal(() => addon.read(root, ["dir", "absent"], 64), "changed", "file.open", os.constants.errno.ENOENT);
    fs.linkSync(file, path.join(root, "hardlink"));
    refusal(() => addon.read(root, ["hardlink"], 64), "hard_link", "file.verify", 0);
    fs.unlinkSync(path.join(root, "hardlink"));
    refusal(() => addon.read(root, ["dir", "fixture"], 64, step => {
      if (step.kind === "read") fs.appendFileSync(file, "changed");
    }), "changed", "read.verify", 0);
    const hookError = Error("fixture checkpoint refused");
    expect(() => addon.read(root, ["dir", "fixture"], 64, () => { throw hookError; })).toThrow(hookError);
  } finally { removeTempDirSync(root); }
});

it("never asks macOS for O_NOFOLLOW together with O_NOFOLLOW_ANY, and keeps every no-follow guard", () => {
  // xnu bsd/vfs/vfs_vnops.c vn_open_auth: `if ((fmode & O_NOFOLLOW_ANY) && (fmode & O_NOFOLLOW)) error = EINVAL`.
  // The packaged positive control failed on every root with that EINVAL, reported as the generic `changed`.
  const source = readFileSync(path.resolve(import.meta.dirname, "../native/anchored-read/anchored-posix.c"), "utf8")
    .replace(/\/\/[^\n]*/g, "");
  const calls = [...source.matchAll(/\b(open|openat)\(([^;]*)\);/g)].map(match => ({
    name: match[1], flags: new Set(match[2].match(/\bO_[A-Z_]+\b/g) ?? []),
  }));
  expect(calls.map(call => call.name)).toEqual(["open", "openat"]);
  for (const call of calls) expect(call.flags.has("O_NOFOLLOW") && call.flags.has("O_NOFOLLOW_ANY")).toBe(false);
  const [root, child] = calls;
  // Root: no link in any component (final included), a directory, read-only.
  expect([...root.flags].sort()).toEqual(["O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW_ANY", "O_RDONLY"]);
  // Each single-name descendant: never follow its own link; the last one must not block on a FIFO.
  expect([...child.flags].sort()).toEqual(["O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK", "O_RDONLY"]);
  expect(source).toContain("#error macOS SDK with O_NOFOLLOW_ANY is required");
  expect(source).toContain('errno == ELOOP ? "link"');
});
