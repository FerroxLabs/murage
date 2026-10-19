#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Direct probe of the turn seccomp filter (run INSIDE a turn sandbox, i.e. under bwrap --seccomp).

Covers all 35 deny-list syscalls that exist on x86_64 and aarch64 (legacy umount
has no syscall on either), the seven clone namespace flags, clone3 (ENOSYS),
plus the intended-allowed cases. One PASS/FAIL line per case; last line is
SECCOMP_PROBE_FAILS <n>. Exit status is non-zero on any failure.
EPERM alone cannot prove the filter did it (capabilities/AppArmor also give
EPERM), so run the same probe outside the sandbox and compare, or check
/proc/self/status Seccomp: 2 (printed first).
"""
import ctypes, errno, os, platform, sys

NUMS = {  # name: (x86_64, aarch64)
    "unshare": (272, 97), "setns": (308, 268), "keyctl": (250, 219), "add_key": (248, 217),
    "request_key": (249, 218), "bpf": (321, 280), "perf_event_open": (298, 241),
    "userfaultfd": (323, 282), "io_uring_setup": (425, 425), "io_uring_enter": (426, 426),
    "io_uring_register": (427, 427), "ptrace": (101, 117), "process_vm_readv": (310, 270),
    "process_vm_writev": (311, 271), "kexec_load": (246, 104), "kexec_file_load": (320, 294),
    "init_module": (175, 105), "finit_module": (313, 273), "delete_module": (176, 106),
    "mount": (165, 40), "umount2": (166, 39), "pivot_root": (155, 41), "open_tree": (428, 428),
    "move_mount": (429, 429), "fsopen": (430, 430), "fsconfig": (431, 431), "fsmount": (432, 432),
    "fspick": (433, 433), "mount_setattr": (442, 442), "swapon": (167, 224), "swapoff": (168, 225),
    "reboot": (169, 142), "acct": (163, 89), "quotactl": (179, 60), "quotactl_fd": (443, 443),
}
CLONE, CLONE3, PERSONALITY = {"x86_64": (56, 435, 135), "aarch64": (220, 435, 92)}[platform.machine()] if platform.machine() in ("x86_64", "aarch64") else (None,) * 3
IDX = {"x86_64": 0, "aarch64": 1}.get(platform.machine())
if IDX is None:
    sys.exit("unsupported arch " + platform.machine())
assert len(NUMS) == 35
libc = ctypes.CDLL(None, use_errno=True)

def sc(nr, *a):
    a = list(a) + [0] * (6 - len(a))
    r = libc.syscall(ctypes.c_long(nr), *[ctypes.c_long(x) for x in a])
    return r, ctypes.get_errno()

fails = 0
def report(ok, label, e):
    global fails
    fails += not ok
    print(("PASS" if ok else "FAIL"), label, "->", errno.errorcode.get(e, e), flush=True)

for line in open("/proc/self/status"):
    if line.startswith("Seccomp:"):
        print(line.strip())
print("arch", platform.machine(), "cases", len(NUMS))
for name, nums in NUMS.items():
    r, e = sc(nums[IDX], 0, 0, 0)
    report(r == -1 and e == errno.EPERM, "deny " + name, e)
FLAGS = [("NEWUSER", 0x10000000), ("NEWNS", 0x20000), ("NEWNET", 0x40000000), ("NEWPID", 0x20000000),
         ("NEWIPC", 0x8000000), ("NEWUTS", 0x4000000), ("NEWCGROUP", 0x2000000)]
for lbl, fl in FLAGS:
    r, e = sc(CLONE, fl | 17, 0, 0, 0, 0)
    report(r == -1 and e == errno.EPERM, "clone " + lbl, e)
r, e = sc(CLONE, sum(f for _, f in FLAGS) | 17, 0, 0, 0, 0)
report(r == -1 and e == errno.EPERM, "clone ALL-NS-bits", e)
r, e = sc(CLONE3, 0, 0)
report(r == -1 and e == errno.ENOSYS, "clone3", e)
pid = os.fork()
if pid == 0:
    try:
        os.execv("/bin/true", ["true"])
    finally:
        os._exit(127)
_, st = os.waitpid(pid, 0)
ok = os.WIFEXITED(st) and os.WEXITSTATUS(st) == 0
report(ok, "plain fork+exec still works", 0)
r, e = sc(PERSONALITY, 0xffffffff)
report(r >= 0, "personality still allowed (intended)", 0)
print("SECCOMP_PROBE_FAILS", fails)
sys.exit(1 if fails else 0)
