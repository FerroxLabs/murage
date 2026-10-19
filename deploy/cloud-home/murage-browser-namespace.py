#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Root browser namespace lifecycle. No request settings enter this executable."""
import contextlib
import ctypes
import fcntl
import grp
import hashlib
import importlib.util
import importlib.machinery
import ipaddress
import json
import os
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

ROOT = "/run/murage-browser-ns"
HELPER = "/usr/local/libexec/murage-browser-namespace"
BROWSER_BWRAP = "/usr/local/libexec/murage-browser-bwrap"  # browser-bwrap.apparmor; group murage-browser-sandbox
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}
NEWPID, NEWNET = 0x20000000, 0x40000000
RESOLVER = b"nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n"
POOL = ipaddress.ip_network("10.253.0.0/16")


def bot_id(bot):
    if not isinstance(bot, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", bot):
        raise ValueError("Invalid browser namespace identity")
    return bot


def close_except(keep):
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 2 and fd not in keep:
            try:
                os.close(fd)
            except OSError:
                pass


def libc_call(name, *args):
    libc = ctypes.CDLL(None, use_errno=True)
    if getattr(libc, name)(*args) != 0:
        raise OSError(ctypes.get_errno(), "Browser namespace syscall failed")


def alive(fd):
    return not select.select([fd], [], [], 0)[0]


def parent_guard(parent_pidfd, channel):
    libc_call("prctl", 1, signal.SIGKILL, 0, 0, 0)
    if not alive(parent_pidfd) or select.select([channel], [], [], 0)[0]:
        raise ValueError("Browser namespace parent vanished")


def packet(channel, timeout):
    if not select.select([channel], [], [], max(0, timeout))[0]:
        raise TimeoutError("Browser namespace handoff timeout")
    data = channel.recv(8192)
    if not data:
        raise ValueError("Browser namespace parent vanished")
    return json.loads(data)


def send(channel, value):
    channel.sendall(json.dumps(value, separators=(",", ":")).encode())


def namespace_identity(pid, kind):
    value = os.stat(f"/proc/{pid}/ns/{kind}")
    return [value.st_dev, value.st_ino]


def immutable_artifact(path):
    # Validate both lookup and canonical ancestors; trusted root filesystem
    # links are allowed, browser-writable replacement paths are not.
    for target in (path, os.path.realpath(path)):
        cursor = target
        while True:
            info = os.lstat(cursor)
            if info.st_uid != 0 or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022):
                raise ValueError("Mutable browser helper artifact")
            if cursor == "/": break
            cursor = os.path.dirname(cursor)
    with open(path, "rb") as stream: return hashlib.sha256(stream.read()).hexdigest()


def identity(pid):
    with open(f"/proc/{pid}/stat", encoding="ascii") as stream:
        start = stream.read().rsplit(")", 1)[1].split()[19]
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        boot = stream.read().strip()
    with open(f"/proc/{pid}/cmdline", "rb") as stream:
        command = stream.read(8192).split(b"\0")
    if HELPER.encode() not in command:
        raise ValueError("Browser helper artifact changed")
    executable = os.path.realpath(f"/proc/{pid}/exe")
    return {"pid": pid, "start": start, "boot": boot,
            "exe": executable, "executable_digest": immutable_artifact(executable),
            "artifact": immutable_artifact(HELPER),
            "ns": {kind: namespace_identity(pid, kind) for kind in ("pid", "pid_for_children", "net", "mnt")}}


def relationships(tasks):
    m, p, k = (tasks[name]["ns"] for name in ("M", "P", "K"))
    if not (m["pid"] == m["pid_for_children"] == p["pid"] and
            m["net"] == p["net"] and m["mnt"] == p["mnt"] == k["mnt"] and
            p["pid_for_children"] == k["pid"] == k["pid_for_children"] and
            k["pid"] != m["pid"] and k["net"] != m["net"]):
        raise ValueError("Browser namespace topology mismatch")


class Registry:
    def __init__(self, root=ROOT, uid=0):
        self.root, self.uid = root, uid
        os.makedirs(root, mode=0o700, exist_ok=True)
        self.check(root, directory=True)

    def check(self, path, directory=False):
        value = os.lstat(path)
        if value.st_uid != self.uid or stat.S_IMODE(value.st_mode) != (0o700 if directory else 0o600) or not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)):
            raise ValueError("Invalid root browser registry")

    def directory(self, bot):
        path = self.root + "/" + bot_id(bot)
        os.makedirs(path, mode=0o700, exist_ok=True)
        self.check(path, directory=True)
        return path

    def lock(self, bot, deadline=None):
        path = self.directory(bot) + "/lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.check(path)
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise TimeoutError("Browser registry lock timed out")
                    time.sleep(0.01)
        except BaseException:
            os.close(fd); raise
        return fd

    def global_lock(self, name):
        if name not in {"allocation", "firewall"}: raise ValueError("Invalid registry lock")
        path = self.root + "/." + name + ".lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.check(path); fcntl.flock(fd, fcntl.LOCK_EX)
        return fd

    def read(self, bot):
        path = self.directory(bot) + "/state.json"
        if not os.path.lexists(path):
            return None
        self.check(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, encoding="utf8") as stream:
            value = json.load(stream)
        if value.get("version") != 1 or value.get("bot") != bot or not re.fullmatch(r"[a-f0-9]{32}", value.get("generation", "")) or value.get("phase") not in {"creating", "ready", "stopping"}:
            raise ValueError("Invalid root browser state")
        slot = value.get("slot")
        if type(slot) is not int or not 1 <= slot <= 16382:
            raise ValueError("Invalid browser network slot")
        subnet = ipaddress.ip_network((int(POOL.network_address) + slot * 4, 30))
        if any(value.get(key) != expected for key, expected in {
            "host": f"mbh{slot:x}", "guest": f"mbg{slot:x}", "gateway": str(subnet[1]),
            "address": str(subnet[2]), "alias": f'murage-browser:{bot}:{value["generation"]}'}.items()):
            raise ValueError("Invalid browser network ownership")
        return value

    def write(self, value):
        directory = self.directory(value["bot"])
        path = directory + "/state-" + uuid.uuid4().hex
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(path, directory + "/state.json")

    def remove(self, value):
        current = self.read(value["bot"])
        if current and current["generation"] != value["generation"]:
            raise ValueError("Browser namespace generation changed")
        if current:
            os.unlink(self.directory(value["bot"]) + "/state.json")


class LinuxSystem:
    """Privileged adapter. Unit fixtures inject an adapter; CLI never selects one."""
    def now(self): return time.monotonic()
    def sleep(self, seconds): time.sleep(seconds)
    def current_identity(self): return identity(os.getpid())
    def inspect(self, task, allow_dead=False):
        fd = os.pidfd_open(task["pid"])
        try:
            if allow_dead and not alive(fd):
                with open(f'/proc/{task["pid"]}/stat', encoding="ascii") as stream:
                    start = stream.read().rsplit(")", 1)[1].split()[19]
                with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream: boot = stream.read().strip()
                if start != task["start"] or boot != task["boot"]: raise ValueError("Browser process identity changed")
                return fd
            if not alive(fd): raise ProcessLookupError("Browser task exited")
            if identity(task["pid"]) != task:
                raise ValueError("Browser process identity changed")
            return fd
        except BaseException:
            os.close(fd); raise
    def live(self, fd): return alive(fd)
    def close(self, fd): os.close(fd)
    def signal(self, fd, number):
        try: signal.pidfd_send_signal(fd, number)
        except ProcessLookupError: pass  # The pinned task exited; never retarget.
    def run(self, argv, *, input=None, fds=(), timeout=2):
        result = subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=ENV, close_fds=True, pass_fds=tuple(fds), timeout=timeout, check=True)
        return result.stdout
    def json(self, *args): return json.loads(self.run(["/usr/sbin/ip", "-j", *args]))
    def kill_scopes(self, bot, keep=None):
        """SIGKILL and stop every murage-browser-<bot>.<id>.scope (audit A1-05).

        The scope holds every process of a browser launch, including those in
        bwrap's pid namespace that no registered helper pid reaches. The "."
        separator cannot occur in a bot id, so one bot's pattern never matches
        another's. Raises if any scope is still listed afterwards."""
        pattern = "murage-browser-" + bot_id(bot) + ".*.scope"
        exact = re.compile(r"murage-browser-" + re.escape(bot) + r"\.[0-9a-f]{8}\.scope")
        def listed():
            out = self.run(["/usr/bin/systemctl", "list-units", "--type=scope", "--all", "--plain", "--no-legend", "--no-pager", pattern], timeout=10).decode()
            return [line.split()[0] for line in out.splitlines() if line.split() and exact.fullmatch(line.split()[0])]
        for unit in listed():
            if unit == keep: continue
            for verb in (["kill", "--kill-whom=all", "--signal=SIGKILL"], ["stop"]):
                try: self.run(["/usr/bin/systemctl", *verb, unit], timeout=30)
                except subprocess.CalledProcessError: pass  # already gone; the listing below decides
        if [unit for unit in listed() if unit != keep]: raise ValueError("Browser scope survived teardown")
    def network_context(self):
        spec = importlib.util.spec_from_loader("browser_network", importlib.machinery.SourceFileLoader("browser_network", "/usr/local/libexec/murage-browser-network"))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module.network_context(self)

    def pin(self, directory, kind, task):
        path = directory + "/" + kind
        fd = os.open(f'/proc/{task["pid"]}/ns/{kind}', os.O_RDONLY | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            if [info.st_dev, info.st_ino] != task["ns"][kind]: raise ValueError("Namespace handle changed")
            target = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(target)
            libc_call("mount", f"/proc/self/fd/{fd}".encode(), path.encode(), None, 4096, None)
        finally: os.close(fd)

    def open_pin(self, directory, kind, task):
        fd = os.open(directory + "/" + kind, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if [info.st_dev, info.st_ino] != task["ns"][kind]:
            os.close(fd); raise ValueError("Browser namespace pin changed")
        return fd

    def unpin(self, directory, kind, task):
        path = directory + "/" + kind
        if not os.path.lexists(path): return
        info = os.stat(path)
        if [info.st_dev, info.st_ino] == task["ns"][kind]:
            libc_call("umount2", path.encode(), 0)
        elif not stat.S_ISREG(info.st_mode) or info.st_size or info.st_uid != 0:
            raise ValueError("Browser namespace pin changed")
        os.unlink(path)

    def network_create(self, value, netfd):
        host, guest = value["host"], value["guest"]
        links = self.json("link", "show")
        if any(link["ifname"] in {host, guest} for link in links):
            raise ValueError("Browser interface name already exists")
        self.run(["/usr/sbin/ip", "link", "add", host, "type", "veth", "peer", "name", guest])
        for name in (host, guest):
            self.run(["/usr/sbin/ip", "link", "set", "dev", name, "alias", value["alias"]])
        self.run(["/usr/sbin/ip", "link", "set", "dev", guest, "netns", f"/proc/self/fd/{netfd}"], fds=(netfd,))
        self.run(["/usr/sbin/ip", "address", "add", value["gateway"] + "/30", "dev", host])
        self.run(["/usr/sbin/ip", "link", "set", "dev", host, "up"])
        # A short host child joins ONLY net. Never change M's pid_for_children.
        child = os.fork()
        if child == 0:
            try:
                libc_call("setns", netfd, NEWNET)
                close_except(set())
                self.run(["/usr/sbin/sysctl", "-w", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1"])
                self.run(["/usr/sbin/ip", "address", "add", value["address"] + "/30", "dev", guest])
                self.run(["/usr/sbin/ip", "link", "set", "dev", guest, "up"])
                self.run(["/usr/sbin/ip", "link", "set", "dev", "lo", "up"])
                self.run(["/usr/sbin/ip", "route", "add", "default", "via", value["gateway"]])
                os._exit(0)
            except BaseException: os._exit(1)
        if os.waitpid(child, 0)[1]: raise ValueError("Browser guest network failed")

    def network_delete(self, value):
        for link in self.json("link", "show"):
            if link["ifname"] in {value["host"], value["guest"]}:
                if link.get("ifalias") != value["alias"]:
                    raise ValueError("Browser interface ownership changed")
                self.run(["/usr/sbin/ip", "link", "delete", "dev", link["ifname"]])

    def close_browser(self, value, deadline):
        # A disposable child joins only the validated net namespace. It never
        # changes S's namespace or accepts commands from a browser-owned file.
        directory = ROOT + "/" + value["bot"]
        netfd = self.open_pin(directory, "net", value["tasks"]["K"])
        child = os.fork()
        if child == 0:
            try:
                libc_call("setns", netfd, NEWNET)
                close_except(set())
                # The sockets directory is browser-writable: pin it without
                # following a symlink (another bot's directory), then reach
                # each socket only through that pinned descriptor (audit A1-04).
                try:
                    dirfd = os.open("/data/browser/" + value["bot"] + "/sockets", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                except OSError:
                    dirfd = -1
                if dirfd >= 0:
                    for name in os.listdir(dirfd):
                        remaining = deadline - self.now()
                        if remaining <= 0: break
                        if not re.fullmatch(r"[A-Za-z0-9_-]+\.sock", name): continue
                        # O_PATH|O_NOFOLLOW pins the entry itself; connecting through
                        # its /proc magic link never re-walks the swappable name.
                        try: pfd = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dirfd)
                        except OSError: continue
                        try:
                            if not stat.S_ISSOCK(os.fstat(pfd).st_mode): continue
                            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
                                stream.settimeout(remaining)
                                stream.connect("/proc/self/fd/%d" % pfd)
                                stream.sendall(b'{"id":"murage-cleanup","action":"close"}\n')
                                stream.recv(4096)
                        except OSError: pass
                        finally: os.close(pfd)
                os._exit(0)
            except BaseException: os._exit(1)
        os.close(netfd)
        while self.now() < deadline:
            if os.waitpid(child, os.WNOHANG)[0]: return
            self.sleep(0.01)
        os.kill(child, signal.SIGKILL); os.waitpid(child, 0)

    def active(self, value, enabled):
        verb = "add" if enabled else "delete"
        rules = ""
        for family, table in (("inet", "murage_home"), ("ip", "murage_browser_nat")):
            payload = json.loads(self.run(["/usr/sbin/nft", "-j", "list", "set", family, table, "browser_active"]))
            elements = next(item["set"].get("elem", []) for item in payload["nftables"] if "set" in item)
            found = any(item.get("concat") == [value["host"], value["address"]] for item in elements if isinstance(item, dict))
            if found != enabled:
                rules += f'{verb} element {family} {table} browser_active {{ "{value["host"]}" . {value["address"]} }}\n'
        if rules: self.run(["/usr/sbin/nft", "-f", "-"], input=rules.encode())

    def reap_parent(self, pid, deadline):
        while self.now() < deadline:
            try: result, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError: return
            if result: return
            self.sleep(0.02)
        raise TimeoutError("Browser parent did not reap")


def keeper_role(parentfd, channel):
    close_except({parentfd, channel.fileno()})
    parent_guard(parentfd, channel)
    libc_call("prctl", 4, 0, 0, 0, 0)  # non-dumpable, remains root thereafter
    stopping = [False]
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__(0, True))
    signal.signal(signal.SIGCHLD, lambda *_: None)
    libc_call("unshare", NEWNET)
    if not alive(parentfd) or select.select([channel], [], [], 0)[0]:
        raise ValueError("Browser keeper parent vanished")
    send(channel, {"ready": True})
    while not stopping[0] and alive(parentfd):
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0: break
            except ChildProcessError: break
        if select.select([channel], [], [], 0.05)[0]:
            if not channel.recv(128): break
    # Exiting PID1 tears down remaining namespace children in the kernel.


def parent_role(managerfd, channel):
    close_except({managerfd, channel.fileno()})
    parent_guard(managerfd, channel)
    libc_call("unshare", NEWPID)
    ownfd = os.pidfd_open(os.getpid())
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    keeper = os.fork()  # P creates exactly one child; fork result is host PID.
    if keeper == 0:
        try:
            parent.close(); channel.close(); os.close(managerfd)
            keeper_role(ownfd, child)
            os._exit(0)
        except BaseException: os._exit(1)
    child.close(); os.close(ownfd)
    try:
        packet(parent, 3)
        send(channel, {"keeper": keeper})
        # No reaping until M opens K's pidfd and acknowledges identity handoff.
        if packet(channel, 3) != {"ack": True}: raise ValueError("Invalid keeper handoff")
        while alive(managerfd):
            if os.waitpid(keeper, os.WNOHANG)[0]: return
            if select.select([channel, parent], [], [], 0.05)[0]:
                if not alive(managerfd) or channel in select.select([channel], [], [], 0)[0]: break
        parent.close()  # Lifetime EOF to K, in addition to PDEATHSIG on exit.
        os.waitpid(keeper, 0)
    finally:
        parent.close()


class NamespaceController:
    def __init__(self, registry=None, system=None):
        self.registry, self.system = registry or Registry(), system or LinuxSystem()

    def validate(self, value, require_ready=True):
        if require_ready and value["phase"] != "ready": raise ValueError("Browser namespace not ready")
        if set(value.get("tasks", {})) != {"M", "P", "K"}: raise ValueError("Incomplete browser task tree")
        relationships(value["tasks"])
        handles = {}
        try:
            for role, task in value["tasks"].items(): handles[role] = self.system.inspect(task)
            if self.system.network_context() != value["route"]: raise ValueError("Browser default route changed")
            directory = self.registry.directory(value["bot"])
            for kind in ("pid", "net"): handles[kind] = self.system.open_pin(directory, kind, value["tasks"]["K"])
            if not all(self.system.live(handles[r]) for r in ("M", "P", "K")): raise ValueError("Browser namespace died")
            return handles
        except BaseException:
            for fd in handles.values(): self.system.close(fd)
            raise

    def close_handles(self, handles):
        for fd in handles.values(): self.system.close(fd)

    def allocate(self, bot):
        lock = self.registry.global_lock("allocation")
        try:
            used = set()
            for name in os.listdir(self.registry.root):
                if name.startswith("."): continue
                entry = self.registry.read(name)
                if entry: used.add(entry["slot"])
            slot = next((i for i in range(1, 16383) if i not in used), None)
            if slot is None: raise ValueError("Browser namespace slots exhausted")
            generation = uuid.uuid4().hex
            subnet = ipaddress.ip_network((int(POOL.network_address) + slot * 4, 30))
            value = {"version": 1, "bot": bot, "generation": generation, "phase": "creating", "slot": slot,
                     "host": f"mbh{slot:x}", "guest": f"mbg{slot:x}", "gateway": str(subnet[1]), "address": str(subnet[2]),
                     "alias": f"murage-browser:{bot}:{generation}", "route": self.system.network_context(), "tasks": {}, "active": False}
            self.registry.write(value)
            return value
        finally: os.close(lock)

    def complete_creation(self, value):
        directory = self.registry.directory(value["bot"])
        relationships(value["tasks"])
        for kind in ("pid", "net"): self.system.pin(directory, kind, value["tasks"]["K"])
        netfd = self.system.open_pin(directory, "net", value["tasks"]["K"])
        try: self.system.network_create(value, netfd)
        finally: self.system.close(netfd)
        path = directory + "/resolv.conf"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream: stream.write(RESOLVER)
        firewall_lock = self.registry.global_lock("firewall")
        try:
            value["active"] = True; self.registry.write(value)
            self.system.active(value, True)
        finally: os.close(firewall_lock)
        handles = self.validate(value, require_ready=False)
        self.close_handles(handles)
        value["phase"] = "ready"; self.registry.write(value)

    def remove_active(self, value):
        firewall_lock = self.registry.global_lock("firewall")
        try:
            self.system.active(value, False)
            value["active"] = False; self.registry.write(value)
        finally: os.close(firewall_lock)

    def cleanup_resources(self, value):
        self.remove_active(value)
        self.system.network_delete(value)
        directory = self.registry.directory(value["bot"])
        if "K" in value["tasks"]:
            for kind in ("pid", "net"): self.system.unpin(directory, kind, value["tasks"]["K"])
        path = directory + "/resolv.conf"
        if os.path.lexists(path):
            self.registry.check(path); os.unlink(path)
        self.registry.remove(value)

    def terminate_tree(self, value, deadline):
        handles = {}
        try:
            for role in ("K", "P"):
                if role in value["tasks"]:
                    try: handles[role] = self.system.inspect(value["tasks"][role], allow_dead=True)
                    except ProcessLookupError: pass
            if "K" in handles and self.system.live(handles["K"]): self.system.signal(handles["K"], signal.SIGTERM)
            soft = min(deadline - 2, self.system.now() + 5)
            while self.system.now() < soft and any(self.system.live(fd) for fd in handles.values()): self.system.sleep(0.02)
            if "K" in handles and self.system.live(handles["K"]): self.system.signal(handles["K"], signal.SIGKILL)
            while self.system.now() < deadline - 0.2 and any(self.system.live(fd) for fd in handles.values()): self.system.sleep(0.02)
            if "P" in handles and self.system.live(handles["P"]): self.system.signal(handles["P"], signal.SIGKILL)
            if "P" in value["tasks"]: self.system.reap_parent(value["tasks"]["P"]["pid"], deadline)
            if any(self.system.live(fd) for fd in handles.values()): raise TimeoutError("Browser tree did not stop")
        finally: self.close_handles(handles)

    def manager(self, bot, lock, status):
        os.chdir("/"); os.umask(0o077)
        null = os.open("/dev/null", os.O_RDWR)
        for target in (0, 1, 2): os.dup2(null, target)
        close_except({lock, status})
        value, parent_channel = None, None
        stopping = [False]
        signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__(0, True))
        signal.signal(signal.SIGUSR1, lambda *_: stopping.__setitem__(0, True))
        try:
            value = self.allocate(bot)
            value["tasks"]["M"] = self.system.current_identity(); self.registry.write(value)
            ownfd = os.pidfd_open(os.getpid())
            parent_channel, child_channel = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            parent_pid = os.fork()
            if parent_pid == 0:
                try:
                    parent_channel.close()
                    parent_role(ownfd, child_channel)
                    os._exit(0)
                except BaseException: os._exit(1)
            child_channel.close(); os.close(ownfd)
            value["tasks"]["P"] = identity(parent_pid)
            report = packet(parent_channel, 4)
            value["tasks"]["P"] = identity(parent_pid)  # after P's unshare
            value["tasks"]["K"] = identity(report["keeper"])
            guards = [self.system.inspect(value["tasks"][role]) for role in ("P", "K")]
            try: send(parent_channel, {"ack": True})
            finally:
                for guard in guards: self.system.close(guard)
            self.registry.write(value)
            if stopping[0]: raise ValueError("Browser creation stopped")
            self.complete_creation(value)
            os.close(lock); lock = -1
            # Check reader before publication. Failed write rolls back the generation.
            os.write(status, b"ready\n"); os.close(status); status = -1
            while not stopping[0]:
                if select.select([parent_channel], [], [], 0.05)[0]: break
            lock = self.registry.lock(bot)
            current = self.registry.read(bot)
            if not current or current["generation"] != value["generation"]: raise ValueError("Browser generation changed")
            value = current; value["phase"] = "stopping"; self.registry.write(value)
            self.remove_active(value)
            self.terminate_tree(value, self.system.now() + 7)
            self.cleanup_resources(value)
        except BaseException:
            if value:
                if lock < 0: lock = self.registry.lock(bot)
                value["phase"] = "stopping"; self.registry.write(value)
                try:
                    self.remove_active(value)
                    self.terminate_tree(value, self.system.now() + 7)
                    self.cleanup_resources(value)
                except BaseException: pass  # Keep non-ready registry for exact retry.
            if status >= 0:
                try: os.write(status, b"failed\n")
                except OSError: pass
        finally:
            if parent_channel: parent_channel.close()
            if lock >= 0: os.close(lock)

    def ensure(self, bot):
        bot_id(bot)
        lock = self.registry.lock(bot, self.system.now() + 10)
        value = self.registry.read(bot)
        if value:
            manager = value.get("tasks", {}).get("M")
            dead = manager is None
            if manager:
                try:
                    fd = self.system.inspect(manager, allow_dead=True)
                    dead = not self.system.live(fd); self.system.close(fd)
                except ProcessLookupError: dead = True
            # Reconciling a dead manager must not kill the launch that asked for
            # it: that launch already runs in its own new scope (re-audit).
            if dead:
                os.close(lock); self.stop(bot, keep=own_scope(bot)); return self.ensure(bot)
            try:
                handles = self.validate(value); self.close_handles(handles)
                os.close(lock); return
            except (ProcessLookupError, FileNotFoundError):
                os.close(lock)
                self.stop(bot, keep=own_scope(bot))
                return self.ensure(bot)
            except BaseException:
                os.close(lock); raise
        readfd, writefd = os.pipe2(os.O_CLOEXEC)
        child = os.fork()
        if child == 0:
            os.close(readfd)
            os.setsid()
            detached = os.fork()
            if detached: os._exit(0)
            self.manager(bot, lock, writefd)
            os._exit(0)
        os.close(writefd); os.close(lock)  # Do NOT LOCK_UN inherited description.
        os.waitpid(child, 0)
        try:
            if not select.select([readfd], [], [], 10)[0] or os.read(readfd, 32) != b"ready\n":
                raise ValueError("Browser namespace creation failed")
        finally: os.close(readfd)

    def stop(self, bot, deadline=None, keep=None):
        deadline = deadline or self.system.now() + 12
        lock = self.registry.lock(bot, deadline)
        value = self.registry.read(bot)
        if not value:
            os.close(lock)
            self.system.kill_scopes(bot, keep)
            return
        handles = {}
        try:
            # Validate each surviving identity, refusing a reused PID. Dead tasks
            # are allowed only in this stopping reconciliation, never in join.
            for role, task in value["tasks"].items():
                try: handles[role] = self.system.inspect(task, allow_dead=True)
                except ProcessLookupError: pass
            value["phase"] = "stopping"; self.registry.write(value)
            self.remove_active(value)
        finally: os.close(lock)
        try:
            if "K" in handles and self.system.live(handles["K"]):
                self.system.close_browser(value, min(deadline - 7, self.system.now() + 5))
            if "M" in handles and self.system.live(handles["M"]): self.system.signal(handles["M"], signal.SIGUSR1)
            while self.system.now() < deadline - 2 and any(self.system.live(fd) for fd in handles.values()): self.system.sleep(0.02)
            if "K" in handles and self.system.live(handles["K"]): self.system.signal(handles["K"], signal.SIGKILL)
            # Give the persistent parents the remaining shared reaping window.
            while self.system.now() < deadline - 0.2 and any(self.system.live(fd) for fd in handles.values()): self.system.sleep(0.02)
            for role in ("P", "M"):
                if role in handles and self.system.live(handles[role]): self.system.signal(handles[role], signal.SIGKILL)
            while self.system.now() < deadline and any(self.system.live(fd) for fd in handles.values()): self.system.sleep(0.02)
            # Every browser process lives in the bot's scope(s), including those in
            # bwrap's pid namespace that no registered handle reaches (audit A1-05).
            self.system.kill_scopes(bot, keep)
            if any(self.system.live(fd) for fd in handles.values()): raise TimeoutError("Browser namespace stop timed out")
            lock = self.registry.lock(bot, deadline)
            try:
                current = self.registry.read(bot)
                if current:
                    if current["generation"] != value["generation"]: raise ValueError("Browser generation changed")
                    self.cleanup_resources(current)
            finally: os.close(lock)
        finally: self.close_handles(handles)


def own_scope(bot, cgroup="/proc/self/cgroup"):
    """This process's murage-browser-<bot>.<id>.scope, or None outside one."""
    try:
        with open(cgroup) as stream:
            paths = [line.rstrip("\n").split(":", 2)[2] for line in stream if line.startswith("0::")]
    except OSError:
        return None
    leaf = paths[0].rsplit("/", 1)[-1] if len(paths) == 1 else ""
    return leaf if re.fullmatch(r"murage-browser-" + re.escape(bot_id(bot)) + r"\.[0-9a-f]{8}\.scope", leaf) else None

def ensure(bot):
    # A fresh exec erases parsed FD3 key material before any persistent fork.
    subprocess.run(["/usr/bin/python3", "-I", HELPER, "ensure", bot_id(bot)],
                   env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, close_fds=True, timeout=11, check=True)


def stop(bot, deadline):
    budget = min(12000, max(1, int((deadline - time.monotonic()) * 1000)))
    subprocess.run(["/usr/bin/python3", "-I", HELPER, "stop", bot_id(bot), str(budget)],
                   env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, close_fds=True,
                   timeout=max(0.1, deadline - time.monotonic()), check=True)


def join(bot, prepare, account, env, validate, wait=None, enter=None):
    """`wait(child)`, when given, waits on the bwrap child in the launcher's
    place and returns its wait status (the session host's root supervisor).
    `enter()`, when given, runs first in the child, still as root: the
    launcher places the sandbox (its dedicated cgroup) before any privilege
    drop, so everything the child ever forks is born inside it."""
    controller = NamespaceController()
    registry = controller.registry
    lock = registry.lock(bot, time.monotonic() + 10)
    handles, resolver, child, readfd, writefd = {}, -1, None, -1, -1
    try:
        value = registry.read(bot)
        if not value: raise ValueError("Browser namespace missing")
        handles = controller.validate(value)
        resolver_path = registry.directory(bot) + "/resolv.conf"
        registry.check(resolver_path)
        resolver = os.open(resolver_path, os.O_RDONLY | os.O_NOFOLLOW)
        sandbox_gid = grp.getgrnam("murage-browser-sandbox").gr_gid  # gates the browser bwrap
        argv = prepare(resolver)  # Profile mount namespace is request-local.
        libc_call("setns", handles["net"], NEWNET)
        # No pid-ns setns: bwrap --unshare-pid creates the pid namespace it mounts /proc for.
        readfd, writefd = os.pipe2(os.O_CLOEXEC)
        child = os.fork()
        if child == 0:
            try:
                os.close(readfd)
                if enter is not None: enter()
                os.setgroups([sandbox_gid]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
                libc_call("prctl", 4, 0, 0, 0, 0)
                os.umask(0o077)
                close_except({writefd, resolver})
                validate()
                os.set_inheritable(resolver, True)
                os.execve(BROWSER_BWRAP, argv, env)
            except BaseException:
                try: os.write(writefd, b"pre-exec failed")
                except OSError: pass
                os._exit(1)
        os.close(writefd); writefd = -1
        if not select.select([readfd], [], [], 5)[0]:
            os.kill(child, signal.SIGKILL); os.waitpid(child, 0); child = None
            raise TimeoutError("Browser exec handoff timeout")
        error = os.read(readfd, 128)
        exited, status = os.waitpid(child, os.WNOHANG)
        # EOF marks direct bwrap exec only. An already-dead child is an early
        # failure; later wrapper/bwrap status remains the normal command result.
        if error or exited:
            if not exited: _, status = os.waitpid(child, 0)
            child = None
            raise ValueError("Browser exec handoff failed")
    finally:
        os.close(lock)  # Release before waiting for command completion.
        controller.close_handles(handles)
        for fd in (resolver, readfd, writefd):
            if fd >= 0: os.close(fd)
    status = wait(child) if wait is not None else os.waitpid(child, 0)[1]
    return os.waitstatus_to_exitcode(status)


@contextlib.contextmanager
def firewall_registry(context):
    controller = NamespaceController()
    registry = controller.registry
    lock = registry.global_lock("firewall")
    try:
        tuples = []
        for bot in os.listdir(registry.root):
            if bot.startswith("."): continue
            value = registry.read(bot)
            if not value or value["phase"] != "ready" or not value.get("active"): continue
            if value["route"] != context: raise ValueError("Browser route changed during firewall reload")
            handles = controller.validate(value)
            try:
                if registry.read(bot) != value: raise ValueError("Browser state changed during firewall reload")
                tuples.append((value["host"], value["address"]))
            finally: controller.close_handles(handles)
        yield tuples
    finally: os.close(lock)


def main():
    if os.geteuid() != 0 or len(sys.argv) not in {3, 4} or sys.argv[1] not in {"ensure", "stop"}:
        raise ValueError("Invalid browser helper invocation")
    close_except(set())
    controller = NamespaceController()
    if sys.argv[1] == "stop":
        milliseconds = int(sys.argv[3]) if len(sys.argv) == 4 else 12000
        if not 1 <= milliseconds <= 12000: raise ValueError("Invalid stop deadline")
        controller.stop(bot_id(sys.argv[2]), time.monotonic() + milliseconds / 1000)
    elif len(sys.argv) == 3: controller.ensure(bot_id(sys.argv[2]))
    else: raise ValueError("Invalid helper invocation")


if __name__ == "__main__":
    try: main()
    except BaseException:
        print("Browser namespace operation failed", file=sys.stderr)
        sys.exit(1)
