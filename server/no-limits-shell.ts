// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Legacy bodies are frozen at int-A's pre-change tip 3b6e50f868 (MAIN r2.1).
import { segmentWordPaths,segmentWordCandidates } from './no-limits-word-paths.ts';
import { archiveWrites as archiveWritesOwnerNl } from './no-limits-archives.ts';
import { newContext, resolveFrom, normalizePath, candidatesOf, isAnchored, homeSpelled, UNKNOWN_MARK, type Candidate } from './shell/walk.ts';
import { lexWordText, Unreadable } from './shell/lex.ts';
import { ownerMarks, withoutDoubts } from './shell/marks.ts';
import { forEachSegment, type Segment, type SegmentResult, type SegmentScope } from './shell/segments.ts';
import { commandRoles } from './shell/roles.ts';
import { InspectionOverflow, type OwnerNlDecision } from './no-limits-authority.ts';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { protectedCwdSuffix } from './no-limits-cwd-suffix.ts';

export type CodeClass = "" | "root" | "home" | "system" | "disk" | "fork" | "cut" | "word";
export type Language = "sh" | "text" | "py" | "js";
export type Payload = [Language, string, number, string, (string | undefined)?];
export type Twin = [Language, string, string];
export const CLASS_ORDER: CodeClass[] = ["root", "home", "system", "disk", "fork", "word", "cut"];
export const best = (classes: CodeClass[]): CodeClass => CLASS_ORDER.find(c => classes.includes(c)) ?? "";
const set = (s: string) => new Set(s.split(/\s+/));
export const quote = (s: string): string => !s ? "''" : /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\"'\"'") + "'";
export const quoteTarget = (s: string): string => s.startsWith("$") ? `"${s}"` : quote(s);
export const joinPath = (parts: string[]): string => parts.reduce((out, p) => p.startsWith("/") || !out ? p : out.replace(/\/+$/, "") + "/" + p, "");
export function decodeAnsiC(text: string): string {
  const one: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
  return text.replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g, (_, body: string) => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (_, e: string) => {
    if (/[xuU]/.test(e[0]) && e.length > 1) { const p = parseInt(e.slice(1), 16); return p <= 0x10ffff ? String.fromCodePoint(p) : ""; }
    if (/[0-7]/.test(e[0])) return String.fromCharCode(parseInt(e, 8) & 255);
    if (e[0] === "c" && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 31);
    return one[e[0]] ?? e[0];
  }));
}
const DEV_OK = ["null", "zero", "random", "urandom", "stdin", "stdout", "stderr", "tty", "ptmx", "fd/", "pts/", "shm/"];
const DEVICE_SPELLINGS = ["physicaldrive", "harddisk", "\\\\.\\", "//./", "rdisk", ":(){", ":|:"];
export function namesDevice(s: string): boolean {
  for (let at = s.indexOf("/dev/"); at >= 0; at = s.indexOf("/dev/", at + 1)) {
    if (!DEV_OK.some(ok => s.slice(at + 5).startsWith(ok))) return true;
  }
  return false;
}
const folded = (s: string) => decodeAnsiC(s).normalize("NFKC").toLowerCase();
function formatSegments(text: string, quotes: string, seps: string): string[] {
  const out: string[] = []; let q = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = ""; }
    else if (quotes.includes(ch)) q = ch;
    else if (seps.includes(ch)) { out.push(text.slice(start, i)); start = i + 1; }
  }
  return [...out, text.slice(start)];
}
function formatIn(text: string, depth = 0): boolean {
  if (depth > 2) return false;
  for (const part of [...formatSegments(text, "'\"", ";&|\n"), ...formatSegments(text, '"', "&|\n")]) {
    const seg = part.trim(), words = seg ? seg.split(/\s+/) : [];
    if (words.length < 2) continue;
    const name = words[0].slice(Math.max(words[0].lastIndexOf("/"), words[0].lastIndexOf("\\")) + 1).toLowerCase().replace(/\.(com|exe)$/, "");
    if (name === "format" && /^[a-z]:[\\/]?$/i.test(words[1])) return true;
    if (["cmd", "powershell", "pwsh"].includes(name)) {
      for (let k = 1; k < words.length; k++) if (/^(\/[ck]|-(c|command))$/i.test(words[k])) {
        let inner = seg.replace(new RegExp("^(?:\\S+\\s+){" + (k + 1) + "}"), "").trim();
        if (inner.length >= 2 && "\"'".includes(inner[0]) && inner.at(-1) === inner[0]) inner = inner.slice(1, -1);
        if (k + 1 < words.length && formatIn(inner, depth + 1)) return true;
        break;
      }
    }
  }
  return false;
}
const WIPE = set("rm rmdir unlink shred srm dd mkfs newfs wipefs fdisk sfdisk parted gpart diskutil diskpart format-volume clear-disk remove-item ri del erase rd deltree rmtree rmsync rmdirsync unlinksync rimraf removedirs remove removefile deletefile removedirectory delete truncate");
const DELETE_OPTIONS = set("delete delete-after delete-before delete-during delete-excluded");
const RECURSE_AFTER = set("remove-item ri rm del rd gci get-childitem");
function partsOf(word: string): string[] {
  const out: string[] = []; let from = 0;
  while (true) {
    const eq = word.indexOf("=", from), value = word.slice(from); out.push(value);
    const base = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/\.exe$/i, "");
    if (base && base !== value) out.push(base);
    if (!value.startsWith("-")) break;
    const bare = value.replace(/^-+/, ""); if (bare) out.push(bare);
    if (eq < 0 || eq >= word.length - 1) break;
    from = eq + 1;
  }
  return out;
}
function wipeWords(s: string): boolean {
  let recurseArmed = false;
  for (const segment of s.split(/[;&|\n]/)) {
    let git = false;
    for (const word of segment.split(/[\s(){}<>,=:.[\]]+/)) {
      if (!word) continue;
      const parts = partsOf(word);
      if (parts.some(p => WIPE.has(p) || p.startsWith("mkfs") || DELETE_OPTIONS.has(p) || (git && p === "clean") || (recurseArmed && p === "recurse"))) return true;
      if (parts.includes("git")) git = true;
      if (parts.some(p => RECURSE_AFTER.has(p))) recurseArmed = true;
    }
  }
  return false;
}
export function plainWipe(text: string): boolean {
  const raw = folded(text);
  if (namesDevice(raw) || DEVICE_SPELLINGS.some(sp => raw.includes(sp)) || formatIn(raw)) return true;
  const s = raw.replace(/["'`\\]/g, "");
  if (namesDevice(s) || DEVICE_SPELLINGS.some(sp => s.includes(sp))) return true;
  return wipeWords(s) || wipeWords(raw.replace(/["'`]/g, "").replaceAll("\\", "/"));
}
export function targetFree(text: string): CodeClass {
  const raw = folded(text);
  if (raw.includes(":(){") || raw.includes(":|:")) return "fork";
  if (namesDevice(raw) || DEVICE_SPELLINGS.slice(0, 5).some(sp => raw.includes(sp)) || formatIn(raw)) return "disk";
  return /(?<![a-z0-9_])mkfs(\.[a-z0-9]+)?(?![a-z0-9_])/.test(raw) ? "disk" : "";
}
const SYSTEM = set("/applications /bin /boot /dev /etc /home /lib /lib32 /lib64 /library /opt /private /proc /root /sbin /srv /sys /system /users /usr /var");
// Python str.strip includes C0 separators and NEL; ECMAScript trim does not.
// eslint-disable-next-line no-control-regex -- oracle whitespace semantics.
const pythonTrim = (value: string): string => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
export function classifyPath(raw: string): CodeClass {
  let p = pythonTrim(raw); if (!p || p.includes("$MURAGE_U")) return "";
  p = p.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, "~").replaceAll("\\", "/");
  const drive = /^[a-z]:(\/.*)?$/i.exec(p);
  if (drive) {
    const rest = (drive[1] ?? "").replace(/(\/\*|\/\.)+$/, "").replace(/\/+$/, "").replace(/^\/+/, "").toLowerCase();
    if (!rest) return "root";
    if (["windows", "program files", "program files (x86)", "programdata", "users"].includes(rest)) return "system";
    return /^users\/[^/]+$/.test(rest) ? "home" : "";
  }
  p = p.replace(/\/{2,}/g, "/");
  while (true) { const next = p.replace(/\/\*$/, "").replace(/\/\.$/, "").replace(/(.)\/$/, "$1"); if (next === p) break; p = next; }
  if (p.startsWith("/")) {
    const out: string[] = [];
    for (const seg of p.split("/")) { if (!seg || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
    p = "/" + out.join("/");
  }
  if (["/", "/*", ""].includes(p)) return "root";
  if (p === "~" || /^~[A-Za-z0-9._-]+$/.test(p) || p === "~/*") return "home";
  if (/^\/(users|home)\/[^/]+$/.test(p.toLowerCase())) return "home";
  return SYSTEM.has(p.toLowerCase()) ? "system" : "";
}
const SHELLS = set("sh bash zsh dash ksh mksh fish");
const PREFIXES = set("sudo doas env command exec nohup time builtin xargs nice ionice stdbuf");
const DELETE = set("rm rmdir unlink shred srm truncate rimraf del erase rd deltree remove-item ri");
const DISK = set("mke2fs newfs wipefs diskutil format-volume clear-disk initialize-disk mknod diskpart fdisk sfdisk parted gpart");
function langOfProgram(name: string): Language | undefined {
  if (/^(python|pypy|py)(?:[0-9.]*w?|[0-9.]*[0-9](?:t|d|td)w?)$/.test(name)) return "py";
  if (["node", "nodejs", "bun", "deno"].includes(name)) return "js";
  return SHELLS.has(name) ? "sh" : undefined;
}
const basename = (s: string) => s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.(exe|cmd|com)$/, "");
function balancedBodies(text: string, opener: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf(opener); i >= 0; i = text.indexOf(opener, i + opener.length)) {
    let j = i + opener.length, depth = 1;
    while (j < text.length && depth) { if (text[j] === "(") depth++; else if (text[j] === ")") depth--; j++; }
    out.push(text.slice(i + opener.length, depth ? undefined : j - 1));
  }
  return out;
}
/** POSIX shlex with punctuation_chars=";&|()<>", whitespace=" \\t\\r", comments disabled. */
export function simpleCommands(text: string): string[][] | null {
  const tokens: string[] = []; let token = "", active = false, q = "";
  const flush = () => { if (active) tokens.push(token); token = ""; active = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = "";
      else if (c === "\\" && q === '"') {
        if (++i === text.length) return null;
        if (!["\\", '"'].includes(text[i])) token += "\\";
        token += text[i];
      } else token += c;
      continue;
    }
    if (" \t\r".includes(c)) { flush(); continue; }
    if (c === "'" || c === '"') { q = c; active = true; continue; }
    if (c === "\\") { if (++i === text.length) return null; token += text[i]; active = true; continue; }
    if (";&|()<>".includes(c)) {
      flush(); let p = c;
      while (i + 1 < text.length && ";&|()<>".includes(text[i + 1])) p += text[++i];
      tokens.push(p); continue;
    }
    token += c; active = true;
  }
  if (q) return null; flush();
  const commands: string[][] = []; let cur: string[] = [];
  for (const t of tokens) {
    if (t === "\n" || /^[;&|()]+$/.test(t)) { if (cur.length) commands.push(cur); cur = []; }
    else if (/^[<>]+$/.test(t)) cur.push(t);
    else for (const piece of t.split("\n")) {
      if (!piece && cur.length) { commands.push(cur); cur = []; } else if (piece) cur.push(piece);
    }
  }
  if (cur.length) commands.push(cur);
  return commands;
}
function stripPrefixes(words: string[]): string[] {
  let w = words.slice();
  while (w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue; }
    if (PREFIXES.has(basename(w[0]))) {
      w = w.slice(1); while (w.length && w[0].startsWith("-")) w = w.slice(/^-(n|u|g|c)$/.test(w[0]) ? 2 : 1);
      continue;
    }
    break;
  }
  return w;
}
function operands(words: string[], valued: Set<string>): string[] {
  const out: string[] = []; let opts = true;
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    if (opts && a === "--") opts = false;
    else if (opts && a.startsWith("-") && a !== "-") { if (valued.has(a)) i++; }
    else if (["<", ">", ">>", "<<", "<<<"].includes(a)) i++;
    else out.push(a);
  }
  return out;
}
export function readShell(source: string, depth: number, nested: Payload[], textMode = false, collected: CodeClass[] = []): [CodeClass, string] {
  const classes = collected, whys: string[] = [];
  const classStart = classes.length;
  const text = decodeAnsiC(source).replace(/\\(?=[A-Za-z0-9 ._()-])/g, "/");
  const tf = targetFree(text); if (tf) { classes.push(tf); whys.push("target-free " + tf); }
  const hd = new Map<string, string>();
  const stripped = text.replace(/<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n(.*?)\n[ \t]*\3[ \t]*(?=\n|$)/gs, (_m, _dash, _q, _name, body: string, offset: number) => {
    const key = `__HEREDOC_${offset}__`; hd.set(key, body); return " " + key;
  });
  for (const opener of ["$(", "<("]) for (const b of balancedBodies(stripped, opener)) nested.push(["sh", b, depth + 1, "subst"]);
  for (const m of stripped.matchAll(/`([^`]*)`/g)) nested.push(["sh", m[1], depth + 1, "backtick"]);
  let cmds = simpleCommands(stripped);
  if (!cmds) {
    if (!textMode) classes.push("cut");
    return [best(classes.slice(classStart)), whys.join("; ") || "tokenizer stop"];
  }
  if (textMode) cmds = cmds.flatMap(words => words.flatMap((w, k) => {
    const b = basename(w); return DELETE.has(b) || DISK.has(b) || b.startsWith("mkfs") || ["dd", "find", "rsync", "format"].includes(b) ? [words.slice(k)] : [];
  }));
  for (const words of cmds) {
    const w = stripPrefixes(words); if (!w.length) continue;
    const name = basename(w[0]), args = w.slice(1), lang = langOfProgram(name);
    const hop = (l: Language, s: string, how: string) => nested.push([l, s, depth + 1, how]);
    for (let k = 0; k < args.length; k++) {
      if (hd.has(args[k])) hop(lang ?? "text", hd.get(args[k])!, "heredoc");
      if (args[k] === "<<<" && k + 1 < args.length) hop(lang ?? "text", args[k + 1], "herestring");
    }
    for (let k = 0; k + 1 < args.length; k++) {
      const a = args[k];
      if ((lang === "sh" && /^-[a-z]*c[a-z]*$/.test(a)) || (lang === "py" && a === "-c") || (lang === "js" && ["-e", "--eval", "-p", "--print"].includes(a))) { hop(lang!, args[k + 1], a); break; }
    }
    if (name === "eval") hop("sh", args.join(" "), "eval");
    if (["cmd", "powershell", "pwsh"].includes(name)) for (let k = 0; k + 1 < args.length; k++) {
      if ((name === "cmd" ? ["/c", "/k"] : ["-c", "-command"]).includes(args[k].toLowerCase())) { hop("sh", args.slice(k + 1).join(" "), name + " -c"); break; }
    }
    if (DISK.has(name) || name.startsWith("mkfs") || (name === "format" && /^[a-z]:[\\/]?$/i.test(args[0] ?? ""))) { classes.push("disk"); whys.push(name); continue; }
    if (name === "dd") { for (const a of args) if (a.startsWith("of=") && namesDevice(a.slice(3).toLowerCase())) { classes.push("disk"); whys.push("dd of=device"); } continue; }
    let targets: string[] = [];
    if (DELETE.has(name)) targets = operands(args, ["truncate", "shred"].includes(name) ? set("-s --size -r --reference -n --iterations") : new Set());
    else if (name === "find" && args.includes("-delete")) { for (const a of args) { if (a.startsWith("-") || ["(", "!"].includes(a)) break; targets.push(a); } }
    else if (name === "rsync" && args.some(a => /^--del(e(t(e.*)?)?)?$/.test(a))) targets = operands(args, new Set()).slice(1);
    for (const t of targets) { const c = classifyPath(t); if (c) { classes.push(c); whys.push(name + " " + t); } }
  }
  return [best(classes.slice(classStart)), whys.join("; ")];
}

/** Quote-aware executable substitutions. Literal text is never queued as code. */
export function shellExecutables(source:string,depth:number,nested:Payload[]):string {
 const hd=new Map<string,{body:string;quoted:boolean}>();
 let text=source.replace(/<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g,(_m,_dash,q,_name,header,body,offset)=>{const key=`__HD_${offset}__`;hd.set(key,{body,quoted:!!q});return ' '+key+header+'\n';});
 const scan=(s:string,substitutions=true):string=>{
  let out='',q='';
  for(let i=0;i<s.length;i++){
   const c=s[i];
   if(c==='\\'&&q!=="'"){ // escaped substitution is literal, including its parentheses
    if(s[i+1]==='$'&&s[i+2]==='('){let j=i+3,n=1;for(;j<s.length&&n;j++){if(s[j]==='(')n++;if(s[j]===')')n--;}out+='__literal__';i=j-1;continue;}
    out+=c+(s[++i]??'');continue;
   }
   if(c===q){q='';out+=c;continue;}
   if(!q&&(c==="'"||c==='"')){q=c;out+=c;continue;}
   if(q==="'"){out+=c;continue;}
   if(!q&&c==='#'&&(i===0||/\s/.test(s[i-1]))){while(i<s.length&&s[i]!=='\n')i++;out+='\n';continue;}
   const op=s.startsWith('$(',i)||s.startsWith('<(',i);
   if(substitutions&&(op||c==='`')){
    const start=i+(op?2:1);let j=start,n=1,innerQ='';
    for(;j<s.length;j++){
     const x=s[j];if(x==='\\'){j++;continue;}
     if(innerQ){if(x===innerQ)innerQ='';continue;}
     if(x==="'"||x==='"'){innerQ=x;continue;}
     if(c==='`'){if(x==='`')break;}else {if(x==='(')n++;if(x===')'&&!--n)break;}
    }
    nested.push(['sh',s.slice(start,j),depth+1,'subst']);out+='__subst__';i=j;continue;
   }
   out+=c;
  }
  return out;
 };
 const stripped=scan(text);
 const cmds=simpleCommands(stripped)??[];
 for(const words of cmds){const w=stripPrefixes(words),lang=langOfProgram(basename(w[0]??''));for(const arg of w){const h=hd.get(arg);if(!h)continue;if(lang)nested.push([lang,h.body,depth+1,'heredoc']);else if(!h.quoted)scan(h.body);}}
 return stripped;
}
export function pathTargets(words:string[]):Array<{path:string;op:'read'|'write'|'delete'}>{
 const w=stripPrefixes(words),name=basename(w[0]??''),args=w.slice(1),out:Array<{path:string;op:'read'|'write'|'delete'}>=[];
 const add=(path:string,op:'read'|'write'|'delete')=>{if(path&&!path.startsWith('-')&&!path.startsWith('__'))out.push({path,op});};
 for(let i=0;i<args.length;i++){if(['>','>>','>|','&>','<>'].includes(args[i])){add(args[++i],'write');continue;}if(args[i]==='<'){add(args[++i],'read');continue;}if(name==='dd'&&args[i].startsWith('of='))add(args[i].slice(3),'write');}
 const operands_=operands(args,new Set(['-s','--size','-n','--iterations','-u','-g']));
 let op:'read'|'write'|'delete'='read';
 if(DELETE.has(name)||name==='find'&&args.includes('-delete'))op='delete';
 else if(['tee','chmod','chown','truncate','touch'].includes(name))op='write';
 for(let i=0;i<operands_.length;i++)add(operands_[i],['cp','mv','install','ln'].includes(name)&&i===operands_.length-1?'write':op);
 return out;
}
export function readShellExec(source:string,depth:number,nested:Payload[],collected:CodeClass[]=[]):[CodeClass,string]{
 const before=collected.length;
 const text=shellExecutables(decodeAnsiC(source),depth,nested),cmds=simpleCommands(text);
 const masked=text.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g,'');if(targetFree(masked)==='fork')collected.push('fork');
 if(!cmds){const tf=targetFree(source);if(tf)collected.push(tf);else if(plainWipe(source)){const found=/\b(?:rm|rmdir|unlink|shred)\s+(?:-[a-z]+\s+)*['"]?([/~][^\s'"]*)/i.exec(source);const cls=found?classifyPath(found[1]):'';collected.push(cls||'word');}return [best(collected.slice(before)),'unreadable'];}
 for(const words of cmds){
  const w=stripPrefixes(words);if(!w.length)continue;
  const name=basename(w[0]),args=w.slice(1),lang=langOfProgram(name);
  if(DISK.has(name)||name.startsWith('mkfs')||name==='format'&&/^[a-z]:[\\/]?$/i.test(args[0]??''))collected.push('disk');
  if(name==='dd'&&args.some(a=>a.startsWith('of=')&&namesDevice(a.slice(3))))collected.push('disk');
  for(const t of pathTargets(w)){if(t.op==='delete'){const c=classifyPath(t.path);if(c)collected.push(c);}if(t.op==='write'&&namesDevice(t.path))collected.push('disk');}
  for(let k=0;k<args.length-1;k++){
   if(lang&&((lang==='sh'&&/^-[a-z]*c[a-z]*$/.test(args[k]))||(lang==='py'&&args[k]==='-c')||(lang==='js'&&['-e','--eval','-p','--print'].includes(args[k])))) {nested.push([lang,args[k+1],depth+1,'interpreter']);break;}
   if(lang&&args[k]==='<<<')nested.push([lang,args[k+1],depth+1,'herestring']);
  }
  if(name==='eval')nested.push(['sh',args.join(' '),depth+1,'eval']);
  if(['cmd','powershell','pwsh'].includes(name))for(let k=0;k<args.length-1;k++)if((name==='cmd'?['/c','/k']:['-c','-command']).includes(args[k].toLowerCase())){nested.push(['sh',powerShellSource(args.slice(k+1).join(' ')),depth+1,'pwsh']);break;}
  if(name==='ssh'&&args.length>1)nested.push(['sh',args.slice(1).join(' '),depth+1,'ssh']);
 }
 return [best(collected.slice(before)),'exec'];
}

export function powerShellSource(source:string):string {return source.replace(/`(.)/g,(_all,next)=>'\\'+next).replace(/[a-z]:\\[^\s'"]*/ig,p=>p.replaceAll('\\','/'));}

/** Quote-aware executable segments. Owner-only streaming inspection. */
/** Owner cwd candidates pair logical PWD with physical directory identity. */
export interface ShellCwdCandidate {
 logical?:string;physical?:string;oldpwd?:{logical?:string;physical?:string};
 stack:Array<{logical?:string;physical?:string}>;unknownCause?:string;fixedPrefixes?:string[];
}
type Cwds=Array<string|undefined>;
export interface OwnerSegmentContext {
 segment:Segment;roles:ReturnType<typeof commandRoles>;cwds:Cwds;selected:Cwds;
 values:Array<string|undefined>;wordCandidates:Candidate[][];candidates:ShellCwdCandidate[];localCandidates:ShellCwdCandidate[];context:ReturnType<typeof newContext>;
}
const location=(c:ShellCwdCandidate)=>({logical:c.logical,physical:c.physical});
const cwdPaths=(candidates:ShellCwdCandidate[]):Cwds=>[...new Set(candidates.flatMap(c=>[c.physical??c.logical,...(c.fixedPrefixes??[])]))];
function boundCwds(values:ShellCwdCandidate[]):ShellCwdCandidate[]{
 const unique=[...new Map(values.map(c=>[JSON.stringify(c),c])).values()];
 if(unique.length<=16)return unique;
 return [...unique.slice(0,15),{stack:[],unknownCause:'cwd-candidate-overflow',fixedPrefixes:[...new Set(unique.flatMap(c=>[c.logical,c.physical,...(c.fixedPrefixes??[])].filter((p):p is string=>p!==undefined)))]}];
}
/** Resolve components before .., rather than normalizing a symlink away. Only
 * named components are probed; the filesystem is never scanned. */
function physicalCwd(path:string,realpath:(path:string)=>string):string|undefined{
 let resolved=path.startsWith('/')?'/':'';
 try{
  for(const part of path.split('/')){
   if(!part||part==='.')continue;
   if(part==='..'){resolved=normalizePath(resolved+'/..');continue;}
   resolved=realpath((resolved==='/'?'/':resolved+'/')+part).replaceAll('\\','/');
  }
  return resolved||'/';
 }catch{return undefined;}
}
function cwdMachine(cwd:string|Cwds|ShellCwdCandidate[]|undefined,dialect:'posix'|'pwsh',realpath:(path:string)=>string,bound?:ReturnType<typeof newContext>['bound']){
 const seed=Array.isArray(cwd)?cwd.length?cwd:[undefined]:[cwd];
 const initial:ShellCwdCandidate[]=seed.map(c=>typeof c==='object'&&c!==null?c:{logical:c,physical:c?physicalCwd(homeSpelled(c).replace(/^~(?=\/|$)/,homedir()),realpath):undefined,stack:[],...(!c?{unknownCause:'unknown-cwd'}:{})});
 interface ScopeState {current:ShellCwdCandidate[];groups:ShellCwdCandidate[][];before:ShellCwdCandidate[];local:ShellCwdCandidate[];weak:ShellCwdCandidate[];pipeline?:ShellCwdCandidate[];orSuccess?:ShellCwdCandidate[];context:ReturnType<typeof newContext>}
 const states=new Map<number,ScopeState>();
 const enter=(scope:SegmentScope)=>{
  const parent=scope.parent===undefined?undefined:states.get(scope.parent);
  const candidates=parent?(scope.via==='heredoc-code'?parent.local:parent.before):initial;
  const context=parent?{...parent.context,bound:new Map(parent.context.bound)}:newContext(cwdPaths(candidates)[0]);
  if(!parent&&bound)context.bound=new Map(bound);
  states.set(scope.id,{current:candidates,groups:[],before:candidates,local:candidates,weak:[],context});
 };
 const leave=(scope:SegmentScope)=>states.delete(scope.id);
 const row=(segment:Segment):OwnerSegmentContext=>{
  const state=states.get(segment.scope??0)!;
  if(segment.sep==='(')state.groups.push(state.current);
  const candidates=state.pipeline??state.current;
  for(const name of segment.unknownBindings??[])state.context.bound.set(name,null);
  for(const assignment of segment.assignments){
   const eq=assignment.raw.indexOf('=');
   try{state.context.bound.set(assignment.raw.slice(0,eq),[lexWordText(assignment.raw.slice(eq+1))]);}catch(error){if(!(error instanceof Unreadable))throw error;state.context.bound.set(assignment.raw.slice(0,eq),null);}
  }
  const wordCandidates=segment.words.map(word=>segmentWordCandidates(word,state.context));
  const values=segment.words.map((word,index)=>word.text??(wordCandidates[index]?.length===1&&wordCandidates[index]![0]!.kind==='literal'?wordCandidates[index]![0]!.path:undefined));
  const roles=commandRoles(values,dialect,segment.words);
  let localCandidates=candidates,changed:ShellCwdCandidate[]|undefined;
  if(roles.cwd){
   const directory=roles.cwd;
   let values=directory.home?[homedir()]:directory.value!==undefined?[directory.value]:[];
   let unknown=directory.value===undefined&&!directory.home;
   if(unknown&&directory.arg!==undefined){
    const word=segment.words[directory.arg];
    try{
     const candidates=word?ownerMarks(()=>withoutDoubts(()=>candidatesOf(lexWordText(word.raw),state.context))):[];
     values=candidates.filter(value=>value.kind==='literal').map(value=>value.path);
     unknown=!candidates.length||candidates.some(value=>value.kind!=='literal');
    }catch(error){if(!(error instanceof Unreadable))throw error;values=[];}
   }
   changed=[];
   for(const candidate of candidates){
    if(unknown||!values.length||directory.alternate){changed.push({stack:candidate.stack,oldpwd:location(candidate),unknownCause:directory.alternate?'alternate-directory-semantics':'unknown-directory'});if(!values.length||directory.alternate)continue;}
    for(const value of values){
     if(value==='-'&&roles.program==='cd'){
      changed.push(candidate.oldpwd?{...candidate.oldpwd,oldpwd:location(candidate),stack:candidate.stack}:{stack:candidate.stack,unknownCause:'unknown-oldpwd'});continue;
     }
     const spelled=homeSpelled(value).replace(/^~(?=\/|$)/,homedir());
     const base=directory.mode==='physical'?candidate.physical??candidate.logical:candidate.logical??candidate.physical;
     if(!isAnchored(spelled)&&!base){changed.push({stack:candidate.stack,oldpwd:location(candidate),unknownCause:'unknown-directory-base'});continue;}
     const joined=isAnchored(spelled)?spelled:`${base}/${spelled}`;
     const logical=normalizePath(joined);
     const physical=physicalCwd(directory.mode==='physical'?joined:logical,realpath);
     const nextLogical=directory.mode==='physical'?physical:logical;
     changed.push({logical:nextLogical,physical,oldpwd:location(candidate),stack:roles.program==='pushd'?[location(candidate),...candidate.stack].slice(0,32):candidate.stack,...(!physical?{unknownCause:'unresolved-physical-cwd'}:{})});
    }
   }
   changed=boundCwds(changed);localCandidates=changed;
  }
  if(roles.program==='popd'||roles.program==='pushd'&&(roles.cwd?.home||/^[+-]\d+$/.test(roles.cwd?.value??''))){
   const operand=roles.program==='pushd'?roles.cwd?.value:segment.words[1]?.text;
   changed=candidates.map(candidate=>{
    const chain=[location(candidate),...candidate.stack];
    const numeric=operand===undefined?(roles.program==='popd'?0:1):Number(operand.slice(1));
    const index=operand?.startsWith('-')?chain.length-1-numeric:numeric;
    if(!Number.isInteger(index)||index<0||index>=chain.length||chain.length<2)return {stack:candidate.stack,unknownCause:'unknown-directory-stack'};
    const rotated=roles.program==='popd'?chain.filter((_,at)=>at!==index):[...chain.slice(index),...chain.slice(0,index)];
    return {...rotated[0]!,oldpwd:location(candidate),stack:rotated.slice(1)};
   });
   localCandidates=changed;
  }
  let next=candidates;
  if(changed&&['cd','pushd','popd'].includes(roles.program)){
   if(segment.sep==='&&'){state.weak=boundCwds([...state.weak,...candidates]);next=changed;}
   else next=boundCwds([...candidates,...changed]);
   state.orSuccess=segment.sep==='||'?changed:undefined;
  }else if(['exit','return'].includes(roles.program)&&state.orSuccess){next=state.orSuccess;state.orSuccess=undefined;}
  if(!['&&','||'].includes(segment.sep)&&state.weak.length){next=boundCwds([...next,...state.weak]);state.weak=[];}
  state.before=candidates;state.local=localCandidates;
  if(['|','|&'].includes(segment.sep)){state.pipeline??=candidates;state.current=state.pipeline;}
  else if(state.pipeline){state.current=state.pipeline;state.pipeline=undefined;}
  else if(segment.sep!=='&')state.current=next;
  if(segment.sep===')')state.current=state.groups.pop()??initial;
  return {segment,roles,values,wordCandidates,candidates,localCandidates,cwds:cwdPaths(candidates),selected:cwdPaths(localCandidates),context:state.context};
 };
 return {enter,leave,row};
}
/** One streaming context path for recovery and authenticated owner readers. */
export function forEachOwnerSegment(source:string,cwd:string|Cwds|ShellCwdCandidate[]|undefined,visit:(row:OwnerSegmentContext)=>void,dialect:'posix'|'pwsh'='posix',realpath:(path:string)=>string=realpathSync.native,depth=0){
 const machine=cwdMachine(cwd,dialect,realpath);
 let bytes=9*source.length+1;
 const handle=(row:OwnerSegmentContext,level:number)=>{
  visit(row);
  for(const nested of row.roles.nested??[]){
   let local=row.localCandidates;
   if(nested.cwd==='unknown')local=[{stack:[],unknownCause:'execdir'}];
   else if(typeof nested.cwd==='object'){
    const archive=row.roles.archive!;
    const roots=new Map<number,string[]>([[-1,row.selected.map(base=>base??'$PWD')]]);
    const root=(index:number):string[]=>{
     if(roots.has(index))return roots.get(index)!;
     const chain:number[]=[];let at=index;
     while(!roots.has(at)){chain.push(at);at=archive.slots[at]!.root??-1;}
     for(let i=chain.length-1;i>=0;i--){
      const next=chain[i]!,slot=archive.slots[next]!;
      const values=slot.value===undefined?[]:[slot.value];
      roots.set(next,roots.get(slot.root??-1)!.flatMap(base=>values.map(value=>isAnchored(homeSpelled(value))?value:resolveFrom(base,value))));
     }
     return roots.get(index)!;
    };
    local=root(nested.cwd.rootSlot).map(logical=>({logical,physical:physicalCwd(logical,realpath),stack:[]}));
    if(!local.length)local=[{stack:[],unknownCause:'unknown-program-root'}];
   }
   if(nested.words)inspectWords(nested.words,local,level+1,row.context.bound);
   else if(nested.text!==undefined)inspect(nested.text,local,level+1);
  }
 };
 const charge=(cost:number)=>{if(cost>bytes)throw new InspectionOverflow('nested shell inspection overflow');bytes-=cost;};
 const inspectWords=(words:Segment['words'],initial:ShellCwdCandidate[],level:number,bound:ReturnType<typeof newContext>['bound'])=>{
  charge(words.reduce((cost,word)=>cost+word.raw.length+1,0));
  const state=cwdMachine(initial,dialect,realpath,bound);
  const scope={id:0,source:'',depth:Math.min(8,level),via:'find-exec' as const};
  state.enter(scope);
  // find executes argv directly. Re-lexing it as shell source would lose raw
  // UNKNOWN prefixes and could execute substitutions or reserved words twice.
  handle(state.row({reserved:[],assignments:[],words,redirects:[],sep:'eof',depth:scope.depth,via:'find-exec',group:0,scope:0}),level);
  state.leave(scope);
 };
 const inspect=(text:string,initial:string|Cwds|ShellCwdCandidate[]|undefined,level:number)=>{
  charge(text.length);
  const state=level===depth?machine:cwdMachine(initial,dialect,realpath);
  forEachSegment(text,segment=>handle(state.row(segment),level),{dialect,command:words=>commandRoles(words,dialect),maxDepth:Math.max(0,8-level),onScope:state.enter,onScopeEnd:state.leave});
 };
 inspect(source,cwd,depth);
}
/** Array projection retained for diagnostics/tests, never executable policy. */
export function segmentContexts(result:SegmentResult,cwd?:string|Cwds,dialect:'posix'|'pwsh'='posix'){
 const machine=cwdMachine(cwd,dialect,realpathSync.native),bases=new Map<number,Cwds>(),rows:OwnerSegmentContext[]=[];
 const scopes=new Map((result.scopes??[{id:0,source:'',depth:0}]).map(s=>[s.id,s]));
 const entered=new Set<number>();
 for(const segment of result.segments){const id=segment.scope??0;if(!entered.has(id)){machine.enter(scopes.get(id)!);entered.add(id);}const row=machine.row(segment);rows.push(row);bases.set(id,row.cwds);}
 return {rows,bases};
}
export interface OwnerShellTarget {path:string;op:'read'|'write'|'delete';decision?:OwnerNlDecision}
export function pathTargetsOwnerNl(words:Array<string|undefined>,cwd?:string,candidates?:Candidate[][],dialect:'posix'|'pwsh'='posix'):OwnerShellTarget[]{
 const roles=commandRoles(words,dialect),targets:OwnerShellTarget[]=[];
 const executable=roles.slots.filter(slot=>slot.detail===undefined&&(slot.role==='name'||slot.role==='command')).find(slot=>basename(slot.value??'')===roles.program)?.arg??0;
 const args=words.slice(executable+1);
 const archive=archiveWritesOwnerNl(roles.program,args.map(arg=>arg??''),candidates??args.map(path=>path===undefined?[]:[{kind:'literal' as const,text:path,path}]),cwd);
 if(archive!==undefined)for(const path of archive)targets.push({path,op:'write'});
 const deleting=DELETE.has(roles.program)||roles.program==='find'&&roles.slots.some(slot=>slot.key==='-delete');
 for(const slot of roles.slots){
  if(slot.detail!==undefined&&archive!==undefined||slot.value===undefined||slot.value.startsWith('__')||!['write','read'].includes(slot.role))continue;
  const arg=slot.arg-executable-1;
  const paths=candidates&&slot.value===args[arg]?.slice(slot.offset)?(candidates[arg]??[]).map(item=>item.path.replaceAll(UNKNOWN_MARK,'').slice(slot.offset)):[slot.value];
  for(const path of paths)if(path)targets.push({path,op:slot.role==='write'?deleting?'delete':'write':'read'});
 }
 return targets;
}
/** Shared streaming inspection; nested writes join the parent's evidence set. */
function inspectOwnerShell(source:string,depth:number,nested:Payload[],classes:CodeClass[],cwd?:string,dialect:'posix'|'pwsh'='posix'):OwnerShellTarget[]{
 const targets:OwnerShellTarget[]=[];
 let structure='',forkSeen=false;
 forEachOwnerSegment(source,cwd,row=>{
  const {segment,roles}=row;
  const words=row.values,name=roles.program;
  structure=(structure+segment.reserved.join('')+(words.length?(folded(words[0]??'')===':'?':':'__command__'):'')+(segment.sep==='eof'?';':segment.sep)).slice(-64);
  if(!forkSeen&&targetFree(structure)==='fork'){classes.push('fork');forkSeen=true;}
  const emit=(path:string,op:OwnerShellTarget['op'],base:string|undefined,resolve=true)=>{
   const decision=base===undefined&&op!=='read'?protectedCwdSuffix(path,dialect):undefined;
   targets.push({path:resolve?resolveFrom(base,path):isAnchored(homeSpelled(path))||base===undefined?path:base.replace(/\/$/,'')+'/'+path,op,...(decision?{decision}:{})});
  };
  for(const base of row.selected){
   const executable=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&basename(slot.value??'')===name)?.arg??0;
   for(const target of pathTargetsOwnerNl(words,base,row.wordCandidates.slice(executable+1),dialect))emit(target.path,target.op,base,!roles.archive);
   if(!roles.archive)for(const slot of roles.slots)if(slot.role==='write'&&slot.value===undefined)for(const path of segmentWordPaths(segment.words[slot.arg],{...row.context,cwd:base}))emit(path.slice(slot.offset),DELETE.has(name)?'delete':'write',base);
   const lang=langOfProgram(name);
   if(lang&&lang!=='sh'){
    const executable=roles.slots.find(slot=>basename(slot.value??'')===name)?.arg??0;
    const args=words.slice(executable+1);
    for(let at=0;at+1<args.length;at++)if(args[at+1]!==undefined&&(lang==='py'&&args[at]==='-c'||lang==='js'&&['-e','--eval','-p','--print'].includes(args[at]??''))){nested.push([lang,args[at+1]!,depth+1,'interpreter',base]);break;}
    for(const redirect of segment.redirects){if(redirect.heredoc)nested.push([lang,redirect.heredoc.body,depth+1,'heredoc',base]);if(redirect.op==='<<<'&&redirect.target?.text!==undefined)nested.push([lang,redirect.target.text,depth+1,'herestring',base]);}
   }
  }
  for(const base of row.cwds)for(const redirect of segment.redirects)if(redirect.target)for(const path of segmentWordPaths(redirect.target,{...row.context,cwd:base}))emit(path,redirect.write?'write':'read',base);
  const args=words.slice(1);
  if(DISK.has(name)||name.startsWith('mkfs')||name==='format'&&/^[a-z]:[\\/]?$/i.test(args[0]??''))classes.push('disk');
  if(name==='dd'&&args.some(arg=>arg?.startsWith('of=')&&namesDevice(arg.slice(3))))classes.push('disk');
  if(name==='ssh'&&args.length>1&&args.slice(1).every(arg=>arg!==undefined))for(const base of row.selected)nested.push(['sh',args.slice(1).join(' '),depth+1,'ssh',base]);
 },dialect,realpathSync.native,depth);
 for(const target of targets){if(target.op==='delete'){const cls=classifyPath(target.path);if(cls)classes.push(cls);}if(target.op==='write'&&namesDevice(target.path))classes.push('disk');}
 return targets;
}
export function shellPathTargetsOwnerNl(source:string,cwd?:string):OwnerShellTarget[]{return inspectOwnerShell(source,0,[],[],cwd);}
export function readShellExecOwnerNl(source:string,depth:number,nested:Payload[],collected:CodeClass[]=[],cwd?:string,dialect:'posix'|'pwsh'='posix'):[CodeClass,string,OwnerShellTarget[]]{
 const before=collected.length;const targets=inspectOwnerShell(source,depth,nested,collected,cwd,dialect);return [best(collected.slice(before)),'exec',targets];
}
export function shellExecutablesOwnerNl(source:string,depth:number,nested:Payload[],cwd?:string):string{inspectOwnerShell(source,depth,nested,[],cwd);return source;}
export function simpleCommandsOwnerNl(source:string):string[][]{const rows:string[][]=[];forEachSegment(source,row=>{if(row.words.length)rows.push(row.words.map(word=>word.text??word.raw));});return rows;}
