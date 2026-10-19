# SPDX-License-Identifier: AGPL-3.0-or-later
"""Actual helper protocol fixtures: privileged adapters are always replaced."""
import copy
import importlib.util
import json
import os
import signal
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('namespace_fixture', sys.argv[1])
n = importlib.util.module_from_spec(spec); spec.loader.exec_module(n)
def forbidden(*args, **kwargs): raise AssertionError('REAL PRIVILEGED OPERATION FORBIDDEN')
n.libc_call = forbidden
n.LinuxSystem.run = forbidden
# murage-browser-sandbox gates the browser bwrap; the fixture host has no such group.
n.grp = SimpleNamespace(getgrnam=lambda name: SimpleNamespace(gr_gid={'murage-browser-sandbox': 5151}[name]))

def tree(seed):
    host = {'pid': [1, 1], 'pid_for_children': [1, 1], 'net': [1, 2], 'mnt': [1, 3]}
    m = {'pid': seed, 'start': '10', 'boot': 'boot', 'artifact': 'fixed', 'exe': '/usr/bin/python3', 'ns': host}
    p = copy.deepcopy(m); p['pid'] += 1; p['ns']['pid_for_children'] = [1, seed]
    k = copy.deepcopy(p); k['pid'] += 1; k['ns']['pid'] = [1, seed]; k['ns']['net'] = [1, seed + 1]
    return {'M': m, 'P': p, 'K': k}

class Fake(n.LinuxSystem):
    def __init__(self): self.events=[]; self.tasks={}; self.clock=0; self.pins={}; self.fail=None; self.stubborn=False
    def now(self): return self.clock
    def sleep(self, seconds): self.clock += seconds
    def network_context(self): return {'dev':'eth0','index':2,'addresses':['203.0.113.1']}
    def inspect(self, task, allow_dead=False):
        self.events.append(('inspect',task['pid']))
        actual=self.tasks.get(task['pid'])
        if actual is None: raise ProcessLookupError()
        if actual != task: raise ValueError('identity changed')
        return task['pid']
    def live(self, fd): return fd in self.tasks if isinstance(fd,int) else True
    def close(self, fd): self.events.append(('close',fd))
    def signal(self, fd, sig):
        self.events.append(('signal',fd,sig))
        if not self.stubborn or sig == signal.SIGKILL:
            if sig == signal.SIGUSR1: self.tasks.clear()
            else: self.tasks.pop(fd,None)
    def pin(self,directory,kind,task):
        self.events.append(('pin',kind))
        if self.fail == kind: raise RuntimeError(kind)
        self.pins[(directory,kind)]=task['ns'][kind]
    def open_pin(self,directory,kind,task):
        if self.pins.get((directory,kind)) != task['ns'][kind]: raise ValueError('pin changed')
        return kind
    def unpin(self,directory,kind,task): self.events.append(('unpin',kind)); self.pins.pop((directory,kind),None)
    def network_create(self,value,fd):
        self.events.append(('network',value['bot'],fd))
        if self.fail == 'network': raise RuntimeError('network')
    def network_delete(self,value):
        self.events.append(('delete',value['bot']))
        if self.fail == 'delete': raise RuntimeError('delete')
    def active(self,value,enabled):
        self.events.append(('active',value['bot'],enabled))
        if self.fail == 'active' and enabled: raise RuntimeError('active')
    def close_browser(self,value,deadline): self.events.append(('browser-close',value['bot'],deadline))
    def kill_scopes(self,bot,keep=None): self.events.append(('kill-scopes',bot) if keep is None else ('kill-scopes',bot,keep))
    def reap_parent(self,pid,deadline): self.events.append(('reap',pid)); self.tasks.pop(pid,None)

def setup(root, bot='a', seed=100):
    registry=n.Registry(root,os.getuid()); system=Fake(); ctl=n.NamespaceController(registry,system)
    value=ctl.allocate(bot); value['tasks']=tree(seed); system.tasks=copy.deepcopy({x['pid']:x for x in value['tasks'].values()}); registry.write(value)
    return registry,system,ctl,value

def ready(root,bot='a',seed=100):
    r,s,c,v=setup(root,bot,seed); c.complete_creation(v); return r,s,c,v

def run(case,root):
    if case == 'reuse':
        r,s,c,v=ready(root); original=copy.deepcopy(r.read('a')); c.ensure('a'); c.ensure('a'); assert r.read('a')==original
        b=c.allocate('b'); b['tasks']=tree(200); s.tasks.update({x['pid']:x for x in b['tasks'].values()}); c.complete_creation(b)
        assert b['slot']!=v['slot'] and b['address']!=v['address'] and b['tasks']['K']['ns']!=v['tasks']['K']['ns']
        assert open(r.directory('a')+'/resolv.conf','rb').read()==n.RESOLVER
        assert s.events.index(('network','a','net')) < s.events.index(('active','a',True))
    elif case == 'identity':
        for key in ['start','boot','artifact','exe']:
            r,s,c,v=ready(root+'/'+key); s.tasks[100][key]='forged'
            try:c.validate(v); assert False
            except ValueError:pass
            assert not any(e[0]=='signal' for e in s.events)
        for role in ['M','P','K']:
            r,s,c,v=ready(root+'/'+role); del s.tasks[v['tasks'][role]['pid']]
            try:c.validate(v); assert False
            except ProcessLookupError:pass
        r,s,c,v=ready(root+'/pin'); s.pins[(r.directory('a'),'net')]=[9,9]
        try:c.validate(v); assert False
        except ValueError:pass
        # Exercise the production pidfd validator, not only Controller's seam.
        adapter=n.LinuxSystem(); task=tree(300)['M']
        with patch.object(n.os,'pidfd_open',return_value=90),patch.object(n,'alive',return_value=True),patch.object(n,'identity',return_value=task),patch.object(n.os,'close') as close:
            assert adapter.inspect(task)==90
            altered=copy.deepcopy(task);altered['start']='reused'
            try:adapter.inspect(altered);assert False
            except ValueError:pass
            close.assert_called_once_with(90)
        s.network_context=lambda:{'dev':'changed'}
        try:c.validate(v); assert False
        except ValueError:pass
    elif case == 'registry':
        r=n.Registry(root,os.getuid())
        for bot in ['../x','a/b','a\n','']:
            try:r.read(bot); assert False
            except ValueError:pass
        directory=r.directory('a'); os.symlink('/tmp',directory+'/state.json')
        try:r.read('a'); assert False
        except ValueError:pass
        os.unlink(directory+'/state.json'); open(directory+'/state.json','w').write('{}'); os.chmod(directory+'/state.json',0o600)
        try:r.read('a'); assert False
        except ValueError:pass
        fd=r.lock('a')
        try:
            try:r.lock('a',n.time.monotonic()+0.02); assert False
            except TimeoutError:pass
        finally:os.close(fd)
    elif case == 'stop':
        r,s,c,v=ready(root); other=c.allocate('b'); s.stubborn=True
        c.stop('a',12)
        assert r.read('a') is None and r.read('b')==other and s.clock<=12.1
        assert s.events.index(('active','a',False)) < next(i for i,e in enumerate(s.events) if e[0]=='browser-close')
        signals=[e for e in s.events if e[0]=='signal']
        assert [e[1] for e in signals]==[100,102,101,100]
        assert s.events.index(('delete','a')) > s.events.index(('signal',102,signal.SIGKILL))
        assert s.events.index(('signal',102,signal.SIGKILL)) < s.events.index(('kill-scopes','a')) < s.events.index(('delete','a'))
    elif case == 'retry':
        for dead in ['M','P','K']:
            r,s,c,v=ready(root+'/'+dead); del s.tasks[v['tasks'][dead]['pid']]; c.stop('a',12); assert r.read('a') is None
        r,s,c,v=ready(root+'/retry'); s.fail='delete'
        try:c.stop('a',12); assert False
        except RuntimeError:pass
        assert r.read('a')['phase']=='stopping' and not r.read('a')['active']
        s.fail=None; c.stop('a',24); assert r.read('a') is None
    elif case == 'creation':
        for stage in ['pid','net','network','active']:
            r,s,c,v=setup(root+'/'+stage); s.fail=stage
            try:c.complete_creation(v); assert False
            except RuntimeError:pass
            assert r.read('a')['phase']=='creating'
            s.fail=None; c.terminate_tree(v,7); c.cleanup_resources(v); assert r.read('a') is None
            assert ('reap',101) in s.events and ('reap',102) not in s.events
    elif case == 'fresh':
        with patch.object(n.subprocess,'run') as call:
            n.ensure('a'); argv=call.call_args.args[0]; kw=call.call_args.kwargs
            assert argv==['/usr/bin/python3','-I',n.HELPER,'ensure','a']
            assert kw['env']==n.ENV and kw['close_fds'] and 'pass_fds' not in kw
            assert all(kw[x]==n.subprocess.DEVNULL for x in ['stdin','stdout','stderr'])
        code='import os; assert not os.path.exists("/proc/self/fd/3"); assert "SECRET" not in os.environ; print("clean")'
        import subprocess
        assert subprocess.check_output(['/usr/bin/python3','-I','-c',code],env=n.ENV,close_fds=True).strip()==b'clean'
    elif case == 'parent-race':
        for pid_live,eof in [(False,False),(True,True)]:
            events=[]
            with patch.object(n,'libc_call',side_effect=lambda *a:events.append(a)),patch.object(n,'alive',return_value=pid_live),patch.object(n.select,'select',return_value=([1] if eof else [],[],[])):
                try:n.parent_guard(1,2); assert False
                except ValueError:pass
            assert events==[('prctl',1,signal.SIGKILL,0,0,0)]
        events=[]; channel=Mock(); channel.fileno.return_value=7
        with patch.object(n,'close_except',side_effect=lambda x:events.append(('close',x))),patch.object(n,'parent_guard',side_effect=lambda *a:events.append(('guard',))),patch.object(n,'libc_call',side_effect=lambda *a:events.append(a)),patch.object(n,'alive',side_effect=[True,False]),patch.object(n.select,'select',return_value=([],[],[])),patch.object(n.signal,'signal'),patch.object(n,'send',side_effect=lambda *a:events.append(('ready',))):
            n.keeper_role(6,channel)
        assert events[0]==('close',{6,7}) and events.index(('guard',))<events.index(('unshare',n.NEWNET))<events.index(('ready',))
        assert not any(e==('unshare',n.NEWPID) for e in events)
    elif case == 'join':
        for outcome in ['exec','error','early','timeout','late']:
            r,s,c,v=ready(root+'/'+outcome); events=[]; pipe=(80,81)
            def prepare(fd):events.append(('prepare',fd));return [n.BROWSER_BWRAP,'--proc','/proc']
            select_result=([] if outcome=='timeout' else [80],[],[])
            waits=[(0,0),(222,7<<8 if outcome=='late' else 0)] if outcome not in ['early','timeout'] else [(222,1<<8)]
            with patch.object(n,'NamespaceController',return_value=c),patch.object(n,'libc_call',side_effect=lambda *a:events.append(a)),patch.object(n.os,'pipe2',return_value=pipe),patch.object(n.os,'fork',return_value=222),patch.object(n.os,'close',side_effect=lambda fd:events.append(('close',fd))),patch.object(n.os,'read',return_value=b'failed' if outcome=='error' else b''),patch.object(n.select,'select',return_value=select_result),patch.object(n.os,'waitpid',side_effect=lambda *a:events.append(('wait',a)) or waits.pop(0)),patch.object(n.os,'kill',side_effect=lambda *a:events.append(('kill',a))):
                try:
                    result=n.join('a',prepare,SimpleNamespace(pw_uid=1,pw_gid=1),{},lambda:None)
                    assert outcome in ['exec','late'] and result==(7 if outcome=='late' else 0)
                except (ValueError,TimeoutError):assert outcome in ['error','early','timeout']
            # bwrap now owns the browser pid namespace (--unshare-pid), so only the
            # per-bot netns is joined; joining a root-created pid ns breaks --proc.
            assert ('setns','net',n.NEWNET) in events and not any(e[:2]==('setns','pid') for e in events if isinstance(e,tuple))
            if outcome in ['exec','late']:assert events[-1][0]=='wait' and events[-1][1][1]==0
    elif case == 'kill-scopes':
        s=n.LinuxSystem(); calls=[]; listing=['murage-browser-a.0123abcd.scope','murage-browser-a-b.01234567.scope']
        def run(argv,**kw):
            calls.append(argv)
            if argv[1]=='list-units': return ''.join(u+' loaded active running x\n' for u in listing).encode()
            if argv[1]=='stop' and argv[-1]==listing[0]: listing.pop(0)
            return b''
        s.run=run
        s.kill_scopes('a')
        assert calls[0][-1]=='murage-browser-a.*.scope'
        killed=[c for c in calls if c[1]=='kill']
        assert killed==[['/usr/bin/systemctl','kill','--kill-whom=all','--signal=SIGKILL','murage-browser-a.0123abcd.scope']]
        assert [c for c in calls if c[1]=='stop']==[['/usr/bin/systemctl','stop','murage-browser-a.0123abcd.scope']]
        assert calls.index(killed[0])<calls.index(['/usr/bin/systemctl','stop','murage-browser-a.0123abcd.scope'])
        listing[:]=['murage-browser-a.0123abcd.scope']; s.run=lambda argv,**kw:(listing[0]+' x\n').encode() if argv[1]=='list-units' else b''
        try: s.kill_scopes('a'); assert False
        except ValueError: pass
        # The launch reconciling a dead manager keeps its own scope (re-audit).
        listing[:]=['murage-browser-a.0123abcd.scope','murage-browser-a.89abcdef.scope']; calls.clear(); s.run=run
        s.kill_scopes('a','murage-browser-a.89abcdef.scope')
        assert [c[-1] for c in calls if c[1] in ('kill','stop')]==['murage-browser-a.0123abcd.scope','murage-browser-a.0123abcd.scope']
        # The UI canary's reserved id (T19): the namespace accepts it, and its scope pattern never matches a bot or the plain ui-canary.
        assert n.bot_id('__murage-ui-canary')=='__murage-ui-canary'
        listing[:]=['murage-browser-__murage-ui-canary.0123abcd.scope','murage-browser-__murage-ui-canaryx.0123abcd.scope','murage-browser-ui-canary.0123abcd.scope']; calls.clear(); s.run=run
        s.kill_scopes('__murage-ui-canary')
        assert calls[0][-1]=='murage-browser-__murage-ui-canary.*.scope'
        assert [c[-1] for c in calls if c[1] in ('kill','stop')]==['murage-browser-__murage-ui-canary.0123abcd.scope']*2
        cg=root+'/cg'; open(cg,'w').write('0::/murage.slice/murage-browsers.slice/murage-browser-a.89abcdef.scope\n')
        assert n.own_scope('a',cg)=='murage-browser-a.89abcdef.scope' and n.own_scope('b',cg) is None
        open(cg,'w').write('0::/system.slice/murage-home.service\n'); assert n.own_scope('a',cg) is None
        r,s,c,v=ready(root+'/gone'); c.stop('a',12); s2=Fake(); c2=n.NamespaceController(r,s2); c2.stop('a',12)
        assert ('kill-scopes','a') in s2.events  # a bot without a registry entry still has its scopes killed
    elif case == 'network-argv':
        s=n.LinuxSystem(); events=[]
        s.json=lambda *a:[];s.run=lambda argv,**kw:events.append((argv,kw)) or b''
        v={'host':'mbh1','guest':'mbg1','alias':'owned','gateway':'10.253.0.5','address':'10.253.0.6'}
        with patch.object(n.os,'fork',return_value=5),patch.object(n.os,'waitpid',return_value=(5,0)):
            s.network_create(v,17)
        moved=next((a,k) for a,k in events if 'netns' in a)
        assert moved[0][-1]=='/proc/self/fd/17' and moved[1]['fds']==(17,)
        s.json=lambda *a:[{'ifname':'mbh1','ifalias':'foreign'}]
        try:s.network_delete(v);assert False
        except ValueError:pass
    elif case == 'parent':
        events=[]; manager=Mock(); manager.fileno.return_value=6
        parent=Mock(); parent.fileno.return_value=7
        child=Mock(); child.fileno.return_value=8
        with patch.object(n,'close_except',side_effect=lambda x:events.append(('close-except',x))),patch.object(n,'parent_guard',side_effect=lambda *a:events.append(('guard',))),patch.object(n,'libc_call',side_effect=lambda *a:events.append(a)),patch.object(n.os,'pidfd_open',return_value=9),patch.object(n.socket,'socketpair',return_value=(parent,child)),patch.object(n.os,'fork',side_effect=lambda:events.append(('fork',)) or 102),patch.object(n.os,'close'),patch.object(n,'packet',side_effect=[{'ready':True},{'ack':True}]),patch.object(n,'send',side_effect=lambda *a:events.append(('send',a[1]))),patch.object(n,'alive',return_value=True),patch.object(n.os,'waitpid',side_effect=lambda *a:events.append(('wait',a)) or (102,0)):
            n.parent_role(5,manager)
        assert events.index(('guard',))<events.index(('unshare',n.NEWPID))<events.index(('fork',))
        assert events.count(('fork',))==1 and ('send',{'keeper':102}) in events
        assert events[-1]==('wait',(102,os.WNOHANG))
        child.close.assert_called_once()
    elif case == 'join-child':
        r,s,c,v=ready(root); events=[]
        class Exit(BaseException):pass
        def execve(*args):events.append(('exec',args));raise Exit()
        def leave(*args):raise Exit()
        with patch.object(n,'NamespaceController',return_value=c),patch.object(n,'libc_call',side_effect=lambda *a:events.append(a)),patch.object(n.os,'pipe2',return_value=(80,81)),patch.object(n.os,'fork',return_value=0),patch.object(n.os,'close'),patch.object(n.os,'setgroups',side_effect=lambda x:events.append(('groups',x))),patch.object(n.os,'setgid',side_effect=lambda x:events.append(('gid',x))),patch.object(n.os,'setuid',side_effect=lambda x:events.append(('uid',x))),patch.object(n,'close_except',side_effect=lambda x:events.append(('fds',x))),patch.object(n.os,'set_inheritable'),patch.object(n.os,'execve',side_effect=execve),patch.object(n.os,'write',return_value=1),patch.object(n.os,'_exit',side_effect=leave):
            try:n.join('a',lambda fd:[n.BROWSER_BWRAP,'--proc','/proc'],SimpleNamespace(pw_uid=201,pw_gid=202),{'HOME':'/data/browser/a'},lambda:events.append(('validate',)))
            except Exit:pass
        assert events.index(('groups',[5151]))<events.index(('gid',202))<events.index(('uid',201))<events.index(('prctl',4,0,0,0,0))<events.index(('validate',))
        assert events[-1][0]=='exec' and events[-1][1][0]=='/usr/local/libexec/murage-browser-bwrap'
        allowed=next(e[1] for e in events if e[0]=='fds');assert 81 in allowed and len(allowed)==2
    elif case == 'manager':
        for fail_ready in [False,True]:
            r,s,c,v=setup(root+'/'+str(fail_ready)); events=[]
            c.allocate=lambda bot:v; s.current_identity=lambda:v['tasks']['M']
            parent=Mock(); child=Mock(); parent.fileno.return_value=61;child.fileno.return_value=62
            lock=r.lock('a')
            real_close=os.close
            def close(fd):
                if fd not in {60,99}: real_close(fd)
            def write(fd,data):
                events.append(('status',data))
                if fail_ready and data==b'ready\n':raise BrokenPipeError()
                return len(data)
            with patch.object(n.os,'chdir'),patch.object(n.os,'dup2',side_effect=lambda *a:events.append(('stdio',a[1]))),patch.object(n,'close_except',side_effect=lambda x:events.append(('keep',x))),patch.object(n.signal,'signal'),patch.object(n.os,'pidfd_open',return_value=60),patch.object(n.socket,'socketpair',return_value=(parent,child)),patch.object(n.os,'fork',return_value=101),patch.object(n.os,'close',side_effect=close),patch.object(n,'identity',side_effect=lambda pid:copy.deepcopy(s.tasks[pid])),patch.object(n,'packet',return_value={'keeper':102}),patch.object(n,'send',side_effect=lambda *a:events.append(('ack',))),patch.object(n.os,'write',side_effect=write),patch.object(n.select,'select',return_value=([parent],[],[])):
                c.manager('a',lock,99)
            assert r.read('a') is None
            assert all(('stdio',i) in events for i in range(3)) and ('keep',{lock,99}) in events
            assert ('reap',101) in s.events and ('reap',102) not in s.events
            assert ('status',b'ready\n') in events
            if fail_ready:assert ('status',b'failed\n') in events
    else:raise AssertionError(case)

with tempfile.TemporaryDirectory() as root:run(sys.argv[2],root)
print('OK '+sys.argv[2])
