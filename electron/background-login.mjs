import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const LOGIN_FLAG="--murage-login";
export function applyLoginProfileArguments(argv,env){
  if(!argv.includes(LOGIN_FLAG))return;
  for(const [flag,key] of [["--murage-data-dir","MURAGE_DATA_DIR"],["--murage-user-data","MURAGE_USER_DATA"]]){
    const index=argv.indexOf(flag);if(index<0)continue;
    if(argv.lastIndexOf(flag)!==index||!isAbsolute(argv[index+1]??""))throw new Error("Invalid Murage sign-in profile.");
    if(env[key]===undefined)env[key]=argv[index+1];
  }
}

/** Exec has two escaping passes: desktop-string unescape, then argv quoting. */
export function desktopExecArgument(value){
  if(typeof value!=="string"||/[\x00-\x1f\x7f]/.test(value))throw new Error("Unsupported sign-in path.");
  return `"${value.replaceAll("%","%%").replace(/[\\"`$]/g,"\\$&").replaceAll("\\","\\\\")}"`;
}

export function createBackgroundLogin({platform,app,installed,primaryProfile,profileDir,userDataDir,executable,autostartDir}){
  const identity=createHash("sha256").update(profileDir??"unavailable").digest("hex").slice(0,16);
  const args=[LOGIN_FLAG,"--murage-data-dir",profileDir??"","--murage-user-data",userDataDir];
  const windowsOptions={path:executable,args};
  const file=autostartDir?join(autostartDir,`murage-${identity}.desktop`):null;
  const marker=`X-Murage-Profile=${identity}`;
  const unavailable=reason=>({supported:false,openAtLogin:false,reason});
  const linuxText=()=>{
    if(!file||!existsSync(file))return null;
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw new Error("Sign-in entry is not a regular Murage-owned file.");
    const text=readFileSync(file,"utf8");if(!text.split(/\r?\n/).includes(marker))throw new Error("A different sign-in entry occupies this profile's startup location.");return text;
  };
  const read=()=>{
    if(!installed||!profileDir)return unavailable("Sign-in startup is available in the installed desktop app.");
    if(platform==="darwin"&&!primaryProfile)return unavailable("macOS sign-in startup is available for the primary Murage profile. This profile will not register a different installation.");
    if(platform==="linux"){
      if(!file||!isAbsolute(executable)||executable.includes("="))return unavailable("This installation has no stable sign-in launch path.");
      const text=linuxText();return {supported:true,openAtLogin:text!==null&&!/^Hidden=true$/m.test(text),wasOpenedAtLogin:false};
    }
    if(platform!=="darwin"&&platform!=="win32")return unavailable("Sign-in startup is unavailable on this platform.");
    const value=app.getLoginItemSettings(platform==="win32"?windowsOptions:undefined);
    return {supported:true,openAtLogin:value.openAtLogin===true&&value.executableWillLaunchAtLogin!==false,wasOpenedAtLogin:value.wasOpenedAtLogin===true,requiresApproval:value.status==="requires-approval"};
  };
  return {read,
    async write(enabled){
      if(typeof enabled!=="boolean")throw new Error("Sign-in startup must be on or off.");
      const state=read();if(!state.supported)throw new Error(state.reason);
      if(platform==="linux"){
        const current=linuxText();
        if(!enabled){if(current!==null)unlinkSync(file);return;}
        mkdirSync(autostartDir,{recursive:true,mode:0o700});
        const text=["[Desktop Entry]","Type=Application","Name=Murage",`Exec=${[executable,...args].map(desktopExecArgument).join(" ")}`,"Terminal=false","Hidden=false",marker,""].join("\n");
        const temporary=`${file}.${process.pid}.tmp`;
        writeFileSync(temporary,text,{mode:0o600,flag:"wx"});
        try{renameSync(temporary,file);}catch(error){unlinkSync(temporary);throw error;}
      }else app.setLoginItemSettings({openAtLogin:enabled,...(platform==="win32"?{...windowsOptions,name:`Murage-${identity}`,enabled}:{})});
    },
    launchedAtLogin:()=>{if(process.argv.includes(LOGIN_FLAG))return true;try{return read().wasOpenedAtLogin===true;}catch{return false;}},
  };
}
