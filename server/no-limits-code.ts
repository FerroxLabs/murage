// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of the executable tool-identity r1.2.1 specification, spec/judge.py.
// Payloads are data: this reader does no I/O, imports no interpreter, and never
// evaluates a payload. Call only for the owner No-limits reader, after identity
// has been established by the driver. The approval policy owns other modes.
import { classifyPath, namesDevice, readShellExecOwnerNl, shellPathTargetsOwnerNl, plainWipe, powerShellSource, readShell, readShellExec, shellExecutables, simpleCommands, pathTargets, targetFree, type CodeClass, type Language, type Payload, type Twin } from "./no-limits-shell.ts";
import { readJavascript } from "./no-limits-javascript.ts";
import { readPython } from "./no-limits-python.ts";
import { InspectionOverflow, inspectOwnerTargets, type OwnerNlAuthority } from "./no-limits-authority.ts";
import { boundedText, ReaderBudget } from "./no-limits-budget.ts";

import { readerOracle, observed, type ReaderVerdict } from "../shared/no-limits-decision.ts";

export const MAX_DEPTH = 4;
export const CODE_CLASS_MAPPING = {
  root: "delete-root", home: "delete-home", system: "delete-system-folder",
  disk: "disk-erase", fork: "fork-bomb", word: "plainWipe", cut: "truncated",
} as const;
export interface CodeVerdict {
  verdict: "card" | "run";
  /** Reference class; mapped to approval classes by noLimitsCode below. */
  cls: CodeClass;
  why: string;
  twins: Twin[];
}
const ROOT_LANG: Record<string, Language> = { terminal: "sh", shell: "sh", execute_code: "py", python: "py", node: "js" };
function stringLeaves(value: unknown, failure: () => void, budget: ReaderBudget): string[] {
  const out: string[] = [], ancestors = new Set<object>();
  function* values(object: object): Generator<unknown> {
    if (Array.isArray(object)) yield* object;
    else for (const key in object) if (Object.hasOwn(object, key)) yield (object as Record<string, unknown>)[key];
  }
  const stack: { iterator: Iterator<unknown>; owner?: object }[] = [{ iterator: [value].values() }];
  while (stack.length) {
    const frame = stack.at(-1)!, item = frame.iterator.next();
    if (item.done) { if (frame.owner) ancestors.delete(frame.owner); stack.pop(); continue; }
    budget.tick();
    const v = item.value;
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") {
      // JSON cannot cycle; direct callers can. Keep independent leaves so a
      // detected effect still outranks this incomplete read.
      if (ancestors.has(v)) { failure(); continue; }
      ancestors.add(v);
      stack.push({ iterator: values(v), owner: v });
    }
  }
  return out;
}
export function readCode(identity: string, payload: unknown, mode = "nl", budget = new ReaderBudget()): { reads: ReaderVerdict[]; why: string; twins: Twin[] } {
  return readCodeAtDepth(identity, payload, mode, budget, 0);
}
function readCodeAtDepth(identity: string, payload: unknown, mode: string, budget: ReaderBudget, initialDepth: number): { reads: ReaderVerdict[]; why: string; twins: Twin[] } {
  if (mode === "nl-cut") return { reads: [observed("protocol", "cut")], why: "hook message truncated (W9)", twins: [] };
  if (mode !== "nl") throw new Error("judge covers the owner No-limits code reader only (mode nl / nl-cut)");
  const classes: CodeClass[] = [], whys: string[] = [], twins: Twin[] = [];
  const failure = () => { classes.push("cut"); whys.push("reader cut"); };
  try {
    const lang = Object.hasOwn(ROOT_LANG, identity) ? ROOT_LANG[identity] : undefined;
    const work: Payload[] = [];
    if (lang) work.push([lang, typeof payload === "string" ? payload : JSON.stringify(payload), initialDepth, "root"]);
    else {
      let value = payload;
      if (typeof value === "string") { boundedText(value); try { value = JSON.parse(value) as unknown; } catch (error) { if (!(error instanceof SyntaxError)) throw error; /* a plain text leaf */ } }
      let rest = value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const body = value as Record<string, unknown>;
        for (const key of ["command", "cmd", "script", "code"]) {
          const raw = body[key];
          // Python str.strip includes C0 separators and NEL, but excludes BOM.
          // eslint-disable-next-line no-control-regex -- the Python whitespace set intentionally includes these controls.
          const hasText = typeof raw === "string" && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(raw);
          const argv = Array.isArray(raw) && raw.length && raw.every(x => typeof x === "string");
          if (!hasText && !argv) continue;
          const cmd = typeof raw === "string" ? raw : (raw as string[]).join(" ");
          work.push(["sh", cmd, 0, "commandArgument " + key]);
          rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));
          break;
        }
      }
      for (const s of stringLeaves(rest, failure, budget)) work.push(["text", s, 0, "leaf"]);
    }
    for (let i = 0; i < work.length; i++) {
      budget.tick();
      const [lng, text, depth, how] = work[i], nested: Payload[] = [];
      let c: CodeClass = "", why = "";
      try {
        boundedText(text);
        if (lng === "sh") {
          [c, why] = readShell(text, depth, nested, false, classes);
          if (!c && plainWipe(text)) { c = "word"; why = "plainWipe"; }
        } else if (lng === "text") [c, why] = readShell(text, depth, [], true, classes);
        else {
          c = targetFree(text); why = c ? "S1 " + c : "";
          if (c) classes.push(c);
          // Reduce emitted code as well as shell effects immediately, using
          // the same budget and depth bound. A later outer walk must not strand
          // an already detected nested-code effect in an unvisited queue.
          const onTwin = ([language, command]: Twin) => {
            if (depth + 1 > MAX_DEPTH) return;
            boundedText(command);
            if (language !== "sh") {
              const nestedRead = readCodeAtDepth(language === "py" ? "python" : "node", command, mode, budget, depth + 1);
              for (const read of nestedRead.reads) if (read.state !== "clean") classes.push(read.state === "cut" ? "cut" : read.cls);
              return;
            }
            const [effect] = readShell(command, depth + 1, [], false, classes);
            if (!effect && plainWipe(command)) classes.push("word");
            budget.tick();
          };
          const r = lng === "py" ? readPython(text, budget, onTwin) : readJavascript(text, budget, onTwin);
          if (r.cut) failure();
          // Queue twins before literal scans: a failing literal must not erase them.
          for (const [tl, tt, twWhy] of r.twins) {
            twins.push([tl, tt, twWhy]);
            if (tl === "sh") nested.push([tl, tt, depth + 1, "twin " + twWhy]);
          }
          for (const lit of r.literals) {
            try {
              boundedText(lit);
              const [lc, lw] = readShell(lit, depth, [], true, classes);
              if (lc) { classes.push(lc); whys.push("S2 literal: " + lw); }
            } catch { failure(); }
          }
        }
      } catch { failure(); }
      if (c) { classes.push(c); whys.push(`${lng}@${depth} ${how}: ${why}`); }
      for (const item of nested) if (item[2] <= MAX_DEPTH) work.push(item);
    }
  } catch { failure(); }
  return { reads: classes.length ? classes.map(cls => observed("code", cls)) : [observed("code", "")], why: whys.join("; ").slice(0, 300), twins };
}
export function judge(identity: string, payload: unknown, mode = "nl"): CodeVerdict {
  const result = readCode(identity, payload, mode);
  return { ...readerOracle(result.reads), why: result.why, twins: result.twins };
}
/** Approval-facing class names. `plainWipe` is the word-model proxy, not a
 * catastrophe class; the caller retains that distinction in its finalizer. */
export function noLimitsCode(identity: string, payload: unknown, mode: "nl" | "nl-cut" = "nl") {
  const result = judge(identity, payload, mode);
  return { ...result, cls: result.cls ? CODE_CLASS_MAPPING[result.cls] : "" };
}

/** Production executable mode: one budget and semantic twins only. The legacy
 * nl/oracle modes above deliberately remain independent for corpus parity. */
export function readExecutable(lang:'sh'|'py'|'js'|'pwsh',source:string,budget=new ReaderBudget(),depth=0): {classes:CodeClass[];targets:Array<{path:string;op:'read'|'write'|'delete'}>} {
 const classes:CodeClass[]=[],targets:Array<{path:string;op:'read'|'write'|'delete'}>=[],work:Payload[]=[[lang==='pwsh'?'sh':lang,(lang==='pwsh'?powerShellSource(source):source).slice(0,65536),depth,'root']];
 let bytes=1_000_000;
 for(let i=0;i<work.length&&i<64;i++){
  const [l,raw,d]=work[i];if(d>MAX_DEPTH||bytes<=0)continue;
  const text=raw.slice(0,bytes);bytes-=text.length;
  try {budget.tick(text.length);const nested:Payload[]=[];
   if(l==='sh'){
    readShellExec(text,d,nested,classes);
    for(const words of simpleCommands(shellExecutables(text,d,[]))??[])targets.push(...pathTargets(words));
   }else if(l==='py'||l==='js'){
    const onTwin=([language,command]:Twin)=>{if(work.length<64)work.push([language,command,d+1,'semantic']);};
    if(l==='py')readPython(text,budget,onTwin);else readJavascript(text,budget,onTwin);
   }
   for(const n of nested)if(work.length<64)work.push(n);
  }catch { /* unreadable remainder runs, already found evidence is retained */ }
 }
 return {classes,targets:targets.slice(0,256)};
}

/** Authenticated owner No limits inspection. Display bounds never limit policy.
 * Subreaders share one work budget; incomplete inspection refuses at ingress. */
export function readExecutableOwnerNl(lang:'sh'|'py'|'js'|'pwsh',source:string,budget?:ReaderBudget,depth=0,cwd?:string): {classes:CodeClass[];targets:Array<{path:string;op:'read'|'write'|'delete';decision?:import('./no-limits-authority.ts').OwnerNlDecision}>;authority:OwnerNlAuthority} {
 const classes:CodeClass[]=[],targets:Array<{path:string;op:'read'|'write'|'delete';decision?:import('./no-limits-authority.ts').OwnerNlDecision}>=[];
 const work:Payload[]=[[lang==='pwsh'?'sh':lang,source,depth,'root',cwd]];
 const inspectionBudget=budget??Object.assign(new ReaderBudget(),{left:9*source.length+1});
 let bytes=9*source.length+1;
 for(let i=0;i<work.length;i++){
  const [l,text,d,,location]=work[i];
  if(d>8 || text.length>bytes)throw new InspectionOverflow('executable inspection overflow');
  bytes-=text.length;inspectionBudget.tick(text.length);
  const nested:Payload[]=[];
  if(l==='sh'){
   const read=readShellExecOwnerNl(text,d,nested,classes,location,lang==='pwsh'?'pwsh':'posix');
   for(const target of read[2]??shellPathTargetsOwnerNl(text,location))targets.push(target);
  }else if(l==='py'||l==='js'){
   boundedText(text);
   const onTwin=([language,command]:Twin)=>{work.push([language,command,d+1,'semantic',location]);};
   const read=l==='py'?readPython(text,inspectionBudget,onTwin):readJavascript(text,inspectionBudget,onTwin);
   // Legacy readers report caught exceptions and nesting cuts as data, even
   // with work budget remaining. Every incomplete owner read must refuse.
   if(read.cut||inspectionBudget.left<0)throw new InspectionOverflow('code inspection overflow');
  }
  for(const n of nested)work.push(n);
 }
 for(const target of targets)if(target.op==='delete'){const cls=classifyPath(target.path);if(cls)classes.push(cls);}
 for(const target of targets)if(target.op==='write'&&namesDevice(target.path))classes.push('disk');
 return {classes,targets,authority:inspectOwnerTargets(targets)};
}
