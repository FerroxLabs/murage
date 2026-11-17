// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { collectNoLimits, type CollectionHooks } from './no-limits-collect.ts';
import { literalText } from './shell/lex.ts';
import { resolveFrom } from './shell/walk.ts';
const commands=(text:string)=>collectNoLimits(text,{cwd:'/fixture'}).commands;
const names=(text:string)=>commands(text).map(c=>c.command.name);

it.each([
  'ln -s /etc/hosts h; tee h',
  '! ln -s /etc/hosts h && tee h',
  'if c; then ln -s /etc/hosts h; else tee h; fi',
  'while c; do ln -s /etc/hosts h; tee h; done',
  'for x in a b; do ln -s /etc/hosts h; tee h; done',
  'f() { ln -s /etc/hosts h; tee h; }; f; f',
  '(ln -s /etc/hosts h; tee h)',
  'ln -s /etc/hosts h | tee h',
  'echo $(ln -s /etc/hosts h; tee h)',
  'ln -s /etc/hosts h < <(tee h)',
  'ln -s /etc/hosts h > >(tee h)',
  "sh -c 'ln -s /etc/hosts h; tee h'",
  "sh <<'EOF'\nln -s /etc/hosts h; tee h\nEOF",
  "find . -exec sh -c 'ln -s /etc/hosts h; tee h' \\;",
  "sudo env -C /fixture sh -c 'ln -s /etc/hosts h; tee h'",
  "sudo -n sh -c 'ln -s /etc/hosts h; tee h'",
  "timeout 5 sh -c 'ln -s /etc/hosts h; tee h'",
  "env -S \"sh -c 'ln -s /etc/hosts h; tee h'\"",
  "flock ./lock sh -c 'ln -s /etc/hosts h; tee h'",
  "echo 'ln -s /etc/hosts h; tee h' | sh",
  "echo 'ln -s /etc/hosts h; tee h' | cat | sh",
])('complete syntax envelope: %s',text=>{
  expect(names(text)).toEqual(expect.arrayContaining(['ln','tee']));
  const rows=commands(text);
  expect(new Set(rows.map(r=>r.syntaxId)).size).toBe(rows.length);
  expect(rows.filter(r=>r.command.name==='ln')).toHaveLength(1);
});

it('discovers correlated eval literals before any merged value rejection',()=>{
  const rows=commands("if c; then p='ln -s /etc/hosts h'; else p='ln -s ./plain h'; fi; eval \"$p\"; tee h");
  expect(rows.filter(r=>r.command.name==='ln').map(r=>literalText(r.command.args[1]!))).toEqual(['/etc/hosts','./plain']);
  expect(rows.at(-1)?.command.name).toBe('tee');
});
it('discovers chained literal body references without recursive eval expansion',()=>{
  expect(names("a=\"$b\"; b='ln -s /etc/hosts h'; eval \"$a\"")).toContain('ln');
  expect(names("p='eval \"$p\"'; eval \"$p\"; tee notes")).toContain('tee');
  expect(names("eval \"$p\"; eval 'p=\"ln -s /etc/hosts h\"'; tee h")).toContain('ln');
  expect(names("export p='ln -s /etc/hosts h'; eval \"$p\"")).toContain('ln');
  expect(names("for p in 'ln -s /etc/hosts h'; do eval \"$p\"; done")).toContain('ln');
  expect(names('eval "${p:-ln -s /etc/hosts h}"')).toContain('ln');
});
it('retains known producer program values without resolving their raw path operands',()=>{
  const row=commands('runner=ln; "$runner" -s "$target" ./h').find(r=>r.command.name==='ln');
  expect(row?.command.args[1]?.parts[0]?.kind).toBe('var');
  expect(names('if c; then runner=ln; else runner=tee; fi; "$runner" -s /etc/hosts ./h')).toContain('ln');
});
it('keeps variables unknown as raw words, including options and dotdot text',()=>{
  const row=commands('t=./plain; ln "$option" "$t" ./a/../h')[0]!;
  expect(row.command.args[0]?.parts[0]?.kind).toBe('var');
  expect(row.command.args[1]?.parts[0]?.kind).toBe('var');
  expect(literalText(row.command.args[2]!)).toBe('./a/../h');
  expect(row.context.links.size).toBe(0);
  expect(row.context.inodes.size).toBe(0);
});
it('retains siblings following an opaque or unmodelled executable',()=>{
  expect(names('python -c "$code"; producer; ln -s /etc/hosts h; tee h')).toEqual(['python','producer','ln','tee']);
  const envelope=collectNoLimits('opaque; printf x > notes; ln -s /etc/hosts h');
  expect(envelope.writes.map(w=>literalText(w.word))).toEqual(['notes']);
  expect(envelope.commands.at(-1)?.command.name).toBe('ln');
});
it.each(['/J','/D','/H',''])('collects cmd mklink %s before unmodelled rejection',option=>{
  const rows=commands(`mklink ${option} .\\h C:\\Windows\\named & echo x > .\\h\\x`);
  expect(rows.map(r=>r.command.name)).toEqual(['mklink','echo']);
  expect(rows[0]?.dialect).toBe('cmd');
  expect(rows[0]?.command.args.map(literalText)).toContain('C:\\Windows\\named');
});
it.each(['Junction','SymbolicLink','HardLink'])('collects PowerShell %s and pipeline provenance',type=>{
  const result=collectNoLimits(`New-Item -ItemType ${type} -Path .\\h -Target C:\\Windows\\named; Set-Content .\\h x`);
  expect(result.commands.map(r=>r.command.name)).toEqual(['new-item','set-content']);
  expect(result.commands[0]?.dialect).toBe('pwsh');
  expect(result.commands[0]?.command.args.map(literalText)).toContain(type);
  const pipeline=commands("Get-Item C:\\work\\plain | mi -Destination .\\out");
  expect(pipeline[1]?.command.name).toBe('move-item');
  expect(pipeline[1]?.command.stdin).toBeDefined();
});
it('collects literal Windows wrappers with their actual dialect',()=>{
  const result=commands('cmd /c "mklink /J .\\h C:\\Windows & echo x > .\\h\\x"');
  expect(result.find(r=>r.command.name==='mklink')?.dialect).toBe('cmd');
  expect(names("pwsh -Command 'ni -ItemType Junction -Path h -Target C:\\Windows'")).toContain('new-item');
});
it('exposes once-only scoped cwd transitions without moving the outer subshell cwd',()=>{
  const advances:string[]=[];
  const hooks:CollectionHooks<string|undefined>={
    locate:s=>s.context.cwd,
    advance:(r,s)=>{advances.push(`${s.id}:${r.syntaxId}`);if(r.command.name==='cd')s.context.cwd=resolveFrom(s.context.cwd,literalText(r.command.args[0]!)!);},
  };
  const rows=collectNoLimits('cd one; (cd two; tee inside); tee outside',{cwd:'/fixture',hooks}).commands;
  expect(rows.find(r=>literalText(r.command.args[0]??{parts:[]})==='inside')?.ownerCwd).toBe('/fixture/one/two');
  expect(rows.at(-1)?.ownerCwd).toBe('/fixture/one');
  expect(new Set(advances).size).toBe(advances.length);
});
it('keeps uncalled function cwd scoped and called transitions in their caller',()=>{
  const hooks:CollectionHooks<string|undefined>={locate:s=>s.context.cwd,advance:(r,s)=>{
    if(r.command.name==='cd')s.context.cwd=resolveFrom(s.context.cwd,literalText(r.command.args[0]!)!);
  }};
  const result=collectNoLimits('f() { cd one; ln -s /etc/hosts h; }; tee before; f; tee after',{cwd:'/fixture',hooks});
  expect(result.commands.find(r=>literalText(r.command.args[0]??{parts:[]})==='before')?.ownerCwd).toBe('/fixture');
  expect(result.commands.at(-1)?.ownerCwd).toBe('/fixture/one');
  expect(result.commands.filter(r=>r.command.name==='ln')).toHaveLength(1);
});
it('keeps wrapper cwd scoped to the carried executable',()=>{
  const hooks:CollectionHooks<string|undefined>={locate:s=>s.context.cwd,advance:(r,s)=>{
    if(r.command.name==='cd')s.context.cwd=resolveFrom(s.context.cwd,literalText(r.command.args[0]!)!);
  }};
  const result=collectNoLimits('env -C one tee inside; tee outside',{cwd:'/fixture',hooks});
  expect(result.commands.find(r=>literalText(r.command.args[0]??{parts:[]})==='inside')?.ownerCwd).toBe('/fixture/one');
  expect(result.commands.at(-1)?.ownerCwd).toBe('/fixture');
});
it('preserves unknown xargs-supplied producer operands',()=>{
  const rows=commands('xargs -I NAME ln -s ./plain NAME; tee other');
  expect(rows.find(r=>r.command.name==='ln')?.command.args.at(-1)?.parts[0]?.kind).toBe('var');
});
it('reads only exact authorized session script bodies and keeps opaque siblings',()=>{
  const calls:string[]=[];
  const result=collectNoLimits('source ./known; source ./unseen; tee h',{
    cwd:'/fixture',sessionEdits:new Set(['/fixture/known']),
    sessionFile:path=>{calls.push(path);return {text:'ln -s /etc/hosts h'};},
  });
  expect(calls).toEqual(['/fixture/known']);
  expect(result.commands.map(r=>r.command.name)).toEqual(['source','ln','source','tee']);
});
it('retains input provenance for extraction producers without opening archives',()=>{
  expect(commands('cpio -i < ./a.cpio')[0]?.command.stdin).toEqual({kind:'file',path:'/fixture/a.cpio'});
  expect(commands('cpio -i < "$archive"')[0]?.command.stdin?.kind).toBe('value');
});
it('retains a function redirect at both definition and caller cwd, once per source',()=>{
  const hooks:CollectionHooks<string|undefined>={locate:s=>s.context.cwd,advance:(r,s)=>{
    if(r.command.name==='cd')s.context.cwd=resolveFrom(s.context.cwd,literalText(r.command.args[0]!)!);
  }};
  const result=collectNoLimits('f() { printf x > hosts; }; cd /etc; f',{cwd:'/fixture',hooks});
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0]?.locations.map(l=>l.ownerCwd)).toEqual(['/fixture','/etc']);
});
