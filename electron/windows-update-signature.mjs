// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows update's signature check, through the engine-exclusion addon's authenticode (WinVerifyTrust), set as the NSIS updater's
// verifyUpdateCodeSignature. electron-updater's own check starts PowerShell (Get-AuthenticodeSignature): an antivirus notice and a
// visible start (murage-releases #1). The vendored copy's default verifier no longer starts anything and refuses every update
// (scripts/patch-windows-signature-verifier.mjs), so an updater this check was not set on installs nothing.
//
// The rules are upstream's: the signature must be Valid, then a publisher name that is a distinguished name ("CN=..., O=...") must
// match the signer's subject on every attribute it names, and a plain name must equal the signer's common name. A check that cannot
// run refuses the update (signatureCheck "unavailable", update-errors.mjs); a signature that is not Valid, or is someone else's,
// is the "not signed by the application owner" answer.
import path from "node:path";
import {windowsNative} from "./windows-native.mjs";

const unavailable=(detail)=>Object.assign(new Error(`Windows signature verification unavailable: ${detail}`),{code:"ERR_UPDATER_INVALID_SIGNATURE",signatureCheck:"unavailable"});

/** An RFC 4514 / X.500 name ("CN=Ferrox Labs\, LLC, O=..." or with quoted values) as Map<KEY, value>; an empty Map when the text is
 * not a distinguished name at all (a plain publisher name such as "Ferrox Labs, LLC"). */
export function parseDistinguishedName(text){
 const out=new Map();
 const value=String(text??"");
 if(!/^\s*[A-Za-z][A-Za-z0-9.-]*\s*=/.test(value))return out;
 let i=0;
 const skip=()=>{while(i<value.length&&/\s/.test(value[i]))i++;};
 while(i<value.length){
  skip();
  const eq=value.indexOf("=",i);if(eq<0)return new Map();
  const key=value.slice(i,eq).trim().toUpperCase();if(!/^[A-Z][A-Z0-9.-]*$/.test(key))return new Map();
  i=eq+1;skip();
  let item="";
  if(value[i]==='"'){
   i++;
   while(i<value.length&&value[i]!=='"'){if(value[i]==="\\"&&i+1<value.length)i++;item+=value[i++];}
   if(value[i]!=='"')return new Map();
   i++;skip();
  }else{
   while(i<value.length&&!/[,;+]/.test(value[i])){if(value[i]==="\\"&&i+1<value.length)i++;item+=value[i++];}
   item=item.trim();
  }
  out.set(key,item);
  if(i<value.length){if(!/[,;+]/.test(value[i]))return new Map();i++;}
 }
 return out;
}

/** True when `names` (electron-builder's publisherName list) accepts a Valid signature by `signer` ({publisher, subject}). */
export function publisherMatches(names,signer){
 const subject=parseDistinguishedName(signer?.subject??"");
 const commonName=subject.get("CN")??signer?.publisher??"";
 for(const name of names){
  const wanted=parseDistinguishedName(name);
  if(wanted.size){if(subject.size&&[...wanted].every(([key,value])=>subject.get(key)===value))return true;}
  else if(typeof name==="string"&&name!==""&&name===commonName)return true;
 }
 return false;
}

/** The verifier NsisUpdater calls: `(publisherNames, file) => Promise<string | null>`; null accepts, a string refuses (upstream's
 * contract). `authenticode` is the addon's (a test seam). */
export function createWindowsUpdateVerifier({authenticode,logger=console}={}){
 return async(publisherNames,file)=>{
  if(typeof authenticode!=="function")throw unavailable("the native signature check is missing");
  if(typeof file!=="string"||!path.win32.isAbsolute(file))throw unavailable("the downloaded file has no usable path");
  let answer;
  try{answer=await authenticode(file);}catch(error){throw unavailable(error instanceof Error?error.message:String(error));}
  if(!answer||typeof answer.status!=="string")throw unavailable("the native signature check gave no answer");
  logger?.info?.(`Windows signature check: ${answer.status} by ${answer.publisher||"(no signer)"}`);
  if(answer.status!=="Valid")return `the signature is ${answer.status} (code ${answer.code})`;
  const names=Array.isArray(publisherNames)?publisherNames:[publisherNames];
  if(publisherMatches(names,answer))return null;
  return `publisherNames: ${names.join(" | ")}, signed by: ${answer.subject||answer.publisher}`;
 };
}

/** Windows: puts the native check on the updater. Without the addon the updater keeps the vendored default, which refuses. */
export function installWindowsUpdateVerifier(autoUpdater,{platform=process.platform,native=windowsNative(),logger}={}){
 if(platform!=="win32"||!autoUpdater||typeof native?.authenticode!=="function")return false;
 autoUpdater.verifyUpdateCodeSignature=createWindowsUpdateVerifier({authenticode:file=>native.authenticode(file),logger:logger??autoUpdater.logger});
 return true;
}
