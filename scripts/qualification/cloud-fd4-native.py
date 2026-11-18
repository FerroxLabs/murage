#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Root-only native FD4 qualification; no installed Murage or customer data.

Uses the real systemd-run binary, main --in-scope dispatcher, admission locks,
launch child, privilege drop, bwrap, staged credential collection and commit.
Only image attestation, fixture account/path selection and the vendor sandbox
argv are substituted. No scope, exec, FD, fork, commit or collection is mocked.
Run: python3 scripts/qualification/cloud-fd4-native.py --output JOB/evidence/fd4
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import types

SOURCE = Path(__file__).resolve().parents[2] / 'deploy/cloud-home/murage-turn-launch.py'


def fixture(root, mutant):
    spec = importlib.util.spec_from_file_location('launcher', root / 'launcher.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.ENGINE_ROOT = str(root / 'engine-homes')
    m.LIVE_DIR = str(root / 'live')
    m.TOMBSTONE_DIR = str(root / 'deleted')
    m.TURN_SLICE = 'sc-cloud-r3.slice'
    m.LOGIN_SCOPE_PROPERTIES = ['MemoryMax=256M', 'TasksMax=64', 'RuntimeMaxSec=30']
    m.COMMIT_WAIT = 2
    m.LOGIN_COMMANDS['codex'] = ('/usr/bin/python3', {'login': []})
    real_login = m.validate_login_request
    m.validate_login_request = lambda request: real_login(request, engine_root=m.ENGINE_ROOT)
    # Image installation and dedicated production accounts are outside this
    # descriptor proof. Every storage path below belongs to this fresh rig.
    m.assert_image_launcher = lambda: None
    m.pwd = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=2001, pw_gid=2001))
    m.grp = types.SimpleNamespace(getgrnam=lambda name: types.SimpleNamespace(gr_gid=2001))
    os.environ['SUDO_UID'] = '2001'
    real_take = m.take_scope_request
    m.take_scope_request = lambda path: real_take(path, root=str(root / 'requests'))
    real_enter = m.enter_scope
    m.enter_scope = lambda payload, plan, admission=None: real_enter(payload, plan, root=str(root / 'requests'), admission=admission)
    m.validate_request = lambda request, login=False: ('codex', m.ENGINE_ROOT + '/codex', m.ENGINE_ROOT + '/codex', '/usr/bin/python3', [], {}, None, request['bot'])
    # The actual launch() still creates a private mount namespace, forks, drops
    # privileges and executes bwrap. A tiny no-network vendor stand-in replaces
    # pasta and the production engine filesystem, neither installed on this host.
    m.anchor_mounts = lambda mounts: mounts
    real_mount = m.mount_turn_home
    m.mount_turn_home = lambda uid, gid: real_mount(uid, gid, root=str(root / 'turn'))
    m.placeholder_dirs = lambda *args: []
    m.run_frozen = lambda paths, mounts, engine, run, walk_masks: run()
    m.turn_mount_args = lambda *args, **kw: ([], {})
    m.with_seccomp = lambda argv, token: argv
    m.seccomp_filter = lambda: b''
    m.write_turn_dir = lambda *args: str(root / 'turn')
    vendor = """import os,json,socket
try:
 os.fstat(4)
 raise AssertionError('vendor inherited FD4')
except OSError: pass
os.makedirs('/home/.codex',exist_ok=True)
open('/home/.codex/auth.json','w').write('{"tokens":{"access_token":"fixture","account_id":"fixture"}}')
open('/home/vendor.json','w').write(json.dumps({'fd4Closed':True,'uid':os.getuid(),'netns':os.readlink('/proc/self/ns/net')}))
"""
    m.PASTA = '/usr/bin/bwrap'
    m.pasta_argv = lambda turn_dir: ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--bind', str(root / 'turn/home'), '/home', '--chdir', '/home', '/usr/bin/python3', '-I', '-c', vendor]
    real_collect = m.collect_turn_home
    def collect(*args, **kwargs):
        witness = root / 'turn/home/vendor.json'
        if witness.exists():
            (root / 'vendor.json').write_bytes(witness.read_bytes())
        return real_collect(*args, **kwargs)
    m.collect_turn_home = collect
    real_drop = m.drop_commit_channel
    def drop(commit):
        assert stat.S_ISSOCK(os.fstat(4).st_mode), 'FD4 lost before sandbox fork'
        if mutant != 'omit-close':
            real_drop(commit)
        try:
            os.fstat(4)
            closed = False
        except OSError:
            closed = True
        # A witness before setgroups/setuid/exec, in the actual launch child.
        (root / 'child.json').write_text(json.dumps({'closedBeforePrivilegeDrop': closed, 'uid': os.getuid(), 'cgroup': Path('/proc/self/cgroup').read_text()}))
        assert closed, 'FD4 still open before privilege drop'
    m.drop_commit_channel = drop
    real_launch = m.launch
    def launch(request, login=False):
        m.check_commit_channel()
        (root / 'scope.json').write_text(json.dumps({'fd4Socket': True, 'cgroup': Path('/proc/self/cgroup').read_text(), 'admitted': m.ADMISSION is not None}))
        real_launch(request, login=login)
    m.launch = launch
    return m


def namespace(root, mutant):
    # Bind only in this new mount namespace. The host's libexec is untouched.
    subprocess.run(['mount', '--bind', str(root / 'local'), '/usr/local'], check=True)
    m = fixture(root, mutant)
    request = {'mode':'login', 'engine':'codex', 'action':'login', 'bot':'fixture', 'commit':True, 'unit':'murage-turn-' + secrets.token_hex(8) + '.scope'}
    payload = json.dumps(request).encode()
    r, w = os.pipe()
    os.write(w, payload)
    os.close(w)
    os.dup2(r, 3, inheritable=True)
    if r != 3:
        os.close(r)
    sys.argv = ['murage-turn-launch']
    m.main()


def run(output, mutant=None, reply=b'commit\n'):
    root = Path(tempfile.mkdtemp(prefix='sc-cloud-r3-fd4-', dir='/opt'))
    root.chmod(0o755)
    try:
        for name, mode in [('engine-homes',0o755), ('engine-homes/codex',0o755), ('live',0o700), ('turn',0o711), ('local',0o755), ('local/libexec',0o755)]:
            (root / name).mkdir(mode=mode)
        shutil.copyfile(SOURCE, root / 'launcher.py')
        shutil.copyfile(__file__, root / 'driver.py')
        (root / 'local/libexec/murage-turn-launch').write_text('import sys\nsys.path.insert(0,' + repr(str(root)) + ')\nfrom driver import fixture\nfrom pathlib import Path\nm=fixture(Path(' + repr(str(root)) + '),' + repr(mutant) + ')\nm.main()\n')
        a, b = socket.socketpair()
        # pass_fds keeps FD4 after preexec; put the socket on 4 in the parent
        # temporarily, protecting any preexisting descriptor.
        saved = os.dup(4) if _open(4) else None
        os.dup2(a.fileno(), 4, inheritable=True)
        log = output.with_suffix('.log').open('wb')
        try:
            p = subprocess.Popen(['unshare', '--mount', '--propagation', 'private', '/usr/bin/python3', '-I', str(root / 'driver.py'), '--namespace', str(root), mutant or 'none'], pass_fds=(4,), stdout=log, stderr=subprocess.STDOUT)
        finally:
            if saved is not None:
                os.dup2(saved, 4); os.close(saved)
            elif a.fileno() != 4 and b.fileno() != 4:
                os.close(4)
        a.close()
        b.settimeout(15)
        try:
            heard = b.recv(64)
        except (TimeoutError, ConnectionResetError):
            heard = b''
        if heard == b'ready\n':
            b.sendall(reply)
        b.close()
        status = p.wait(timeout=30)
        log.close()
        result = {'mutant':mutant, 'reply':reply.decode(), 'ready':heard.decode(), 'status':status, 'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(), 'scope':_json(root/'scope.json'), 'child':_json(root/'child.json')}
        store=root/'engine-homes/codex/bots/fixture/signin/current'
        result['current'] = store.read_text().strip() if store.exists() else None
        result['vendor'] = _json(root/'vendor.json')
        result['hostNetns'] = os.readlink('/proc/self/ns/net')
        # The mount dies with its namespace, so turn-home witnesses are read
        # from the actual child and the persisted generation instead.
        output.with_suffix('.json').write_text(json.dumps(result,indent=2))
        return result
    finally:
        assert root.parent == Path('/opt') and root.name.startswith('sc-cloud-r3-fd4-')
        shutil.rmtree(root)


def _open(fd):
    try: os.fstat(fd); return True
    except OSError: return False


def _json(path):
    return json.loads(path.read_text()) if path.exists() else None


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--namespace':
        namespace(Path(sys.argv[2]), sys.argv[3])
    else:
        parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
        assert os.geteuid()==0, 'needs an isolated native root runner'
        args.output.mkdir(parents=True,exist_ok=True)
        good=run(args.output/'commit');refused=run(args.output/'refused',reply=b'no\n');bad=run(args.output/'omit-close',mutant='omit-close')
        assert good['status']==0 and good['ready']=='ready\n' and good['current']=='1', good
        assert good['scope']['fd4Socket'] and good['scope']['admitted'] and good['child']['closedBeforePrivilegeDrop'], good
        assert good['vendor']['fd4Closed'] and good['vendor']['uid']==2001 and good['vendor']['netns']!=good['hostNetns'], good
        assert refused['status']==1 and refused['current'] is None and refused['ready']=='ready\n', refused
        assert bad['status']!=0 and bad['current'] is None and bad['child']['closedBeforePrivilegeDrop'] is False, bad
        print(json.dumps({'passed':True,'cases':[good,refused,bad]},indent=2))
