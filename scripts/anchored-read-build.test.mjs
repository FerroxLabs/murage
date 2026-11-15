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
    expect(ANCHORED_RESOURCE_PROBE).toContain("addon.read(fs.realpathSync(root)");
    expect(ANCHORED_RESOURCE_PROBE).toContain("finally { fs.rmSync(root");
  } finally {removeTempDirSync(root);}
});

it("the frozen error class loads in the server's real strip-only TypeScript runtime", async () => {
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    "import { AnchoredReadRefused } from './server/highlevel/anchored-read.ts'; const error = new AnchoredReadRefused('link'); if (error.code !== 'link' || !(error instanceof Error)) process.exit(1); console.log('strip-safe');"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
  expect(output.trim()).toBe("strip-safe");
});
