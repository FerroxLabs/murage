import { privateParkTemp, parkProtocolOptions, parkFixtureMkdir as mkdirSync, parkFixtureWrite as writeFileSync } from '../../testing/signal-park-fixture.ts';
import { createRequire, syncBuiltinESMExports } from "node:module";
import { lstatSync, chmodSync, existsSync, linkSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { defaultSecurityRunner, windowsSecurityEntrySync } from './storage.ts';
import { afterEach, expect, test } from 'vitest';
import { ParkFs, SignalParkError } from './park-fs.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() {
 const root = privateParkTemp(join(tmpdir(), 'park-fs-')); roots.push(root);
 mkdirSync(join(root, 'signal/auth/deep'), { recursive: true, mode: 0o700 });
 writeFileSync(join(root, 'signal/auth/deep/key'), 'random-fake-key', { mode: 0o600 });
 return { root, io: new ParkFs(root,parkProtocolOptions), key: join(root, 'signal/auth/deep/key') };
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
 const make = () => new ParkFs(root,{...parkProtocolOptions, ...(shape === 'owner' ? process.platform === 'win32' ? { windowsEntry: (path: string) => {
   const row = windowsSecurityEntrySync(path, 15_000);
   return row && path === root ? { ...row, sddl: row.sddl?.replace(/^O:(?:S-1-(?:\d+-)*\d+|[A-Z]{2})(?=[GDS]:|$)/, 'O:S-1-5-21-999-999-999-9999') ?? null } : row;
 } } : { uid: (process.getuid?.() ?? 2001) + 1 } : {}), after: op => trace.push(op),
 ...(shape === 'device' ? { stat: (path, options) => { const st = lstatSync(path, options); return path === key ? Object.assign(st, { dev: st.dev + 1n }) : st; } } : {}) });
 expect(() => make().fingerprint(join(root, 'signal'), true)).toThrow(SignalParkError);
 expect(trace).toEqual([]); expect(readFileSync(key, 'utf8')).toBe('random-fake-key');
});
test('RED18 flush every file then every descendant directory bottom-up before rename and both parents after', () => {
 const { root } = fixture(), trace: Array<[string,string]> = [];
 const io = new ParkFs(root,{...parkProtocolOptions,...(process.platform==='win32'?{sync:(child:string)=>{trace.push(['barrier',dirname(child)]);return 'synced' as const;}}:{})}); io.mkdir(join(root, 'bundle')); trace.length=0;
 const builtin=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
 const originalSync=builtin.fsyncSync,originalRename=builtin.renameSync,originalOpen=builtin.openSync,originalClose=builtin.closeSync;
 const paths=new Map<number,string>();
 // Track the descriptor opened by the real operation; /proc/self/fd exists
 // only on Linux. A flush is recorded only after the real fsync succeeds.
 builtin.openSync=((...args:Parameters<typeof builtin.openSync>)=>{const fd=Reflect.apply(originalOpen,builtin,args);paths.set(fd,String(args[0]));return fd;}) as typeof builtin.openSync;
 builtin.closeSync=fd=>{originalClose(fd);paths.delete(fd);};
 builtin.fsyncSync=fd=>{originalSync(fd);trace.push([builtin.fstatSync(fd).isDirectory()?'barrier':'flush',paths.get(fd)!]);};
 builtin.renameSync=(from,to)=>{originalRename(from,to);trace.push(['rename',String(to)]);};syncBuiltinESMExports();
 try { io.move(join(root, 'signal'), join(root, 'bundle/signal'), io.fingerprint(join(root, 'signal'), true), true); }
 finally {builtin.fsyncSync=originalSync;builtin.renameSync=originalRename;builtin.openSync=originalOpen;builtin.closeSync=originalClose;syncBuiltinESMExports();}
 expect(trace).toEqual([
 ['flush',join(root,'signal/auth/deep/key')], ['barrier',join(root,'signal/auth/deep')], ['barrier',join(root,'signal/auth')], ['barrier',join(root,'signal')],
 ['rename',join(root,'bundle/signal')], ['barrier',join(root,'bundle')], ['barrier',root],
 ]);
});
test('RED19 a post-rename throw stops immediately, without rollback', () => {
 const { root } = fixture(); const trace: string[] = [], io = new ParkFs(root,{...parkProtocolOptions, after: op => { trace.push(op); if (op === 'rename') throw new Error('power'); } });
 io.mkdir(join(root,'bundle')); trace.length = 0;
 expect(() => io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true)).toThrow('power');
 expect(trace.at(-1)).toBe('rename'); expect(existsSync(join(root,'signal'))).toBe(false); expect(existsSync(join(root,'bundle/signal/auth/deep/key'))).toBe(true);
});
test('RED20 unsupported ordinary sync is reported; required exclusion sync refuses', () => {
 const { root } = fixture(), io = new ParkFs(root,{...parkProtocolOptions, sync: () => 'unsupported' });
 expect(io.barrier(root)).toBe(false); expect(io.durabilityLimited).toBe(true); if(process.platform==='win32')expect(io.barrier(root,true)).toBe(false);else expect(() => io.barrier(root,true)).toThrow('durability');
});
test('RED2 private metadata is bounded and rejects broad mode without chmod', () => {
 const { io, key } = fixture();
 if(process.platform==='win32'){
  defaultSecurityRunner(win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows','System32','icacls.exe'),[key,'/grant','*S-1-1-0:R','/q'],{env:process.env,timeout:15_000});
  const before=windowsSecurityEntrySync(key,15_000);expect(before).not.toBeNull();
  expect(() => io.read(key,64,true)).toThrow('unsafe');expect(windowsSecurityEntrySync(key,15_000)?.sddl).toBe(before!.sddl);
 }else{
  chmodSync(key,0o644);expect(() => io.read(key,64,true)).toThrow();expect(statSync(key).mode & 0o777).toBe(0o644);
 }
});
test('RED1 Windows native reparse bit refuses a regular lstat entry independently of link type',()=>{
 const {root,key}=fixture(),sid='S-1-5-21-1-2-3-1001';
 const io=new ParkFs(root,{...parkProtocolOptions,platform:'win32',windowsSid:()=>sid,windowsRun:()=>{throw new Error('Unexpected native security request');},windowsEntry:path=>({path,attributes:(statSync(path).isDirectory()?16:0)|(path===key?0x400:0),sddl:`O:${sid}D:P(A;;FA;;;${sid})`})});
 expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('unsafe');
});
test('RED3 Windows broad ACL refuses without repair',()=>{
 const {root,key}=fixture(),sid='S-1-5-21-1-2-3-1001';
 const io=new ParkFs(root,{...parkProtocolOptions,platform:'win32',windowsSid:()=>sid,windowsRun:()=>{throw new Error('Unexpected native security request');},windowsEntry:path=>({path,attributes:statSync(path).isDirectory()?16:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})${path===key?'(A;;FA;;;WD)':''}`})});
 expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('unsafe');
});
test('RED12 an existing empty destination is never replaced',()=>{
 const {root,io,key}=fixture();io.mkdir(join(root,'bundle/signal'));const before=statSync(join(root,'bundle/signal')).ino;
 expect(()=>io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true)).toThrow('conflict');
 expect(statSync(join(root,'bundle/signal')).ino).toBe(before);expect(readFileSync(key,'utf8')).toBe('random-fake-key');
});
test('RED22 depth and deadline bounds stop without a move',()=>{
 const {root}=fixture();mkdirSync(join(root,'signal',...Array.from({length:33},(_,i)=>`d${i}`)),{recursive:true,mode:0o700});
 expect(()=>new ParkFs(root,parkProtocolOptions).fingerprint(join(root,'signal'),true)).toThrow('bound');
 expect(()=>new ParkFs(root,{...parkProtocolOptions,deadline:Date.now()-1})).toThrow('bound');
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
 try{new ParkFs(root,{...parkProtocolOptions,after:op=>trace.push(op)}).write(join(root,'metadata.json'),{version:1});}
 finally{spy.mockRestore();}
 expect(calls).toEqual([expect.objectContaining({mode:0o600,syncDir:true,keepFailedTemp:true})]);expect(trace.slice(-2)).toEqual(['write','barrier']);
});
test('RED19 sync throw propagates without another mutation',()=>{
 const {root}=fixture(),trace:string[]=[],failure=new Error('SYNC_THROW');let armed=false;
 const io=new ParkFs(root,{...parkProtocolOptions,after:op=>{trace.push(op);if(op==='rename')armed=true;},sync:()=>{if(armed)throw failure;return 'synced';}});
 io.mkdir(join(root,'bundle'));trace.length=0;
 let caught;try{io.move(join(root,'signal'),join(root,'bundle/signal'),io.fingerprint(join(root,'signal'),true),true);trace.push('NEXT_MUTATION');}catch(error){caught=error;}
 expect(caught).toBe(failure);expect(trace.at(-1)).toBe('rename');
});

test('RED11 fingerprint records directory size as well as file size in the canonical tuple',()=>{
 const {root,io}=fixture(),before=io.fingerprint(join(root,'signal'),true),directory=join(root,'signal/auth/deep');
 const changed=new ParkFs(root,{...parkProtocolOptions,stat:(path,options)=>{const st=lstatSync(path,options);return path===directory?Object.assign(st,{size:st.size+1n}):st;}});
 expect(changed.fingerprint(join(root,'signal'),true).fp).not.toBe(before.fp);
});
test('RED4 same-device nested bind mount refuses without following or changing bytes',()=>{
 const {root,key}=fixture(),directory=join(root,'signal/auth/deep'),before=readFileSync(key),io=new ParkFs(root,{...parkProtocolOptions,platform:'linux',uid:statSync(root).uid,mounts:()=>[directory]});
 expect(statSync(directory).dev).toBe(statSync(root).dev);expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('device');expect(readFileSync(key)).toEqual(before);
});
test('RED4 native mount projection decodes kernel escapes and refuses partial mount tables',async()=>{
 const {parseSignalMounts}=await import('./park-proc.ts');
 expect(parseSignalMounts(Buffer.from('1 0 0:1 / /private/a\\040b rw - ext4 /disk rw\n'),Date.now()+1000)).toEqual([resolve('/private/a b')]);
 expect(parseSignalMounts(Buffer.alloc(0),Date.now()+1000)).toBeNull();
 expect(parseSignalMounts(Buffer.from('partial mount record'),Date.now()+1000)).toBeNull();
 expect(parseSignalMounts(Buffer.alloc(1024*1024+1),Date.now()+1000)).toBeNull();
});

test('RED22 expired deadline starts no native mount projection',async()=>{
 const {root}=fixture(),{vi}=await import('vitest'),mounts=vi.fn(()=>[]);
 expect(()=>new ParkFs(root,{...parkProtocolOptions,deadline:Date.now()-1,mounts})).toThrow('bound');expect(mounts).not.toHaveBeenCalled();
});

// A protocol sync seam must never hide the host's native durability limit.
test('RED20 native directory durability is reported with the platform barrier policy',()=>{
 const {root}=fixture(),io=new ParkFs(root);
 if(process.platform==='win32'){
  expect(io.barrier(root)).toBe(false);expect(io.durabilityLimited).toBe(true);
  expect(io.barrier(root,true)).toBe(false);expect(io.durabilityLimited).toBe(true);
 }else{
  expect(io.barrier(root,true)).toBe(true);expect(io.durabilityLimited).toBe(false);
 }
});
