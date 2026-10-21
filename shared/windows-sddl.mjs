// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DACL lines `icacls <path> /save <file>` writes, read as SIDs (locale-independent, unlike icacls' own listing). Used by the
// backup owner-only checks (electron/backup-windows-acl.mjs) and the browser sandbox grant (server/browser-sandbox.ts), so neither
// starts PowerShell (murage-releases #1).
//
// SDDL spells many accounts as two-letter aliases ("BA" Administrators, "SY" SYSTEM, "WD" Everyone); they are turned back into SIDs
// here so every comparison is by SID, never by name. An alias relative to a domain is that domain's SID plus the well-known RID, and the
// domain is the one Windows itself means, read from this computer's LSA policy by the engine-exclusion addon (domainSids): LA and LG
// (the local Administrator and Guest) this computer's own account domain; DA, DU, DG, ... the Active Directory domain it is joined to;
// EA, SA, RO and EK that domain's forest root, which can be another domain. Nothing is ever derived from the signed-in user's SID or
// put in for a domain that is not known (a workgroup computer has no joined domain): such an alias fails, with a plain sentence in
// `fix` (UNKNOWN_ACCOUNT_FIX) that the refusal shows the person.
export const SDDL_FIXED_SIDS={AA:"S-1-5-32-579",AC:"S-1-15-2-1",AN:"S-1-5-7",AO:"S-1-5-32-548",AS:"S-1-18-1",AU:"S-1-5-11",BA:"S-1-5-32-544",BG:"S-1-5-32-546",
 BO:"S-1-5-32-551",BU:"S-1-5-32-545",CD:"S-1-5-32-574",CG:"S-1-3-1",CO:"S-1-3-0",CY:"S-1-5-32-569",ED:"S-1-5-9",ER:"S-1-5-32-573",
 ES:"S-1-5-32-576",HA:"S-1-5-32-578",HI:"S-1-16-12288",IS:"S-1-5-32-568",IU:"S-1-5-4",LS:"S-1-5-19",LU:"S-1-5-32-559",LW:"S-1-16-4096",
 ME:"S-1-16-8192",MP:"S-1-16-8448",MS:"S-1-5-32-577",MU:"S-1-5-32-558",NO:"S-1-5-32-556",NS:"S-1-5-20",NU:"S-1-5-2",OW:"S-1-3-4",
 PO:"S-1-5-32-550",PS:"S-1-5-10",PU:"S-1-5-32-547",RA:"S-1-5-32-575",RC:"S-1-5-12",RD:"S-1-5-32-555",RE:"S-1-5-32-552",RM:"S-1-5-32-580",
 RU:"S-1-5-32-554",SI:"S-1-16-16384",SO:"S-1-5-32-549",SS:"S-1-18-2",SU:"S-1-5-6",SY:"S-1-5-18",UD:"S-1-5-84-0-0-0-0-0",WD:"S-1-1-0",WR:"S-1-5-33"};
/** Relative to the Active Directory domain this computer is joined to. */
export const SDDL_DOMAIN_RIDS={DA:512,DU:513,DG:514,DC:515,DD:516,CA:517,PA:520,CN:522,AP:525,KA:526,RS:553};
/** Relative to the forest root domain of that domain (Enterprise Read-only DCs, Schema Admins, Enterprise Admins, Enterprise Key Admins). */
export const SDDL_FOREST_RIDS={RO:498,SA:518,EA:519,EK:527};
/** Relative to this computer's own account domain. */
export const SDDL_MACHINE_RIDS={LA:500,LG:501};
// Every rights code SDDL defines for a DACL: generic, standard, file, the object-specific bits by their directory-service names (icacls
// writes them for a file right with no file name: ProgramData's "DCLCRPCR" is add-file, add-folder, write-EA and delete-child... as
// raw bits 0x2, 0x4, 0x10, 0x100), and registry. A code outside this list fails closed.
const SDDL_RIGHTS={GR:0x80000000,GW:0x40000000,GX:0x20000000,GA:0x10000000,RC:0x20000,SD:0x10000,WD:0x40000,WO:0x80000,FA:0x1f01ff,FR:0x120089,FW:0x120116,FX:0x1200a0,
 CC:0x1,DC:0x2,LC:0x4,SW:0x8,RP:0x10,WP:0x20,DT:0x40,LO:0x80,CR:0x100,KA:0xf003f,KR:0x20019,KW:0x20006,KX:0x20019};
const SDDL_ACE_FLAGS=new Set(["CI","OI","NP","IO","ID","SA","FA"]);
const DOMAIN_SID=/^S-1-5-21-\d+-\d+-\d+$/;
/** The sentence a refusal for an account Murage cannot identify shows the person (backup and browser-sandbox privacy checks). */
export const UNKNOWN_ACCOUNT_FIX="Windows lists an account on this file that Murage cannot identify. Open the file's Properties, Security tab, remove that entry, and try again, or choose a file inside your own user folder.";
export const aclFail=(fix)=>Object.assign(Error("BACKUP_WINDOWS_ACL_FAILED"),fix?{fix}:{});
const unresolved=(alias)=>Object.assign(aclFail(UNKNOWN_ACCOUNT_FIX),{alias:String(alias).slice(0,64)});
const domainOf=(sid)=>typeof sid==="string"&&DOMAIN_SID.test(sid)?sid:null;

/** One SDDL account (an S-1-… SID or an alias) as a SID. `domains` is the addon's domainSids() ({ account, primary, forestRoot });
 * without it only numeric SIDs and the fixed aliases resolve. */
export function sddlSid(text,{domains=null}={}){
 if(/^S-1-\d+(?:-\d+)+$/.test(text))return text;
 if(Object.hasOwn(SDDL_FIXED_SIDS,text))return SDDL_FIXED_SIDS[text];
 const relative=[[SDDL_MACHINE_RIDS,"account"],[SDDL_DOMAIN_RIDS,"primary"],[SDDL_FOREST_RIDS,"forestRoot"]].find(([rids])=>Object.hasOwn(rids,text));
 if(relative){const domain=domainOf(domains?.[relative[1]]);if(domain)return `${domain}-${relative[0][text]}`;}
 throw unresolved(text);
}
/** One SDDL rights field ("FA", "GRGX", "0x1200a9") as an access mask. */
export function sddlMask(text){
 if(/^0x[0-9a-fA-F]{1,8}$/.test(text))return Number.parseInt(text.slice(2),16)>>>0;
 if(!/^(?:[A-Z]{2})+$/.test(text))throw aclFail();
 let mask=0;
 for(const code of text.match(/../g)){if(!Object.hasOwn(SDDL_RIGHTS,code))throw aclFail();mask|=SDDL_RIGHTS[code];}
 return mask>>>0;
}
/** Parses one DACL line ("D:PAI(A;OICIID;FA;;;BA)…") into { owner: null, protected, rules: [{ allow, sid, mask, inherited,
 * inheritOnly }] } in the file's order. `domains` (the addon's domainSids()) resolves the domain-relative aliases. Anything it does not
 * recognise (an alias, a right, an ACE type, a missing DACL) fails closed. */
export function parseSddlAcl(sddl,{domains=null}={}){
 const match=/^D:((?:P|AI|AR)*)((?:\([^()]*\))+)(?:S:.*)?$/.exec(String(sddl).trim());
 if(!match)throw aclFail();
 const rules=[...match[2].matchAll(/\(([^()]*)\)/g)].map(entry=>{
  const parts=entry[1].split(";");
  if(parts.length!==6||parts[3]!==""||parts[4]!==""||(parts[0]!=="A"&&parts[0]!=="D"))throw aclFail();
  const flags=parts[1].match(/../g)??[];
  if(flags.join("")!==parts[1]||!flags.every(flag=>SDDL_ACE_FLAGS.has(flag)))throw aclFail();
  return{allow:parts[0]==="A",sid:sddlSid(parts[5],{domains}),mask:sddlMask(parts[2]),inherited:flags.includes("ID"),inheritOnly:flags.includes("IO")};
 });
 return{owner:null,protected:match[1].includes("P"),rules};
}
/** What icacls /save wrote, as [{ name, sddl }]: UTF-16LE (with or without a byte order mark) or UTF-8, a name line then its SDDL line
 * for each file (one pair, or one per file with /T). Names are relative and never hold ":", so a line that starts "D:" and then
 * flags or "(" is a DACL. */
export function savedAclEntries(bytes){
 const buffer=Buffer.from(bytes);
 const text=(buffer.length>1&&((buffer[0]===0xff&&buffer[1]===0xfe)||buffer[1]===0)?buffer.toString("utf16le"):buffer.toString("utf8")).replace(/^﻿/,"");
 const lines=text.split(/\r?\n/).filter(line=>line.trim()!=="");
 if(lines.length<2||lines.length%2!==0)throw aclFail();
 const out=[];
 for(let i=0;i<lines.length;i+=2){
  const sddl=lines[i+1].trim();
  if(!/^D:(?:P|AI|AR)*\(/.test(sddl)||/^D:(?:P|AI|AR)*\(/.test(lines[i].trim()))throw aclFail();
  out.push({name:lines[i].trim(),sddl});
 }
 return out;
}
