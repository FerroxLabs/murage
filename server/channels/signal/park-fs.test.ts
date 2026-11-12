import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ParkFs, SignalParkError } from './park-fs.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'park-fs-')); roots.push(root);
 mkdirSync(join(root, 'signal/auth/deep'), { recursive: true, mode: 0o700 });
 writeFileSync(join(root, 'signal/auth/deep/key'), 'random-fake-key', { mode: 0o600 });
 return { root, io: new ParkFs(root), key: join(root, 'signal/auth/deep/key') };
}
test('RUN fingerprint and rename preserve inode and bytes', () => {
 const { root, io, key } = fixture(), before = statSync(key).ino;
 const manifest = io.fingerprint(join(root, 'signal'), true);
 io.mkdir(join(root, 'bundle')); io.move(join(root, 'signal'), join(root, 'bundle/signal'), manifest, true);
 expect(existsSync(join(root, 'signal'))).toBe(false);
 expect(statSync(join(root, 'bundle/signal/auth/deep/key')).ino).toBe(before);
 expect(readFileSync(join(root, 'bundle/signal/auth/deep/key'), 'utf8')).toBe('random-fake-key');
 expect(io.fingerprint(join(root, 'bundle/signal'), true)).toEqual(manifest);
});
test('RED11 equal-length changes alter fingerprints; log contents have the narrower exclusion', () => {
 const { root, io, key } = fixture(), original = io.fingerprint(join(root, 'signal'), true);
 writeFileSync(key, 'changed-fakekey'); expect(io.fingerprint(join(root, 'signal'), true).fp).not.toBe(original.fp);
 mkdirSync(join(root, 'signal/log')); writeFileSync(join(root, 'signal/log/x'), 'aaa');
 const before = io.fingerprint(join(root, 'signal'), true);
 writeFileSync(join(root, 'signal/log/x'), 'bbb'); expect(io.fingerprint(join(root, 'signal'), true)).toEqual(before);
});
for (const shape of ['symlink', 'hardlink', 'owner', 'device'] as const) test(`RED1-4 ${shape} refuses without a move or repair`, () => {
 const { root, key } = fixture(); const trace: string[] = [];
 if (shape === 'symlink') symlinkSync(key, join(root, 'signal/alias'));
 if (shape === 'hardlink') linkSync(key, join(root, 'signal/alias'));
 const make = () => new ParkFs(root, { ...(shape === 'owner' ? { uid: (process.getuid?.() ?? 2001) + 1 } : {}), after: op => trace.push(op),
 ...(shape === 'device' ? { stat: path => { const st = statSync(path); return path === key ? Object.assign(st, { dev: st.dev + 1 }) : st; } } : {}) });
 expect(() => make().fingerprint(join(root, 'signal'), true)).toThrow(SignalParkError);
 expect(trace).toEqual([]); expect(readFileSync(key, 'utf8')).toBe('random-fake-key');
});
test('RED18 flush every file then every descendant directory bottom-up before rename and both parents after', () => {
 const { root } = fixture(), trace: Array<[string,string]> = [];
 const io = new ParkFs(root); io.mkdir(join(root, 'bundle'));
 const builtin=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
 const originalSync=builtin.fsyncSync,originalRename=builtin.renameSync;
 builtin.fsyncSync=fd=>{const path=builtin.readlinkSync(`/proc/self/fd/${fd}`);originalSync(fd);trace.push([builtin.fstatSync(fd).isDirectory()?'barrier':'flush',path]);};
 builtin.renameSync=(from,to)=>{originalRename(from,to);trace.push(['rename',String(to)]);};syncBuiltinESMExports();
 try { io.move(join(root, 'signal'), join(root, 'bundle/signal'), io.fingerprint(join(root, 'signal'), true), true); }
 finally {builtin.fsyncSync=originalSync;builtin.renameSync=originalRename;syncBuiltinESMExports();}
 expect(trace).toEqual([
 ['flush',join(root,'signal/auth/deep/key')], ['barrier',join(root,'signal/auth/deep')], ['barrier',join(root,'signal/auth')], ['barrier',join(root,'signal')],
 ['rename',join(root,'bundle/signal')], ['barrier',join(root,'bundle')], ['barrier',root],
 ]);
});
test('RED19 a post-rename throw stops immediately, without rollback', () => {
 const { root } = fixture(); const trace: string[] = [], io = new ParkFs(root, { after: op => { trace.push(op); if (op === 'rename') throw new Error('power'); } });
 io.mkdir(join(root,'bundle')); trace.length = 0;
 expect(() => io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true)).toThrow('power');
 expect(trace.at(-1)).toBe('rename'); expect(existsSync(join(root,'signal'))).toBe(false); expect(existsSync(join(root,'bundle/signal/auth/deep/key'))).toBe(true);
});
test('RED20 unsupported ordinary sync is reported; required exclusion sync refuses', () => {
 const { root } = fixture(), io = new ParkFs(root, { sync: () => 'unsupported' });
 expect(io.barrier(root)).toBe(false); expect(io.durabilityLimited).toBe(true); expect(() => io.barrier(root,true)).toThrow('durability');
});
test('RED2 private metadata is bounded and rejects broad mode without chmod', () => {
 const { io, key } = fixture(); chmodSync(key,0o644);
 expect(() => io.read(key,64,true)).toThrow(); expect(statSync(key).mode & 0o777).toBe(0o644);
});
test('RED1 Windows native reparse bit refuses a regular lstat entry independently of link type',()=>{
 const {root,key}=fixture(),sid='S-1-5-21-1-2-3-1001';
 const io=new ParkFs(root,{platform:'win32',windowsSid:()=>sid,windowsEntry:path=>({path,attributes:(statSync(path).isDirectory()?16:0)|(path===key?0x400:0),sddl:`O:${sid}D:P(A;;FA;;;${sid})`})});
 expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('unsafe');
});
test('RED3 Windows broad ACL refuses without repair',()=>{
 const {root,key}=fixture(),sid='S-1-5-21-1-2-3-1001';
 const io=new ParkFs(root,{platform:'win32',windowsSid:()=>sid,windowsEntry:path=>({path,attributes:statSync(path).isDirectory()?16:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})${path===key?'(A;;FA;;;WD)':''}`})});
 expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('unsafe');
});
test('RED12 an existing empty destination is never replaced',()=>{
 const {root,io,key}=fixture();io.mkdir(join(root,'bundle/signal'));const before=statSync(join(root,'bundle/signal')).ino;
 expect(()=>io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true)).toThrow('conflict');
 expect(statSync(join(root,'bundle/signal')).ino).toBe(before);expect(readFileSync(key,'utf8')).toBe('random-fake-key');
});
test('RED22 depth and deadline bounds stop without a move',()=>{
 const {root}=fixture();mkdirSync(join(root,'signal',...Array.from({length:33},(_,i)=>`d${i}`)),{recursive:true,mode:0o700});
 expect(()=>new ParkFs(root).fingerprint(join(root,'signal'),true)).toThrow('bound');
 expect(()=>new ParkFs(root,{deadline:Date.now()-1})).toThrow('bound');
});
test('RED1 Windows one-entry projection reuses the bounded storage security reader without traversal',async()=>{
 const {windowsSecurityEntrySync}=await import('./storage.ts');let seen='';
 const row=windowsSecurityEntrySync('C:\\private',1000,(_exe,_args,options)=>{expect(options.timeout).toBe(1000);expect(options.env.MURAGE_SIGNAL_POINT).toBe('1');expect(JSON.parse(options.env.MURAGE_SIGNAL_ROOTS!)).toEqual(Array(6).fill('C:\\private'));seen=options.input!;return JSON.stringify({path:'C:\\private',attributes:1024,sddl:null});},{SystemRoot:'C:\\Windows'});
 expect(row).toEqual({path:'C:\\private',attributes:1024,sddl:null});expect(seen).toContain("if ($env:MURAGE_SIGNAL_POINT -eq '1') { Visit-SignalPath $roots[0] $false; return }");
});
test('RED18 protocol metadata opts into syncDir and retained private temps before checked parent barrier',async()=>{
 const {root}=fixture(),atomic=await import('../../atomic.ts'),calls:unknown[]=[];
 const {vi}=await import('vitest');const real=atomic.writeFileAtomic;
 const spy=vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>{calls.push(options);return real(path,data,options);});
 const trace:string[]=[];
 try{new ParkFs(root,{after:op=>trace.push(op)}).write(join(root,'metadata.json'),{version:1});}
 finally{spy.mockRestore();}
 expect(calls).toEqual([expect.objectContaining({mode:0o600,syncDir:true,keepFailedTemp:true})]);expect(trace.slice(-2)).toEqual(['write','barrier']);
});
test('RED19 sync throw propagates without another mutation',()=>{
 const {root}=fixture(),trace:string[]=[],failure=new Error('SYNC_THROW');let armed=false;
 const io=new ParkFs(root,{after:op=>{trace.push(op);if(op==='rename')armed=true;},sync:()=>{if(armed)throw failure;return 'synced';}});
 io.mkdir(join(root,'bundle'));trace.length=0;
 let caught;try{io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true);trace.push('NEXT_MUTATION');}catch(error){caught=error;}
 expect(caught).toBe(failure);expect(trace.at(-1)).toBe('rename');
});

test('RED11 fingerprint records directory size as well as file size in the canonical tuple',()=>{
 const {root,io}=fixture(),before=io.fingerprint(join(root,'signal'),true),directory=join(root,'signal/auth/deep');
 const changed=new ParkFs(root,{stat:path=>{const st=statSync(path);return path===directory?Object.assign(st,{size:st.size+1}):st;}});
 expect(changed.fingerprint(join(root,'signal'),true).fp).not.toBe(before.fp);
});
test('RED4 same-device nested bind mount refuses without following or changing bytes',()=>{
 const {root,key}=fixture(),directory=join(root,'signal/auth/deep'),before=readFileSync(key),io=new ParkFs(root,{mounts:()=>[directory]});
 expect(statSync(directory).dev).toBe(statSync(root).dev);expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('device');expect(readFileSync(key)).toEqual(before);
});
test('RED4 native mount projection decodes kernel escapes and refuses partial mount tables',async()=>{
 const {parseSignalMounts}=await import('./park-proc.ts');
 expect(parseSignalMounts(Buffer.from('1 0 0:1 / /private/a\\040b rw - ext4 /disk rw\n'),Date.now()+1000)).toEqual(['/private/a b']);
 expect(parseSignalMounts(Buffer.alloc(0),Date.now()+1000)).toBeNull();
 expect(parseSignalMounts(Buffer.from('partial mount record'),Date.now()+1000)).toBeNull();
 expect(parseSignalMounts(Buffer.alloc(1024*1024+1),Date.now()+1000)).toBeNull();
});

test('RED22 expired deadline starts no native mount projection',async()=>{
 const {root}=fixture(),{vi}=await import('vitest'),mounts=vi.fn(()=>[]);
 expect(()=>new ParkFs(root,{deadline:Date.now()-1,mounts})).toThrow('bound');expect(mounts).not.toHaveBeenCalled();
});
