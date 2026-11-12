// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SegWord } from './segments.ts';
import { getopt, type OptSpec, type ParsedArg } from './getopt.ts';
import { archiveRoles, type ArchiveRoles, type ArchiveSlotRole } from './archive-roles.ts';
export type Role = 'name' | 'write' | 'read' | 'command' | 'script' | 'value' | 'flag';
export interface RoleSlot { arg: number; offset: number; value: string | undefined; role: Role; key?: string; detail?: ArchiveSlotRole }
export interface CommandRoles {
  program: string; wrappers: string[]; slots: RoleSlot[]; cwd?: { value: string | undefined; mode?:'logical'|'physical'; home?:boolean; alternate?:boolean; requirePhysical?:boolean; arg?:number };
  known: boolean; ambiguous: boolean; archive?: ArchiveRoles;
  stdinCode?:boolean;
  nested?: NestedExecution[];
}
export interface NestedExecution { text?:string; words?:SegWord[]; via:'shell-c'|'eval'|'env-S'|'find-exec'|'program'|'trap'|'su-c'; cwd:'same'|'unknown'|{rootSlot:number} }
export const writeSlots = (r: CommandRoles) => r.slots.filter(s => s.role === 'write');
const basename = (s: string | undefined) => (s ?? '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:exe|cmd)$/, '');
const longs = (names: string, mode: 'none' | 'required' | 'optional' = 'required') => Object.fromEntries(names.split(' ').filter(Boolean).map(n => [n, mode]));
const outputLong = longs('output out outfile output-file output-document log-file logfile');
const MODE=/^(?:[0-7]{1,4}|[ugoa]*(?:[-+=](?:[rwxXst]*|[ugo]))+(?:,[ugoa]*(?:[-+=](?:[rwxXst]*|[ugo]))+)*)$/;
const OWNER=/^[^/:~]*(:[^/:~]*)?$/;
const allFlags = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const WRAPPERS: Record<string, OptSpec> = {
  sudo: { flags: 'AbEHknPSVv', valued: 'ugCDhprtU', long: { ...longs('user group close-from chdir host prompt role type other-user'), ...longs('preserve-env', 'optional') } },
  doas: { flags: 'Lnsv', valued: 'ugCDhprtU' },
  env: { flags: 'i0v', valued: 'uCS', long: longs('unset chdir split-string') },
  command: { flags: 'pvV' }, exec: { flags: 'cl', valued: 'a' }, nohup: { flags: '' },
  time: { flags: 'apv', valued: 'of', long: longs('output format') },
  nice: { valued: 'n', long: longs('adjustment') }, ionice: { flags: 't', valued: 'cnp', long: longs('class classdata pid pgid uid') },
  stdbuf: { valued: 'ioe', long: longs('input output error') },
  timeout: { flags: 'v', valued: 'sk', long: { ...longs('signal kill-after'), ...longs('foreground preserve-status verbose', 'none') } },
  chrt: { flags: 'abdfimoprvR', valued: 'TDP', long: longs('sched-runtime sched-deadline sched-period') },
  taskset: { flags: 'ap', valued: 'c', long: longs('cpu-list') },
  flock: { flags: 'ensuxoF', valued: 'wE', long: longs('wait timeout conflict-exit-code') },
  busybox: {}, xargs: { flags: '0rptx', valued: 'aInPLdEs', long: longs('arg-file replace max-args max-procs max-lines delimiter eof max-chars') },
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'pwsh', 'powershell', 'cmd']);
const COPY: OptSpec = { flags: 'abdfilnprRsuvHTPsT', valued: 'tS', long: { ...longs('target-directory suffix'), ...longs('backup', 'optional'), ...longs('symbolic no-target-directory', 'none') } };

/** One option/operand table. Source positions survive wrapper removal, attached
 * values and ambiguous grammars, so all consumers project the same writes. */
export function commandRoles(words: ReadonlyArray<string | undefined>, dialect: 'posix' | 'pwsh' = 'posix',sourceWords?:ReadonlyArray<SegWord>): CommandRoles {
  const result: CommandRoles = { program: '', wrappers: [], slots: [], known: false, ambiguous: false };
  let base = 0;
  const positions=new Map<string,RoleSlot>();
  const put = (arg: number, value: string | undefined, role: Role, offset = 0, key?: string) => {
    const location=`${arg}:${offset}:${key??''}`;
    const existing = positions.get(location);
    if (existing) { if (role === 'write' || existing.role !== 'write') existing.role = role; existing.value = value; }
    else {const slot={ arg, offset, value, role, ...(key ? { key } : {}) };result.slots.push(slot);positions.set(location,slot);}
  };
  const nested = (text: string | undefined, via: NestedExecution['via'], cwd:NestedExecution['cwd']='same') => { if (text !== undefined) (result.nested ??= []).push({ text, via, cwd }); };
  // Every wrapper consumes its own grammar once. No text splitting here.
  for (let guard = 0; base < words.length && guard < words.length; guard++) {
    const name = basename(words[base]);
    put(base, words[base], base === 0 ? 'name' : 'command');
    const spec = WRAPPERS[name];
    if (!spec) break;
    result.wrappers.push(name);
    const start = base + 1;
    const parsed = getopt(words.slice(start), { ...spec, permute: false });
    result.ambiguous ||= parsed.unknown;
    for (const item of parsed.items.filter(i => i.kind !== 'operand')) {
      const role = name === 'time' && ['-o', '--output'].includes(item.key ?? '') ? 'write' : name === 'xargs' && ['-a', '--arg-file'].includes(item.key ?? '') ? 'read' : item.kind === 'flag' ? 'flag' : 'value';
      put(start + item.arg, item.value, role, item.offset, item.key);
      if (name === 'env' && ['-C', '--chdir'].includes(item.key ?? '') || (name === 'sudo' || name === 'doas') && ['-D', '--chdir'].includes(item.key ?? '')) result.cwd = { value: item.value };
      if (name === 'env' && ['-S', '--split-string'].includes(item.key ?? '')) nested(item.value, 'env-S');
    }
    let operands = parsed.operands;
    if (name === 'env') {
      while (operands[0]?.value !== undefined && /^[A-Za-z_]\w*=/.test(operands[0].value)) { const item = operands[0]; put(start + item.arg, item.value, 'value'); operands = operands.slice(1); }
    }
    const positional = name === 'timeout' || name === 'chrt' || name === 'flock' || name === 'taskset' && !parsed.items.some(i => i.key === '-c' || i.key === '--cpu-list');
    if (positional && operands[0]) { const item = operands[0]; put(start + item.arg, item.value, name === 'flock' ? 'write' : 'value'); operands = operands.slice(1); }
    if (!operands[0]) { result.program = name; result.known = true; return result; }
    base = start + operands[0].arg;
  }
  const name = result.program = basename(words[base]);
  const args = words.slice(base + 1);
  const shift = base + 1;
  const add = (item: ParsedArg, role: Role) => put(shift + item.arg, item.value, role, item.offset, item.key);
  const archive = archiveRoles(name, args);
  if (archive) {
    result.known = true; result.ambiguous ||= archive.unknownOptions; result.archive = archive;
    for (const slot of archive.slots) {
      result.slots.push({ ...slot, arg: shift + slot.arg });
      if(slot.detail==='program'){
        const value=slot.key==='--checkpoint-action' ? slot.value?.startsWith('exec=')?slot.value.slice(5):undefined : slot.value;
        nested(value,'program',slot.root===undefined||slot.root<0?'same':{rootSlot:slot.root});
      }
    }
    return result;
  }
  if (SHELLS.has(name)) {
    result.known = true;
    const parsed = getopt(args, { permute:false, flags: allFlags.replaceAll('c', ''), valued: 'c', singleDashLong: name === 'pwsh' || name === 'powershell', long: { Command: 'required', File: 'required' } });
    for (const item of parsed.items) {
      if (['-c', '-Command', '--Command'].includes(item.key ?? '')) nested(item.value, 'shell-c');
      else add(item, item.kind === 'operand' ? 'read' : 'value');
    }
    result.stdinCode=!parsed.items.some(item=>['-c','-Command','--Command','-File','--File'].includes(item.key??'')) && (parsed.items.some(item=>item.key==='-s') || !parsed.operands.length || parsed.operands[0]?.value==='/dev/stdin');
    // cmd uses /c, unlike the getopt grammars.
    if (name === 'cmd') { const at = args.findIndex(w => w?.toLowerCase() === '/c'); if (at >= 0 && args.slice(at + 1).every(w => w !== undefined)) nested(args.slice(at + 1).join(' '), 'shell-c'); }
    return result;
  }
  if((name==='source'||name==='.')&&args[0]==='/dev/stdin'){result.known=true;result.stdinCode=true;return result;}
  if(name==='trap'){
    result.known=true;
    if(args[0]!==undefined&&!['-','-p','-l'].includes(args[0])){put(shift,args[0],'command');nested(args[0],'trap');}
    return result;
  }
  if(name==='su'){
    result.known=true;
    const parsed=getopt(args,{flags:'lmfp',valued:'cswgG',long:longs('command shell group supp-group whitelist-environment')});
    for(const item of parsed.items){add(item,['-c','--command'].includes(item.key??'')?'command':'value');if(['-c','--command'].includes(item.key??''))nested(item.value,'su-c');}
    return result;
  }
  if (name === 'eval') { result.known = true; if (args.every(a => a !== undefined)) nested(args.join(' '), 'eval'); return result; }
  let spec: OptSpec = { flags: allFlags, valued: 'oO', long: outputLong };
  let mode: 'all' | 'last' | 'copy' | 'move' | 'link' | 'sed' | 'perl' | 'permissions' | 'rsync' | 'compress' | 'pwsh' | 'find' | 'read' = 'read';
  if (['cd', 'pushd'].includes(name)) {
    result.known = true; const parsed = getopt(args, { flags: 'LPe@',permute:false });
    result.cwd = { value: parsed.operands[0]?.value,home:parsed.operands.length===0, mode:parsed.items.filter(item=>['-L','-P'].includes(item.key??'')).at(-1)?.key==='-P'?'physical':'logical',alternate:parsed.items.some(item=>item.key==='-@'),requirePhysical:parsed.items.some(item=>item.key==='-e'),arg:parsed.operands[0]?shift+parsed.operands[0].arg:undefined };
    for (const item of parsed.items) add(item, item.kind === 'operand' ? 'read' : 'flag');
    return result;
  }
  if (['cp', 'mv', 'ln', 'install'].includes(name)) {
    spec = { ...COPY, valued: COPY.valued + (name === 'install' ? 'mogC' : ''), long: { ...COPY.long, ...longs('mode owner group') } };
    mode = name === 'mv' ? 'move' : name === 'ln' ? 'link' : 'copy';
  } else if (name === 'rsync') {
    spec = { flags: allFlags.replace(/[efBT]/g, ''), valued: 'efBT', long: { ...longs('rsh files-from exclude-from include-from password-file exclude include filter chmod chown timeout port suffix log-file backup-dir partial-dir temp-dir link-dest copy-dest compare-dest'), ...longs('remove-source-files backup', 'none') } }; mode = 'rsync';
  } else if (['rm', 'rmdir', 'unlink', 'shred', 'srm', 'tee', 'truncate', 'touch', 'mkdir'].includes(name)) {
    mode = 'all'; spec = { flags: allFlags, ...(name === 'tee' ? {} : { valued: name === 'truncate' ? 'sr' : name === 'touch' ? 'rtd' : name === 'mkdir' ? 'm' : '' }), long: { ...longs('size reference date mode'), 'output-error': 'optional' } };
  } else if (['chmod', 'chown', 'chgrp'].includes(name)) {
    mode = 'permissions'; spec = { flags:'RcfvHLP h'.replaceAll(' ',''), stopOptions:word=>name==='chmod'&&word.startsWith('-')&&MODE.test(word), long: { ...longs('recursive changes silent quiet verbose dereference no-dereference preserve-root no-preserve-root','none'),...longs('reference from') } };
  } else if (['sed', 'gsed', 'perl', 'ruby', 'awk', 'gawk'].includes(name)) {
    mode = name === 'perl' || name === 'ruby' ? 'perl' : 'sed';
    spec = name === 'ruby' ? { flags: allFlags, valued: 'erICFE', optional: 'i' } : name === 'perl' ? { flags: allFlags, valued: 'eEIMm', optional: 'i0lxC' } : { flags: 'snErzu', valued: 'efl', optional: 'i', long: { ...longs('expression file line-length'), 'in-place': 'optional', ...longs('posix debug sandbox', 'none') } };
    if (name === 'awk' || name === 'gawk') spec = { flags: allFlags, valued: 'efvi', long: longs('source file assign include') };
  } else if (['gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'lz4'].includes(name)) {
    mode = 'compress'; spec = { flags: allFlags, valued: 'Sbo', long: { ...longs('suffix output'), ...longs('stdout test list', 'none') } };
  } else if (name === 'ditto') mode = 'last';
  else if (name === 'find') { mode = 'find'; spec = { flags: allFlags, singleDashLong: true, long: { ...longs('fprint fprint0 fprintf fls'), delete: 'none', ...longs('name path type maxdepth mindepth') } }; }
  const pwshProgram = /^(?:set-content|sc|add-content|ac|out-file|new-item|ni|remove-item|ri|del|erase|rd|move-item|move|mi|copy-item|copy|cpi|rename-item|rni)$/.test(name) || dialect === 'pwsh' && /^(?:rm|rmdir|mv|cp|ren|rename)$/.test(name);
  if (pwshProgram) {
    mode = 'pwsh'; spec = { singleDashLong: true, long: { ...longs('Path LiteralPath FilePath PSPath Destination NewName Value Encoding ItemType Name Filter Include Exclude'), ...longs('Force Recurse Confirm WhatIf Append NoClobber', 'none') } };
  }
  result.known = mode !== 'read' || name === 'dd' || name === 'sort' || name === 'make';
  const parsed = getopt(args, spec);
  result.ambiguous ||= parsed.unknown;
  const has = (...keys: string[]) => parsed.items.some(i => keys.includes(i.key ?? ''));
  const ops = parsed.operands;
  for (const item of parsed.items) add(item, item.kind === 'operand' ? 'read' : item.kind === 'flag' ? 'flag' : 'value');
  for (const item of parsed.items) if (item.kind === 'value' && (
    item.key === '--reference' || ['touch', 'truncate', 'ruby'].includes(name) && item.key === '-r'
    || mode === 'rsync' && ['--files-from', '--exclude-from', '--include-from', '--password-file', '--link-dest', '--copy-dest', '--compare-dest'].includes(item.key ?? '')
  )) add(item, 'read');
  const writes = (items: readonly ParsedArg[]) => { for (const item of items) add(item, 'write'); };
  const last = () => writes(ops.slice(-1));
  if (mode === 'all') writes(ops);
  if (mode === 'last') last();
  if (mode === 'copy' || mode === 'move' || mode === 'link') {
    const destinations = parsed.items.filter(i => ['-t', '--target-directory'].includes(i.key ?? ''));
    if (name === 'install' && has('-d')) writes(ops);
    else if (destinations.length) writes(destinations); else last(); // M-ROLE-CP-T
    if (mode === 'move' || mode === 'link' && !has('-s', '--symbolic')) writes(ops); // M-ROLE-SRC-READ
  }
  if (mode === 'permissions') {
    const grammar=name==='chmod'?MODE:OWNER;
    const at=has('--reference')?-1:ops.findIndex(item=>item.value!==undefined&&grammar.test(item.value));
    writes(ops.filter((_,index)=>index!==at));
  }
  if (mode === 'rsync') {
    const eligible = ops.filter(i => !i.value || !/^(?:[^/]+:|\w+:\/\/)/.test(i.value));
    writes(has('--remove-source-files') ? eligible : eligible.slice(-1));
    writes(parsed.items.filter(i => ['--log-file', '--backup-dir', '--partial-dir', '-T', '--temp-dir'].includes(i.key ?? '')));
    for (const item of parsed.items) if (['-e', '--rsh'].includes(item.key ?? '')) {add(item, 'command');nested(item.value,'program');}
  }
  if (mode === 'sed' || mode === 'perl') {
    const scriptOptions = parsed.items.filter(i => i.kind === 'value' && (name === 'ruby' ? ['-e'] : ['-e', '-E', '--expression', '--source', '-f', '--file']).includes(i.key ?? ''));
    const supplied = scriptOptions.length > 0;
    for (const item of scriptOptions) add(item, ['-f', '--file'].includes(item.key ?? '') ? 'read' : 'script');
    if (!supplied && ops[0]) add(ops[0], name === 'perl' || name === 'ruby' ? 'read' : 'script'); // M-ROLE-SED-SCRIPT
    const inPlace = name === 'awk' || name === 'gawk' ? parsed.items.some(i => ['-i', '--include'].includes(i.key ?? '') && /(?:^|[\\/])inplace(?:\.awk)?$/.test(i.value ?? '')) : has('-i', '--in-place');
    if (inPlace) writes(supplied ? ops : ops.slice(1));
    // GNU standalone -i has no suffix; BSD consumes one. The GNU reading is
    // already the superset of file operands, so its write union is retained.
    if ((name === 'sed' || name === 'gsed') && parsed.items.some(i => i.key === '-i' && i.value === '')) result.ambiguous = true;
  }
  if (mode === 'compress' && !has('-c', '--stdout', '-t', '--test', '-l', '--list')) writes(ops);
  if (mode === 'find') {
    for(let at=0;at<args.length;at++){
      const flag=args[at];
      if(!['-exec','-execdir','-ok','-okdir'].includes(flag??''))continue;
      const start=++at;
      while(at<args.length && args[at]!==';' && !(args[at]==='+'&&args[at-1]==='{}'))at++;
      const body=args.slice(start,at).map((value,index):SegWord=>{
        const source=sourceWords?.[shift+start+index];
        if(source)return value==='{}'?{...source,text:undefined,origin:'expansion',placeholder:true}:source;
        return {raw:value??'',text:value==='{}'?undefined:value,origin:value===undefined||value==='{}'?'expansion':'plain',quoted:true,start:index,end:index+1,...(value==='{}'?{placeholder:true as const}:{})};
      });
      for(let index=start;index<at;index++)put(shift+index,args[index],'command');
      if(body.length)(result.nested??=[]).push({words:body,via:'find-exec',cwd:flag==='-execdir'||flag==='-okdir'?'unknown':'same'});
    }
    writes(parsed.items.filter(i => ['-fprint', '-fprint0', '-fprintf', '-fls'].includes(i.key ?? ''))); if (has('-delete')) writes(ops); }
  if (mode === 'pwsh') {
    const pathKeys = ['-path', '-literalpath', '-filepath', '-pspath'];
    const path = parsed.items.filter(i => pathKeys.includes((i.key ?? '').toLowerCase()));
    const rename = ['rename-item', 'rni', 'ren', 'rename'].includes(name);
    const dest = parsed.items.filter(i => i.key?.toLowerCase() === (rename ? '-newname' : '-destination'));
    const copy = ['copy-item', 'copy', 'cpi', 'cp'].includes(name);
    const move = rename || ['move-item', 'move', 'mi', 'mv', 'remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase'].includes(name);
    if (copy) writes(dest.length ? dest : ops.slice(1, 2));
    else if (move) { writes(path); writes(dest); writes(ops); }
    else {
      const selected = path.length ? path : ops.slice(0, 1);
      const child = parsed.items.find(i => i.key?.toLowerCase() === '-name');
      if (['new-item', 'ni'].includes(name) && child?.value !== undefined) for (const item of selected) put(shift + item.arg, item.value === undefined ? undefined : item.value.replace(/[\\/]$/, '') + '/' + child.value, 'write', item.offset, item.key);
      else writes(selected);
    }
  }
  if (name === 'dd') for (const item of ops) if (item.value?.startsWith('of=')) put(shift + item.arg, item.value.slice(3), 'write', 3); else if (item.value?.startsWith('if=')) put(shift + item.arg, item.value.slice(3), 'read', 3);
  // Generic output options apply only where a command row did not already
  // assign that spelling another role (e.g. install -o is an owner).
  if (mode === 'read' || name === 'sort' || mode === 'compress') writes(parsed.items.filter(i => ['-o', '-O', ...Object.keys(outputLong).map(k => '--' + k)].includes(i.key ?? '') && !(name !== 'sort' && i.key === '-O' && /^(?:\d+|s|z|g|fast)$/.test(i.value ?? ''))));
  if (name === 'sort') { const extra = getopt(args, { flags: allFlags, valued: 'oT', long: longs('output temporary-directory') }); writes(extra.items.filter(i => ['-o', '-T', '--output', '--temporary-directory'].includes(i.key ?? ''))); }
  if (name === 'make' && ops.some(i => i.value === 'install')) { const extra = getopt(args, { flags: allFlags, valued: 'C', long: longs('directory') }); writes(extra.items.filter(i => ['-C', '--directory'].includes(i.key ?? ''))); }
  // R0: an unknown word/option may have been a flag or may have consumed a
  // value. Retain the union rather than losing a possible earlier destination.
  if (parsed.unknown && ['all', 'copy', 'move', 'link', 'permissions', 'rsync', 'last'].includes(mode)) writes(ops);
  return result;
}
