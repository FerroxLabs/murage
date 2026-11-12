import {mkdtempSync,mkdirSync,symlinkSync} from 'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{afterEach,beforeEach,expect,test,vi}from'vitest';
import{removeTempDirSync}from'../../testing/cleanup.ts';
const fake=vi.hoisted(()=>({pids:1,mountHidden:false,rootHidden:false,rootFds:new Map<number,string>(),hidden:false,hidepid:false,unreadable:'',badStat:false,churn:false,gone:false,argv:Buffer.from(''),statReads:0,reads:0,closed:0,fd:900001,open:new Set<number>(),offsets:new Map<number,number>(),buffers:new Map<number,Buffer>()}));
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();
 return{...actual,
  readlinkSync:(path:unknown,...args:unknown[])=>{const p=String(path);if(/^\/proc\/(self|1)\/ns\/mnt$/.test(p))return fake.mountHidden&&p.includes('/1/')?'mnt:[other]':'mnt:[initial]';if(/^\/proc\/(self|1|[0-9]+)\/ns\/pid$/.test(p)){if(fake.unreadable==='namespace')throw Object.assign(new Error('denied'),{code:'EACCES'});return fake.hidden?'pid:[nested]':'pid:[4026531836]';}return actual.readlinkSync(path as string,...args as []);},
  readFileSync:(path:unknown,...args:unknown[])=>{const p=String(path);if(p==='/proc/self/mountinfo')return`1 0 0:5 / /proc rw${fake.hidepid?',hidepid=2':''} - proc proc rw`;
   if(/^\/proc\/[0-9]+\/stat$/.test(p)){if(fake.badStat)return'not a process stat';fake.statReads++;if(fake.gone&&fake.statReads>1)throw Object.assign(new Error('gone'),{code:'ENOENT'});const fields=Array(20).fill('0');fields[0]='S';fields[19]=fake.churn&&fake.statReads>1?'101':'100';return`42 (java) ${fields.join(' ')}`;}
   return actual.readFileSync(path as string,...args as []);},
  opendirSync:(path:unknown,...args:unknown[])=>{if(String(path)!=='/proc')return actual.opendirSync(path as string,...args as []);let n=0;return{readSync:()=>n++<fake.pids?{name:String(41+n)}:null,closeSync:()=>{fake.closed++;}};},
  fstatSync:(fd:number)=>{if(fake.rootFds.has(fd)){const st=actual.statSync('/');return fake.rootHidden&&fake.rootFds.get(fd)==='/proc/1/root'?Object.assign(st,{ino:st.ino+1}):st;}return actual.fstatSync(fd);},
  openSync:(path:unknown,...args:unknown[])=>{if(String(path)==='/'||String(path)==='/proc/1/root'){const fd=fake.fd++;fake.rootFds.set(fd,String(path));return fd;}if(String(path)==='/proc/self/mountinfo'||/^\/proc\/[0-9]+\/cmdline$/.test(String(path))){if(fake.unreadable==='cmdline'&&String(path)!=='/proc/self/mountinfo')throw Object.assign(new Error('denied'),{code:'EACCES'});const fd=fake.fd++;fake.open.add(fd);fake.offsets.set(fd,0);fake.buffers.set(fd,String(path)==='/proc/self/mountinfo'?Buffer.from(`1 0 0:5 / /proc rw${fake.hidepid?',hidepid=2':''} - proc proc rw`):fake.argv);return fd;}return actual.openSync(path as string,...args as [number]);},
  readSync:(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{if(fake.open.has(fd)){fake.reads++;const start=fake.offsets.get(fd)??0;const data=fake.buffers.get(fd)!;const n=data.copy(buffer,offset,start,Math.min(data.length,start+length));fake.offsets.set(fd,start+n);return n;}return actual.readSync(fd,buffer,offset,length,position);},
  closeSync:(fd:number)=>{if(fake.rootFds.delete(fd))return;if(fake.open.delete(fd)){fake.offsets.delete(fd);fake.buffers.delete(fd);return;}return actual.closeSync(fd);},
 };
});
// The lease module is loaded by global test setup before fs mocks. Supply its
// native probe boundary explicitly so fake PID 42 never depends on a real PID.
vi.mock('../../../electron/data-dir-lease.mjs',async original=>{
 const actual=await original<Record<string,unknown>>();return{...actual,
  linuxProcStat:()=>{fake.statReads++;if(fake.badStat||(fake.gone&&fake.statReads>1))return null;return['S',fake.churn&&fake.statReads>1?'101':'100'];},
  processIsAlive:()=>!fake.gone,
 };
});
import{discoverSignalChildren}from'./park-fence.ts';
let root:string,auth:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'park-proc-'));auth=join(root,'signal/auth');mkdirSync(auth,{recursive:true,mode:0o700});Object.assign(fake,{pids:1,mountHidden:false,rootHidden:false,hidden:false,hidepid:false,unreadable:'',badStat:false,churn:false,gone:false,argv:Buffer.from('/usr/bin/other\0'),statReads:0,reads:0,closed:0});vi.spyOn(process,'kill').mockImplementation(()=>{if(fake.gone)throw Object.assign(new Error('dead'),{code:'ESRCH'});return true;});});
afterEach(()=>{vi.restoreAllMocks();removeTempDirSync(root);});
function argv(config:string,jar='signal-cli.jar'){return Buffer.from(['/bundled/bin/java','-jar','/bundled/'+jar,'--config',config].join('\0')+'\0');}
test('RED31 legacy unrecorded Java with exact argv/config path is detected',()=>{fake.argv=argv(auth);expect(discoverSignalChildren(auth,Date.now()+5000)).toBe(false);});
test('RUN RED31 complete empty/unrelated process set can adopt without substring matching',()=>{const first=discoverSignalChildren(auth,Date.now()+5000);expect(first,JSON.stringify({statReads:fake.statReads,reads:fake.reads,closed:fake.closed})).toBe(true);fake.argv=argv(auth+'-different');expect(discoverSignalChildren(auth,Date.now()+5000)).toBe(true);fake.argv=argv(auth,'unrelated.jar');expect(discoverSignalChildren(auth,Date.now()+5000)).toBe(true);});
test('RED32 canonical config aliases match exactly',()=>{const alias=join(root,'alias');symlinkSync(join(root,'signal'),alias);fake.argv=argv(join(alias,'auth'));expect(discoverSignalChildren(auth,Date.now()+5000)).toBe(false);});
for(const shape of ['namespace','cmdline','stat','hidden','hidepid','churn','malformed','utf8','oversize','cap','total','mount-view','root-view','missing-config','duplicate-config','deadline'] as const)test(`RED32 incomplete Linux discovery ${shape} refuses`,()=>{
 if(shape==='mount-view')fake.mountHidden=true;if(shape==='root-view')fake.rootHidden=true;
 if(shape==='namespace'||shape==='cmdline')fake.unreadable=shape;if(shape==='stat')fake.badStat=true;if(shape==='hidden')fake.hidden=true;if(shape==='hidepid')fake.hidepid=true;if(shape==='churn')fake.churn=true;
 if(shape==='malformed')fake.argv=Buffer.from('/bundled/java');if(shape==='utf8')fake.argv=Buffer.from([255,0]);if(shape==='oversize')fake.argv=Buffer.alloc(1024*1024+2,1);if(shape==='cap'){fake.pids=65537;const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);const alloc=Buffer.alloc;vi.spyOn(Buffer,'alloc').mockImplementation(((size:number,...args:unknown[])=>alloc(size===1024*1024+1?128:size,...args as [])) as typeof Buffer.alloc);}
 if(shape==='total'){fake.pids=65;fake.argv=Buffer.alloc(1024*1024,97);fake.argv[fake.argv.length-1]=0;const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);}
 if(shape==='missing-config')fake.argv=Buffer.from('/bundled/java\0-jar\0/bundled/signal-cli.jar\0');if(shape==='duplicate-config')fake.argv=Buffer.from('/bundled/java\0-jar\0/bundled/signal-cli.jar\0--config\0/other\0--config\0/other2\0');
 expect(discoverSignalChildren(auth,Date.now()+(shape==='deadline'?-1:5000))).toBe(false);
 if(shape==='cap')expect(fake.statReads).toBe(65536*2);if(shape==='total')expect(fake.statReads).toBe(129);
});
test('RUN RED32 vanished PID is skipped only when its exit is proved',()=>{fake.gone=true;expect(discoverSignalChildren(auth,Date.now()+5000)).toBe(true);expect(fake.closed).toBe(1);});
