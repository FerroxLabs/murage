// Reads the import tables (regular and delay-load) of a Windows PE file and refuses any DLL that is not a system DLL on an explicit
// allowlist. Pure JavaScript, no dependencies. Why: engine-exclusion.node was once built with /MD and imported VCRUNTIME140.dll, which a
// clean Windows machine lacks, so the addon failed to load there and every native feature failed closed. Every Windows native file
// Murage builds itself must carry its C runtime statically (/MT) and import only DLLs that ship with Windows.
// CLI: node scripts/windows-native-imports.mjs <file.node|file.exe>...   (exit 1 when any file imports a DLL outside the allowlist)
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

/** Lower-case DLL names (or prefixes ending in "-") that a self-built Windows native file may import. */
export const ALLOWED_IMPORT_DLLS=Object.freeze(["kernel32.dll","advapi32.dll","user32.dll","ole32.dll","oleaut32.dll","wintrust.dll","crypt32.dll","userenv.dll","ws2_32.dll","shell32.dll","node.exe"]);
/** UCRT forwarders ship with Windows 10+ (api-ms-win-crt-* and api-ms-win-core-*), not with an installer. */
export const ALLOWED_IMPORT_PREFIXES=Object.freeze(["api-ms-win-crt-","api-ms-win-core-"]);

export function isAllowedImport(name){
 const n=String(name).toLowerCase();
 if(ALLOWED_IMPORT_DLLS.includes(n))return true;
 return ALLOWED_IMPORT_PREFIXES.some(prefix=>n.startsWith(prefix)&&n.endsWith(".dll"));
}

/** The DLL names a PE image imports (regular table, then delay-load table), in file order, duplicates removed. Throws on a malformed image. */
export function peImportedDlls(value){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
 const need=(offset,length)=>{if(!Number.isInteger(offset)||offset<0||offset+length>bytes.length)throw Error("PE_IMPORTS_TRUNCATED");};
 need(0,0x40);
 if(bytes.readUInt16LE(0)!==0x5a4d)throw Error("PE_IMPORTS_NOT_PE");
 const lfanew=bytes.readUInt32LE(0x3c);
 need(lfanew,24);
 if(bytes.readUInt32LE(lfanew)!==0x00004550)throw Error("PE_IMPORTS_NOT_PE");
 const sectionCount=bytes.readUInt16LE(lfanew+6),optionalSize=bytes.readUInt16LE(lfanew+20),optional=lfanew+24;
 need(optional,optionalSize);
 const magic=bytes.readUInt16LE(optional);
 if(magic!==0x10b&&magic!==0x20b)throw Error("PE_IMPORTS_BAD_OPTIONAL_HEADER");
 const plus=magic===0x20b,directories=optional+(plus?112:96),count=bytes.readUInt32LE(directories-4);
 const imageBase=plus?Number(bytes.readBigUInt64LE(optional+24)):bytes.readUInt32LE(optional+28);
 const sections=[];
 need(optional+optionalSize,sectionCount*40);
 for(let i=0;i<sectionCount;i++){
  const at=optional+optionalSize+i*40;
  sections.push({virtualSize:bytes.readUInt32LE(at+8),virtualAddress:bytes.readUInt32LE(at+12),rawSize:bytes.readUInt32LE(at+16),rawPointer:bytes.readUInt32LE(at+20)});
 }
 const toOffset=rva=>{
  for(const s of sections){
   const span=Math.max(s.virtualSize,s.rawSize);
   if(rva>=s.virtualAddress&&rva<s.virtualAddress+span){const offset=s.rawPointer+(rva-s.virtualAddress);need(offset,1);return offset;}
  }
  throw Error("PE_IMPORTS_BAD_RVA");
 };
 const cString=rva=>{
  const start=toOffset(rva);let end=start;
  while(end<bytes.length&&bytes[end]!==0&&end-start<256)end++;
  if(end>=bytes.length||bytes[end]!==0)throw Error("PE_IMPORTS_BAD_NAME");
  return bytes.toString("latin1",start,end);
 };
 const names=[];
 const directory=index=>{
  if(index>=count)return null;
  need(directories+index*8,8);
  const rva=bytes.readUInt32LE(directories+index*8),size=bytes.readUInt32LE(directories+index*8+4);
  return rva?{rva,size}:null;
 };
 const regular=directory(1);
 if(regular){
  for(let at=toOffset(regular.rva),n=0;;at+=20,n++){
   need(at,20);
   if(n>4096)throw Error("PE_IMPORTS_TOO_MANY");
   if(bytes.readUInt32LE(at+12)===0&&bytes.readUInt32LE(at)===0&&bytes.readUInt32LE(at+16)===0)break;
   names.push(cString(bytes.readUInt32LE(at+12)));
  }
 }
 const delayed=directory(13);
 if(delayed){
  for(let at=toOffset(delayed.rva),n=0;;at+=32,n++){
   need(at,32);
   if(n>4096)throw Error("PE_IMPORTS_TOO_MANY");
   const attributes=bytes.readUInt32LE(at),name=bytes.readUInt32LE(at+4);
   if(attributes===0&&name===0)break;
   names.push(cString((attributes&1)?name:name-imageBase));
  }
 }
 return [...new Set(names)];
}

/** The imports of `value` that are not on the allowlist (empty when the image is safe to ship on a clean Windows machine). */
export function disallowedImports(value){
 return peImportedDlls(value).filter(name=>!isAllowedImport(name));
}

/** Throws ENGINE_NATIVE_IMPORTS_REFUSED naming every file that imports a DLL outside the allowlist; returns {file:[dlls]} when all pass. */
export function assertWindowsNativeImports(files,{read=readFileSync}={}){
 const report={},refused=[];
 for(const file of files){
  const imports=peImportedDlls(read(file));report[file]=imports;
  const bad=imports.filter(name=>!isAllowedImport(name));
  if(bad.length)refused.push(file+" imports "+bad.join(", "));
 }
 if(refused.length)throw Error("WINDOWS_NATIVE_IMPORTS_REFUSED: "+refused.join("; ")+" (build with the static C runtime, /MT; a clean Windows machine has no VC++ redistributable)");
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const files=process.argv.slice(2);
 if(!files.length){console.error("usage: windows-native-imports.mjs <file>...");process.exit(2);}
 let failed=false;
 for(const file of files){
  try{
   const imports=peImportedDlls(readFileSync(file)),bad=imports.filter(name=>!isAllowedImport(name));
   console.log((bad.length?"FAIL ":"ok   ")+file+": "+imports.join(", ")+(bad.length?"  <-- not allowed: "+bad.join(", "):""));
   if(bad.length)failed=true;
  }catch(error){console.log("FAIL "+file+": "+error.message);failed=true;}
 }
 process.exit(failed?1:0);
}
