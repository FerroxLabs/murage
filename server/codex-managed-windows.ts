import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { resolveCliSpawn } from "./env-path.ts";

export class ManagedNpmUnavailable extends Error {
  constructor(){super("Install Node.js (including npm), restart Murage, and try again. Your previous engine is unchanged.");}
}

/** Windows npm.cmd cannot be passed directly to execFile. Use the installed
 * Node distribution's npm entrypoint without cmd.exe, PowerShell or shell text. */
export async function windowsNpmCommand(args: string[]) {
  try {
  const node=resolveCliSpawn("node.exe",[]).command;
  if(!isAbsolute(node)||!node.toLowerCase().endsWith(".exe"))throw new Error("Node.js executable unavailable");
  const script=join(dirname(node),"node_modules","npm","bin","npm-cli.js");
  if(!(await lstat(script)).isFile())throw new Error("Node.js npm entrypoint unavailable");
  return {command:node,args:[script,...args]};
  } catch {throw new ManagedNpmUnavailable();}
}

/** npm verifies registry SRI while installing. Bind the native executable to
 * that exact-version lock entry and reject shims, aliases outside the owned
 * candidate tree, or the wrong executable architecture before --version. */
export async function verifiedWindowsCodexPath(candidate: string, version: string): Promise<string> {
  const key="node_modules/@openai/codex-win32-x64";
  const lock=JSON.parse(await readFile(join(candidate,"package-lock.json"),"utf8"));
  const entry=lock.packages?.[key];
  if(entry?.version!==`${version}-win32-x64`
    ||entry?.resolved!==`https://registry.npmjs.org/@openai/codex/-/codex-${version}-win32-x64.tgz`
    ||typeof entry?.integrity!=="string"||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity))throw new Error("Codex native package integrity unavailable");
  const packageRoot=join(candidate,key);
  const metadata=JSON.parse(await readFile(join(packageRoot,"package.json"),"utf8"));
  if(metadata.name!=="@openai/codex"||metadata.version!==entry.version
    ||!metadata.os?.includes("win32")||!metadata.cpu?.includes("x64"))throw new Error("Codex native package identity mismatch");
  const cli=join(packageRoot,"vendor","x86_64-pc-windows-msvc","bin","codex.exe");
  const stat=await lstat(cli),owned=await realpath(candidate),resolved=await realpath(cli),rel=relative(owned,resolved);
  if(!stat.isFile()||stat.isSymbolicLink()||rel.startsWith("..")||isAbsolute(rel))throw new Error("Codex executable outside managed candidate");
  const file=await open(cli,"r");
  try {
    const header=Buffer.alloc(64);await file.read(header,0,64,0);
    if(header.toString("ascii",0,2)!=="MZ")throw new Error("Codex executable is not PE");
    const offset=header.readUInt32LE(0x3c);
    if(offset<64||offset>1024*1024||offset+6>stat.size)throw new Error("Invalid Codex PE header");
    const pe=Buffer.alloc(6);await file.read(pe,0,6,offset);
    if(pe.toString("hex",0,4)!=="50450000"||pe.readUInt16LE(4)!==0x8664)throw new Error("Codex executable is not Windows x64");
  } finally {await file.close();}
  await writeFile(join(candidate,"managed-codex.json"),JSON.stringify({version,platform:"win32",arch:"x64",package:metadata.name,nativeVersion:metadata.version,resolved:entry.resolved,integrity:entry.integrity},null,2),{mode:0o600});
  return cli;
}
