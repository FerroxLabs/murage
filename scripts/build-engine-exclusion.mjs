// Builds native/engine-exclusion/exclusion.c (N-API 9) for the platform it runs on, into dist-native/engine-exclusion/<platform>-<arch>/.
// macOS: both architectures with clang. Linux: gcc (or $CC), -Wall -Werror. Windows: cl.exe /MD, run inside the Visual Studio developer
// environment (the current one, or VsDevCmd found with vswhere, as scripts/build-fuigo-probe.mjs does); it links against an import
// library made here from the napi_* names the source uses, and the source resolves them in the host executable at load time.
// /MD matters: the addon keeps every Windows handle operation on handles it owns, but a static C runtime (/LD alone implies /MT) would
// still be a second runtime beside Node's.
// Headers: $NODE_HEADERS_DIR, else the include/node folder next to the running Node.
import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const HEADERS=["node_api.h","node_api_types.h","js_native_api.h","js_native_api_types.h"];
function developerEnvironment(env){
 const vswhere=path.join(env["ProgramFiles(x86)"]||"C:\\Program Files (x86)","Microsoft Visual Studio","Installer","vswhere.exe");
 if(!existsSync(vswhere))throw Error("ENGINE_EXCLUSION_MSVC_REQUIRED: Visual Studio C++ tools are required; none was installed here");
 const installation=execFileSync(vswhere,["-latest","-products","*","-requires","Microsoft.VisualStudio.Component.VC.Tools.x86.x64","-property","installationPath"]).toString().trim();
 const file=path.join(installation,"Common7","Tools","VsDevCmd.bat");
 if(!installation||!existsSync(file))throw Error("ENGINE_EXCLUSION_MSVC_REQUIRED: the Visual Studio developer environment is unavailable");
 return file;
}
/** The command to run an MSVC tool: directly when the shell already is a developer prompt, else through cmd.exe and VsDevCmd. */
export function msvcCommand(tool,args,{env=process.env,environmentFile}={}){
 if(env.VSCMD_ARG_TGT_ARCH==="x64")return {command:tool,args};
 const quote=value=>{if(!value||/[\r\n\x00"%!]/.test(value))throw Error("ENGINE_EXCLUSION_UNSAFE_ARGUMENT");return '"'+value+'"';};
 const file=environmentFile||developerEnvironment(env);
 return {command:env.ComSpec||"C:\\Windows\\System32\\cmd.exe",args:["/d","/s","/c","call "+quote(file)+" -arch=x64 -host_arch=x64 && "+tool+" "+args.map(quote).join(" ")],verbatim:true};
}
export function buildEngineExclusion({platform=process.platform,exec=execFileSync,env=process.env,environmentFile,headerDirectory=env.NODE_HEADERS_DIR||path.resolve(path.dirname(realpathSync(process.execPath)),"../include/node"),outputRoot=path.join(root,"dist-native/engine-exclusion")}={}){
 for(const name of HEADERS)if(!existsSync(path.join(headerDirectory,name)))throw Error("ENGINE_EXCLUSION_HEADERS_REQUIRED: "+headerDirectory+" has no "+name+" (set NODE_HEADERS_DIR)");
 const source=path.join(root,"native/engine-exclusion/exclusion.c"),text=readFileSync(source);
 const sourceSha256=createHash("sha256").update(text).digest("hex");
 const targets=platform==="darwin"?[["arm64","arm64"],["x64","x86_64"]]:[[process.arch,process.arch]];
 const outputs=[];
 for(const [arch,target] of targets){
  const directory=path.join(outputRoot,platform+"-"+arch);mkdirSync(directory,{recursive:true});
  const output=path.join(directory,"engine-exclusion.node");
  if(platform==="darwin"){
   exec("/usr/bin/xcrun",["clang","-std=gnu11","-O2","-Wall","-DNAPI_VERSION=9","-mmacosx-version-min=12.0","-arch",target,"-bundle","-undefined","dynamic_lookup","-I",headerDirectory,source,"-o",output],{timeout:120000,stdio:"inherit"});
   exec("/usr/bin/lipo",[output,"-verify_arch",target],{timeout:5000,stdio:"inherit"});
  }else if(platform==="linux"){
   exec(env.CC||"gcc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",headerDirectory,source,"-o",output],{timeout:120000,stdio:"inherit"});
  }else if(platform==="win32"){
   const names=[...new Set(text.toString("utf8").match(/\bnapi_[a-z0-9_]+(?=\()/g)||[])].sort();
   const def=path.join(directory,"node.def"),lib=path.join(directory,"node.lib");
   writeFileSync(def,"LIBRARY node.exe\nEXPORTS\n"+names.map(name=>"  "+name).join("\n")+"\n");
   const run=(tool,args,timeout)=>{const c=msvcCommand(tool,args,{env,environmentFile});exec(c.command,c.args,{timeout,stdio:"inherit",...(c.verbatim?{windowsVerbatimArguments:true}:{})});};
   run("lib.exe",["/nologo","/def:"+def,"/machine:"+(arch==="arm64"?"arm64":"x64"),"/out:"+lib],60000);
   run("cl.exe",["/nologo","/O2","/W3","/MD","/LD","/DNAPI_VERSION=9","/I"+headerDirectory,source,"/Fo"+path.join(directory,"exclusion.obj"),"/Fe"+output,"/link","/DELAYLOAD:node.exe","delayimp.lib","Advapi32.lib","Shell32.lib","Ole32.lib",lib],120000);
  }else throw Error("ENGINE_EXCLUSION_PLATFORM_UNSUPPORTED: "+platform);
  const receipt={version:1,target:platform+"-"+arch,napiVersion:9,sourceSha256,sha256:createHash("sha256").update(readFileSync(output)).digest("hex")};
  writeFileSync(path.join(directory,"build.json"),JSON.stringify(receipt,null,2)+"\n");outputs.push(receipt);
 }
 return outputs;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)buildEngineExclusion();
