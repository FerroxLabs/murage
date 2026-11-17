import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";

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

function windowsExecutableIdentity(value){
  return typeof value==="string"&&win32.isAbsolute(value)&&!/["\x00-\x1f\x7f]/.test(value)?value.toLowerCase():null;
}
function namedWindowsLoginEnabled(value,name,executable,args){
  const items=value?.launchItems;
  if(!Array.isArray(items)||!items.every(item=>item&&typeof item==="object"&&!Array.isArray(item)&&typeof item.name==="string"&&typeof item.path==="string"&&Array.isArray(item.args)&&item.args.every(arg=>typeof arg==="string")&&["user","machine"].includes(item.scope)&&typeof item.enabled==="boolean"))return false;
  const matches=items.filter(item=>item.name===name);
  if(matches.length!==1)return false;
  const item=matches[0];
  return item.scope==="user"&&item.enabled===true&&windowsExecutableIdentity(item.path)===windowsExecutableIdentity(executable)&&item.args.length===args.length&&item.args.every((arg,index)=>arg===args[index]);
}

const linuxEntry=(executable,args,marker)=>["[Desktop Entry]","Type=Application","Name=Murage",`Exec=${[executable,...args].map(desktopExecArgument).join(" ")}`,"Terminal=false","Hidden=false",marker,""].join("\n");
export function createBackgroundLogin({platform,app,installed,primaryProfile,profileDir,userDataDir,executable,autostartDir,previousProfileDirs=[]}){
  const identity=createHash("sha256").update(profileDir??"unavailable").digest("hex").slice(0,16);
  const args=[LOGIN_FLAG,"--murage-data-dir",profileDir??"","--murage-user-data",userDataDir];
  const windowsName=`Murage-${identity}`;
  // Electron43 launchItems uses Chromium GetArgs(), which otherwise omits switches.
  const windowsOptions={path:executable,args:["--",...args]};
  // Its lookup uses CommandLine::FromString(path), unlike the setter's raw path.
  const windowsReadOptions={path:`"${executable}"`,args:windowsOptions.args};
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
    if(platform==="win32"){
      if(!windowsExecutableIdentity(executable)||args.some(arg=>typeof arg!=="string"))return unavailable("This installation has no stable sign-in launch path.");
      const value=app.getLoginItemSettings(windowsReadOptions);
      // Legacy openAtLogin names the app ID; executableWillLaunchAtLogin aggregates
      // other profiles. Neither confirms this exact user-owned registration.
      return {supported:true,openAtLogin:namedWindowsLoginEnabled(value,windowsName,executable,args),wasOpenedAtLogin:value?.wasOpenedAtLogin===true,requiresApproval:false};
    }
    const value=app.getLoginItemSettings();
    // Electron 43 always emits executableWillLaunchAtLogin, false off Windows
    // (login_item_settings_converter.cc), so macOS trusts SMAppService status alone.
    return {supported:true,openAtLogin:value.openAtLogin===true,wasOpenedAtLogin:value.wasOpenedAtLogin===true,requiresApproval:value.status==="requires-approval"};
  };
  const api={read,
    async reconcile(){
      if(!installed||!profileDir||!Array.isArray(previousProfileDirs))return;
      for(const previous of previousProfileDirs.slice(0,4)){
        if(typeof previous!=="string"||!isAbsolute(previous)||previous===profileDir)continue;
        const oldId=createHash("sha256").update(previous).digest("hex").slice(0,16),oldArgs=[LOGIN_FLAG,"--murage-data-dir",previous,"--murage-user-data",userDataDir];
        if(platform==="linux"&&autostartDir){
          const prior=join(autostartDir,`murage-${oldId}.desktop`);
          let stat;try{stat=lstatSync(prior);}catch(error){if(error.code==="ENOENT")continue;throw error;}
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768||stat.uid!==process.getuid?.()||(stat.mode&0o022))throw Error("The previous sign-in entry changed. Review startup settings.");
          const text=readFileSync(prior,"utf8"),expected=linuxEntry(executable,oldArgs,`X-Murage-Profile=${oldId}`);
          if(text!==expected)throw Error("The previous sign-in entry changed. Review startup settings.");
          // An explicit current entry wins. Only a still-enabled, unchanged previous entry carries its setting.
          if(!existsSync(file)){await api.write(true);if(!read().openAtLogin)throw Error("Sign-in startup could not be updated.");}
          if(readFileSync(prior,"utf8")!==text)throw Error("The previous sign-in entry changed. Review startup settings.");
          unlinkSync(prior);
        }else if(platform==="win32"){
          const value=app.getLoginItemSettings(windowsReadOptions);
          if(!namedWindowsLoginEnabled(value,`Murage-${oldId}`,executable,oldArgs))continue;
          // An explicit current entry wins, including a disabled entry or a command this process does not own.
          const currentExists=value.launchItems.some(item=>item.name===windowsName);
          if(!currentExists){await api.write(true);if(!read().openAtLogin)throw Error("Sign-in startup could not be updated.");}
          app.setLoginItemSettings({openAtLogin:false,path:executable,args:["--",...oldArgs],name:`Murage-${oldId}`,enabled:false});
        }
      }
    },
    async write(enabled){
      if(typeof enabled!=="boolean")throw new Error("Sign-in startup must be on or off.");
      const state=read();if(!state.supported)throw new Error(state.reason);
      if(platform==="linux"){
        const current=linuxText();
        if(!enabled){if(current!==null)unlinkSync(file);return;}
        mkdirSync(autostartDir,{recursive:true,mode:0o700});
        const text=linuxEntry(executable,args,marker);
        const temporary=`${file}.${process.pid}.tmp`;
        writeFileSync(temporary,text,{mode:0o600,flag:"wx"});
        try{renameSync(temporary,file);}catch(error){unlinkSync(temporary);throw error;}
      }else app.setLoginItemSettings({openAtLogin:enabled,...(platform==="win32"?{...windowsOptions,name:windowsName,enabled}:{})});
    },
    launchedAtLogin:()=>{if(process.argv.includes(LOGIN_FLAG))return true;try{return read().wasOpenedAtLogin===true;}catch{return false;}},
  };
  return api;
}
