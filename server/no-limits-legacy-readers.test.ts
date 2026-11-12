// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
const read=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
it('H1 all legacy shell reader bodies and shared helpers retain the lane baseline bytes',()=>{
 const text=read('./no-limits-shell.ts');
 const legacy=text.slice(text.indexOf('export type CodeClass'),text.indexOf('/** Quote-aware executable segments.')).trimEnd()+'\n';
 expect(digest(legacy.replace('export type Payload = [Language, string, number, string, (string | undefined)?];','export type Payload = [Language, string, number, string];'))).toBe('f853b8266a6890876ff39100250af1c3eea9be3315fea81dd59267fd9953704c');
});
it('H1 the legacy executable reader stays byte exact',()=>{
 const text=read('./no-limits-code.ts');
 expect(digest(text.slice(text.indexOf('export function readExecutable('),text.indexOf('/** Authenticated owner No limits inspection.')).trimEnd()+'\n')).toBe('9d3ebbce5a5dc97d8dee5f18287c3c9ce214c94a155d359fa1f5bc720908aa51');
});
it('H1 describe and describeAction remain the legacy implementations',()=>{
 const text=read('./decision/action.ts');
 expect(digest(text.slice(text.indexOf('export function describe('),text.indexOf('export function describeOwnerNoLimits(')))).toBe('c0df5c6dec38d31834e2d7ce53737df749a54e1b01a2729e1459939da54fa4f3');
 expect(read('./decision/implementation.ts')).toContain('export function describeAction(input:T.RequestSnapshot|T.ServiceCall):T.ActionEvidence{return describe(input);}');
});
