// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const launcher=fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py",import.meta.url));
describe("actual privileged launcher cleanup function with disposable UID fixture",()=>{
  it("erases only known credentials, preserves config/data and never follows symlink parents",()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"b1b-launcher-")));  // the launcher walks with O_NOFOLLOW; macOS temp sits behind /var
    try {
      const output=execFileSync("python3",["-I","-c",`
import os, sys, json, runpy
m=runpy.run_path(sys.argv[1]); root=sys.argv[2]; owners={os.getuid()}
os.chmod(root,0o755)
for engine,paths in m['RECOVERY_CREDENTIALS'].items():
    for path in paths:
        target=root+'/'+engine+'/'+path
        if engine == 'kimiAgent': target += '/kimi-code.json'
        os.makedirs(os.path.dirname(target),exist_ok=True)
        with open(target,'w') as f: f.write('fake-token')
    with open(root+'/'+engine+'/keep-config.json','w') as f: f.write('configuration')
m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,owners,os.getuid())
for engine,paths in m['RECOVERY_CREDENTIALS'].items():
    assert all(not os.path.lexists(root+'/'+engine+'/'+p) for p in paths)
    assert os.path.isfile(root+'/'+engine+'/keep-config.json')
# tokens owned by nobody in the owner set are refused (directories may be root_owner's: prepare_credential_dirs makes them)
for engine,paths in m['RECOVERY_CREDENTIALS'].items():
    for path in paths:
        target=root+'/'+engine+'/'+path
        if engine == 'kimiAgent': target += '/kimi-code.json'
        os.makedirs(os.path.dirname(target),exist_ok=True)
        with open(target,'w') as f: f.write('fake-token')
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,set(),os.getuid()); raise AssertionError('owner accepted')
except m['CleanupFailed'] as e: assert all(v.startswith('failed') for v in e.results.values()), e.results
assert all(os.path.lexists(root+'/'+e+'/'+p) for e,ps in m['RECOVERY_CREDENTIALS'].items() for p in ps)
outside=root+'/outside'; os.mkdir(outside)
with open(outside+'/auth.json','w') as f: f.write('preserve')
def reseed():
    for engine,paths in m['RECOVERY_CREDENTIALS'].items():
        for path in paths:
            target=root+'/'+engine+'/'+path
            if engine == 'kimiAgent': target += '/kimi-code.json'
            os.makedirs(os.path.dirname(target),exist_ok=True)
            with open(target,'w') as f: f.write('fake-token')
def swap_parent(kind):
    reseed()
    p=root+'/codex/.codex'
    import shutil; shutil.rmtree(p)
    if kind=='symlink': os.symlink(outside,p)
    elif kind=='fifo': os.mkfifo(p)
    else: open(p,'w').write('x')
    r=m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,owners,os.getuid())
    assert r['codex']=='ok' and set(r.values())=={'ok'}, r
    assert not os.path.lexists(p), kind
    assert all(not os.path.lexists(root+'/'+e+'/'+x) for e,ps in m['RECOVERY_CREDENTIALS'].items() for x in ps), kind
    assert open(outside+'/auth.json').read() == 'preserve'
for kind in ('symlink','fifo','file'): swap_parent(kind)
# one engine failing (foreign owner) must not stop the others, and is reported per engine
reseed()
real_erase=m['erase_credential_at']
def failing(parent,name,owners,deadline=None):
    if name=='auth.json' and os.path.exists(root+'/codex/.codex/auth.json') and parent is not None and os.fstat(parent).st_ino==os.stat(root+'/codex/.codex').st_ino: raise ValueError('boom')
    return real_erase(parent,name,owners,deadline)
m['cleanup_engine_signins'].__globals__['erase_credential_at']=failing
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,owners,os.getuid()); raise AssertionError('failure hidden')
except m['CleanupFailed'] as e:
    assert e.results['codex'].startswith('failed') and e.results['claudeAgent']=='ok' and e.results['kimiAgent']=='ok', e.results
assert all(not os.path.lexists(root+'/'+e+'/'+x) for e,ps in m['RECOVERY_CREDENTIALS'].items() if e!='codex' for x in ps)
m['cleanup_engine_signins'].__globals__['erase_credential_at']=real_erase
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup','path':outside},root,owners,os.getuid()); raise AssertionError('path accepted')
except ValueError: pass
print('credential cleanup fixture passed')
`,launcher,root],{encoding:"utf8"});
      expect(output.trim()).toBe("credential cleanup fixture passed");
    } finally {removeTempDirSync(root);}
  });
  // Production ownership: the engine root, each engine home and every directory
  // prepare_credential_dirs creates are root's (uid 0); what the CLIs write is the turn
  // user's (uid 2002). Unprivileged, so st_uid comes from a stat overlay keyed by (dev, ino).
  it("erases every engine's credentials under root-owned credential directories, and still refuses a foreign or root token",()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"b1b-layout-")));
    try {
      const output=execFileSync("python3",["-I","-c",`
import os, sys, runpy
m=runpy.run_path(sys.argv[1]); root=sys.argv[2]; me=os.getuid(); TURN=2002
os.chmod(root,0o755)
uids={}
def own(path,uid): st=os.lstat(path); uids[(st.st_dev,st.st_ino)]=uid
def seed():
    uids.clear(); own(root,0)
    for engine,paths in m['RECOVERY_CREDENTIALS'].items():
        home=root+'/'+engine; os.makedirs(home,exist_ok=True); own(home,0)
        fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY); m['prepare_credential_dirs'](fd,engine,None,{me,0,TURN}); os.close(fd)
        for d in m['credential_dirs'](engine):
            walked=home
            for part in d.split('/'): walked+='/'+part; own(walked,0)
        for path in paths:
            target=home+'/'+path
            if engine=='kimiAgent':
                os.makedirs(target,exist_ok=True); own(target,TURN); target+='/kimi-code.json'
            with open(target,'w') as f: f.write('fake-token')
            own(target,TURN)
real_stat,real_fstat=os.stat,os.fstat
def overlay(st):
    uid=uids.get((st.st_dev,st.st_ino))
    if uid is None: return st
    t=list(st); t[4]=uid; return os.stat_result(t)
os.stat=lambda *a,**k: overlay(real_stat(*a,**k)); os.fstat=lambda fd: overlay(real_fstat(fd))
seed()
assert all(os.path.isdir(root+'/'+e+'/'+d) for e in m['RECOVERY_CREDENTIALS'] for d in m['credential_dirs'](e))
r=m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,{TURN},0)
assert set(r.values())=={'ok'}, r
assert all(not os.path.lexists(root+'/'+e+'/'+p) for e,ps in m['RECOVERY_CREDENTIALS'].items() for p in ps)
assert all(os.path.isdir(root+'/'+e+'/'+d) for e in m['RECOVERY_CREDENTIALS'] for d in m['credential_dirs'](e))
# a credential directory owned by neither root nor the turn user is refused
seed(); own(root+'/codex/.codex',3003)
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,{TURN},0); raise AssertionError('foreign dir accepted')
except m['CleanupFailed'] as e: assert e.results['codex'].startswith('failed') and e.results['claudeAgent']=='ok', e.results
assert os.path.isfile(root+'/codex/.codex/auth.json')
# the token itself must still be the turn user's: a root-owned token is not erased
seed(); own(root+'/grokAgent/.grok/auth.json',0)
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,{TURN},0); raise AssertionError('root token accepted')
except m['CleanupFailed'] as e: assert e.results['grokAgent'].startswith('failed') and e.results['codex']=='ok', e.results
assert os.path.isfile(root+'/grokAgent/.grok/auth.json')
# a root-owned non-directory where a credential directory belongs is refused, not unlinked
seed(); import shutil; shutil.rmtree(root+'/claudeAgent/.claude'); open(root+'/claudeAgent/.claude','w').write('x'); own(root+'/claudeAgent/.claude',0)
try: m['cleanup_engine_signins']({'mode':'engine-signin-cleanup'},root,{TURN},0); raise AssertionError('root file unlinked')
except m['CleanupFailed'] as e: assert e.results['claudeAgent'].startswith('failed'), e.results
assert os.path.isfile(root+'/claudeAgent/.claude')
print('production layout cleanup passed')
`,launcher,root],{encoding:"utf8"});
      expect(output.trim()).toBe("production layout cleanup passed");
    } finally {removeTempDirSync(root);}
  });
});
