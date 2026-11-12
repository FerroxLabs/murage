#!/usr/bin/env python3
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reference judge for the No-limits code reader (tool identity r1.2.1, lane nolimint, 1.0.19).

judge(identity, payload, mode) -> Verdict(verdict, cls, why, twins)

  verdict  "card" | "run"
  cls      "root" | "home" | "system" | "disk" | "fork" | "word" | "cut" | ""   (card class; "" for run)

This file IS the spec. The production port (server/no-limits-code.ts) must return the same verdict and class for
every row of judge_expected.tsv. Pure stdlib, no I/O except the CLI, never executes a payload.

Model (normative):
  * identity selects the root payload language:
      terminal | shell       -> "sh"   payload = the command text
      execute_code | python  -> "py"   payload = the code
      node                   -> "js"   payload = the code
      anything else (MCP...) -> "text" payload = a JSON value; every string leaf is one text payload
  * mode "nl" = owner No-limits, clean turn.  mode "nl-cut" = the hook message is truncated -> card:cut (W9).
  * A "sh" payload cards when (a) its wipe-class reader names a root/home/system target of a wipe-list effect, a
    disk writer or a fork bomb, or (b) the plainWipe word model hits (today's outside-scan.ts plainWipe, ported).
  * A "py"/"js" payload is NEVER given to the word model whole (W15). It gets:
      S1 target-free sweep over the whole decoded text (device names, device spellings, mkfs*, fork bomb, format X:)
      S2 every string literal, and every foldable literal expression, read as a "text" payload
      S3 terminal twins: each recognised wipe-list effect call becomes the shell command with the same effect,
         judged as a "sh" payload (full model incl. the word model). Code is never stricter than its twin.
  * A "text" payload gets the wipe-class reader and the target-free sweep, never the word model.
  * Reader failures, recursion/size limits and work overruns produce card:cut. Collected effects, including
    word effects, take precedence over cut. Grammar rejection may select the lexical reader; an incomplete
    lexical read is a cut. Expected non-matches (Unresolved, JSON grammar rejection) are not reader failures.
    MAX_TEXT bounds each text read; MAX_WORK bounds each AST/JS/JSON reader and the payload queue. A parser
    resource limit reported as SyntaxError is a cut too. These bounds never execute payload code.
  * Hops (sh -c, python -c, node -e, heredoc/here-string to an interpreter, eval, $(..), `..`, <(..), shell-out and
    exec twins) produce nested payloads at depth+1. Depth > MAX_DEPTH is not extracted (it runs, as unreadable does),
    but every root is still read whole by its own rules, so a wipe is never hidden by depth.
"""
from __future__ import annotations

import ast
import json
import re
import shlex
import sys
import unicodedata
from dataclasses import dataclass, field

MAX_DEPTH = 4
MAX_TEXT = 1_000_000       # inclusive cut boundary, measured in Unicode code points
MAX_WORK = 1_000_000      # AST visits/resolution, JS tokens/scans, JSON leaves, queued payloads
CLASS_ORDER = ["root", "home", "system", "disk", "fork", "word", "cut"]  # detected effects win over cut


class ReaderCut(Exception):
    """A deterministic reader size/work bound was reached."""


class Budget:
    def __init__(self):
        self.left = MAX_WORK

    def tick(self):
        self.left -= 1
        if self.left < 0:
            raise ReaderCut("reader work budget exceeded")

    def walk(self, tree):
        for node in ast.walk(tree):
            self.tick()
            yield node


def bounded_text(text):
    if len(text) >= MAX_TEXT:
        raise ReaderCut("reader text size limit")
    return text


@dataclass
class Verdict:
    verdict: str
    cls: str
    why: str
    twins: list = field(default_factory=list)


# ------------------------------------------------------------------------------------------------------------------
# plainWipe word model (port of server/outside-scan.ts plainWipe at 5cf79747a, lines 121-260)

def decode_ansi_c(text: str) -> str:
    one = {"n": "\n", "t": "\t", "r": "\r", "a": "\x07", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "v": "\v"}

    def esc(m: re.Match) -> str:
        e = m.group(1)
        lead = e[0]
        if lead in "xuU" and len(e) > 1:
            p = int(e[1:], 16)
            return chr(p) if p <= 0x10FFFF else ""
        if lead in "01234567":
            return chr(int(e, 8) & 0xFF)
        if lead == "c" and len(e) == 2:
            return chr(ord(e[1]) & 0x1F)
        return one.get(lead, lead)

    def body(m: re.Match) -> str:
        return re.sub(r"\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])", esc, m.group(1))

    return re.sub(r"\$'((?:[^'\\]|\\[\s\S])*)'", body, text)


WIPE = set("""rm rmdir unlink shred srm dd mkfs newfs wipefs fdisk sfdisk parted gpart diskutil diskpart
  format-volume clear-disk remove-item ri del erase rd deltree rmtree rmsync rmdirsync unlinksync rimraf removedirs
  remove removefile deletefile removedirectory delete truncate""".split())
SEGMENT_SPLIT = re.compile(r"([\s(){}<>,=:.\[\]]+)")
DELETE_OPTIONS = set("delete delete-after delete-before delete-during delete-excluded".split())
RECURSE_AFTER = set("remove-item ri rm del rd gci get-childitem".split())
DEV_OK = ["null", "zero", "random", "urandom", "stdin", "stdout", "stderr", "tty", "ptmx", "fd/", "pts/", "shm/"]
DEVICE_SPELLINGS = ["physicaldrive", "harddisk", "\\\\.\\", "//./", "rdisk", ":(){", ":|:"]


def names_device(s: str) -> bool:
    at = s.find("/dev/")
    while at >= 0:
        rest = s[at + 5:]
        if not any(rest.startswith(ok) for ok in DEV_OK):
            return True
        at = s.find("/dev/", at + 1)
    return False


def folded(text: str) -> str:
    return unicodedata.normalize("NFKC", decode_ansi_c(text)).lower()


def parts_of(word: str) -> list:
    out, frm = [], 0
    while True:
        eq = word.find("=", frm)
        value = word[frm:]
        out.append(value)
        cut = max(value.rfind("/"), value.rfind("\\")) + 1
        base = re.sub(r"\.exe$", "", value[cut:], flags=re.I)
        if base and base != value:
            out.append(base)
        if not value.startswith("-"):
            break
        bare = value.lstrip("-")
        if bare:
            out.append(bare)
        if eq < 0 or eq >= len(word) - 1:
            break
        frm = eq + 1
    return out


def _format_segments(text: str, quotes: str, seps: str) -> list:
    segs, quote, start = [], "", 0
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = ""
        elif ch in quotes:
            quote = ch
        elif ch in seps:
            segs.append(text[start:i])
            start = i + 1
    segs.append(text[start:])
    return segs


def format_in(text: str, depth: int = 0) -> bool:
    if depth > 2:
        return False
    for seg in _format_segments(text, "'\"", ";&|\n") + _format_segments(text, '"', "&|\n"):
        seg = seg.strip()
        w = seg.split() if seg else []
        if len(w) < 2:
            continue
        name = w[0][max(w[0].rfind("/"), w[0].rfind("\\")) + 1:].lower()
        name = re.sub(r"\.(com|exe)$", "", name)
        if name == "format" and re.match(r"^[a-z]:[\\/]?$", w[1], re.I):
            return True
        if name in ("cmd", "powershell", "pwsh"):
            for k in range(1, len(w)):
                if re.match(r"^(/[ck]|-(c|command))$", w[k], re.I):
                    rest = seg.split(None, k + 1)
                    if len(rest) > k + 1:
                        inner = rest[k + 1].strip()
                        if len(inner) >= 2 and inner[0] in "\"'" and inner[-1] == inner[0]:
                            inner = inner[1:-1]
                        if format_in(inner, depth + 1):
                            return True
                    break
    return False


def wipe_words(s: str) -> bool:
    recurse_armed = False
    for segment in re.split(r"[;&|\n]", s):
        git = False
        tokens = SEGMENT_SPLIT.split(segment)
        for word in tokens[0::2]:
            if not word:
                continue
            parts = parts_of(word)
            for part in parts:
                if part in WIPE or part.startswith("mkfs") or part in DELETE_OPTIONS:
                    return True
                if git and part == "clean":
                    return True
                if recurse_armed and part == "recurse":
                    return True
            if "git" in parts:
                git = True
            if any(p in RECURSE_AFTER for p in parts):
                recurse_armed = True
    return False


def plain_wipe(text: str) -> bool:
    raw = folded(text)
    if names_device(raw) or any(sp in raw for sp in DEVICE_SPELLINGS) or format_in(raw):
        return True
    s = re.sub(r"[\"'`\\]", "", raw)
    if names_device(s) or any(sp in s for sp in DEVICE_SPELLINGS):
        return True
    return wipe_words(s) or wipe_words(re.sub(r"[\"'`]", "", raw).replace("\\", "/"))


def target_free(text: str) -> str:
    """S1: plainWipe's target-free tests only. Returns a class or ""."""
    raw = folded(text)
    if ":(){" in raw or ":|:" in raw:
        return "fork"
    if names_device(raw) or any(sp in raw for sp in DEVICE_SPELLINGS[:5]) or format_in(raw):
        return "disk"
    if re.search(r"(?<![a-z0-9_])mkfs(\.[a-z0-9]+)?(?![a-z0-9_])", raw):
        return "disk"
    return ""


# ------------------------------------------------------------------------------------------------------------------
# path classes (port of always-ask.ts classifyPath at 5cf79747a:208-237)

SYSTEM_FOLDERS = {"/applications", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/library",
                  "/opt", "/private", "/proc", "/root", "/sbin", "/srv", "/sys", "/system", "/users", "/usr", "/var"}
WINDOWS_SYSTEM_FOLDERS = {"windows", "program files", "program files (x86)", "programdata", "users"}


def classify_path(raw: str) -> str:
    p = raw.strip()
    if not p or "$MURAGE_U" in p:
        return ""
    p = re.sub(r"^(\$HOME|\$\{HOME\})(?=/|$)", "~", p)
    p = p.replace("\\", "/")
    drive = re.match(r"^[a-z]:(/.*)?$", p, re.I)
    if drive:
        rest = re.sub(r"(/\*|/\.)+$", "", drive.group(1) or "")
        rest = rest.rstrip("/").lstrip("/").lower()
        if not rest:
            return "root"
        if rest in WINDOWS_SYSTEM_FOLDERS:
            return "system"
        if re.match(r"^users/[^/]+$", rest):
            return "home"
        return ""
    p = re.sub(r"/{2,}", "/", p)
    while True:
        nxt = re.sub(r"/\*$", "", p)
        nxt = re.sub(r"/\.$", "", nxt)
        nxt = re.sub(r"(.)/$", r"\1", nxt)
        if nxt == p:
            break
        p = nxt
    # normalise `..` and `.` for anchored paths
    if p.startswith("/"):
        out = []
        for seg in p.split("/"):
            if seg in ("", "."):
                continue
            if seg == "..":
                if out:
                    out.pop()
                continue
            out.append(seg)
        p = "/" + "/".join(out)
    if p in ("/", "/*", ""):
        return "root"
    if p == "~" or re.match(r"^~[A-Za-z0-9._-]+$", p) or p in ("~/*",):
        return "home"
    low = p.lower()
    if re.match(r"^/(users|home)/[^/]+$", low):
        return "home"
    if low in SYSTEM_FOLDERS:
        return "system"
    return ""


def best(classes) -> str:
    cs = [c for c in classes if c]
    if not cs:
        return ""
    return min(cs, key=CLASS_ORDER.index)


# ------------------------------------------------------------------------------------------------------------------
# shell reading: heredocs, words, simple commands, hops

HEREDOC = re.compile(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n(.*?)\n[ \t]*\3[ \t]*(?=\n|$)", re.S)
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"}
PREFIXES = {"sudo", "doas", "env", "command", "exec", "nohup", "time", "builtin", "xargs", "nice", "ionice", "stdbuf"}
DELETE_PROGS = {"rm", "rmdir", "unlink", "shred", "srm", "truncate", "rimraf", "del", "erase", "rd", "deltree",
                "remove-item", "ri"}
DISK_WRITERS = {"mke2fs", "newfs", "wipefs", "diskutil", "format-volume", "clear-disk", "initialize-disk", "mknod",
                "diskpart", "fdisk", "sfdisk", "parted", "gpart"}


def lang_of_program(name: str) -> str:
    if re.match(r"^(python|pypy|py)(?:[0-9.]*w?|[0-9.]*[0-9](?:t|d|td)w?)$", name):
        return "py"
    if name in ("node", "nodejs", "bun", "deno"):
        return "js"
    if name in SHELLS:
        return "sh"
    return ""


def _basename(word: str) -> str:
    b = word[max(word.rfind("/"), word.rfind("\\")) + 1:].lower()
    return re.sub(r"\.(exe|cmd|com)$", "", b)


def _balanced_bodies(text: str, opener: str) -> list:
    """Bodies of $( ... ) or <( ... ) (balanced parens, quote-unaware but nesting-aware)."""
    out, i = [], 0
    while True:
        i = text.find(opener, i)
        if i < 0:
            return out
        j, depth = i + len(opener), 1
        while j < len(text) and depth:
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
            j += 1
        out.append(text[i + len(opener): j - 1] if depth == 0 else text[i + len(opener):])
        i = i + len(opener)


def simple_commands(text: str):
    """Yield word lists of each simple command (quotes removed). None on a tokenizer failure."""
    try:
        lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>")
        lex.whitespace = " \t\r"
        lex.whitespace_split = True
        lex.commenters = ""
        toks = list(lex)
    except ValueError:
        return None
    cmds, cur = [], []
    for t in toks:
        if t == "\n" or (t and set(t) <= set(";&|()")):
            if cur:
                cmds.append(cur)
            cur = []
        elif t and set(t) <= set("<>"):
            cur.append(t)
        else:
            for piece in t.split("\n"):
                if piece == "" and cur:
                    cmds.append(cur)
                    cur = []
                elif piece:
                    cur.append(piece)
    if cur:
        cmds.append(cur)
    return cmds


def strip_prefixes(words: list) -> list:
    w = list(words)
    while w:
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]):
            w = w[1:]
            continue
        b = _basename(w[0])
        if b in PREFIXES:
            w = w[1:]
            while w and w[0].startswith("-"):
                w = w[1:] if not re.match(r"^-(n|u|g|c)$", w[0]) else w[2:]
            continue
        break
    return w


def operands(words: list, valued: set) -> list:
    out, i, opts = [], 0, True
    while i < len(words):
        a = words[i]
        if opts and a == "--":
            opts = False
        elif opts and a.startswith("-") and a != "-":
            if a in valued:
                i += 1
        elif a in ("<", ">", ">>", "<<", "<<<"):
            i += 1
        else:
            out.append(a)
        i += 1
    return out


def read_sh(text: str, depth: int, nested: list, text_mode: bool = False, collected=None) -> tuple:
    """Wipe-class reader for one shell text. Returns (class, why). Appends hop payloads to `nested`.
    text_mode (prose, MCP leaves, code literals): every word that names a wipe-list program starts a command."""
    classes, whys = collected if collected is not None else [], []
    class_start = len(classes)
    text = decode_ansi_c(text)
    # Windows path separators survive the POSIX word split (C:\Windows)
    text = re.sub(r"\\(?=[A-Za-z0-9 ._()-])", "/", text)
    tf = target_free(text)
    if tf:
        classes.append(tf)
        whys.append("target-free " + tf)
    bodies = []
    for m in HEREDOC.finditer(text):
        bodies.append((m.start(), m.group(4)))
    stripped = HEREDOC.sub(lambda m: " __HEREDOC_%d__" % m.start(), text)
    for opener in ("$(", "<("):
        for b in _balanced_bodies(stripped, opener):
            nested.append(("sh", b, depth + 1, "subst"))
    for b in re.findall(r"`([^`]*)`", stripped):
        nested.append(("sh", b, depth + 1, "backtick"))
    cmds = simple_commands(stripped)
    if cmds is None:
        # Ordinary text literals may contain unmatched shell quotes; they are not shell programs.
        if not text_mode:
            classes.append("cut")
        return best(classes[class_start:]), "; ".join(whys) or "tokenizer stop"
    hd_index = {}
    for start, body in bodies:
        hd_index["__HEREDOC_%d__" % start] = body
    if text_mode:
        starts = []
        for words in cmds:
            for k, wd in enumerate(words):
                b = _basename(wd)
                if b in DELETE_PROGS or b in DISK_WRITERS or b.startswith("mkfs") or b in ("dd", "find", "rsync", "format"):
                    starts.append(words[k:])
        cmds = starts
    for words in cmds:
        w = strip_prefixes(words)
        if not w:
            continue
        name = _basename(w[0])
        args = w[1:]
        lang = lang_of_program(name)
        # heredoc / here-string bodies fed to this command
        for k, a in enumerate(args):
            if a in hd_index:
                nested.append((lang or "text", hd_index[a], depth + 1, "heredoc"))
            if a == "<<<" and k + 1 < len(args):
                nested.append((lang or "text", args[k + 1], depth + 1, "herestring"))
        if lang == "sh":
            for k, a in enumerate(args):
                if re.match(r"^-[a-z]*c[a-z]*$", a) and k + 1 < len(args):
                    nested.append(("sh", args[k + 1], depth + 1, "-c"))
                    break
        elif lang == "py":
            for k, a in enumerate(args):
                if a == "-c" and k + 1 < len(args):
                    nested.append(("py", args[k + 1], depth + 1, "-c"))
                    break
        elif lang == "js":
            for k, a in enumerate(args):
                if a in ("-e", "--eval", "-p", "--print") and k + 1 < len(args):
                    nested.append(("js", args[k + 1], depth + 1, a))
                    break
        if name == "eval":
            nested.append(("sh", " ".join(args), depth + 1, "eval"))
        if name in ("source", ".") and args:
            pass
        if name in ("cmd",):
            for k, a in enumerate(args):
                if a.lower() in ("/c", "/k") and k + 1 < len(args):
                    nested.append(("sh", " ".join(args[k + 1:]), depth + 1, "cmd /c"))
                    break
        if name in ("powershell", "pwsh"):
            for k, a in enumerate(args):
                if a.lower() in ("-c", "-command") and k + 1 < len(args):
                    nested.append(("sh", " ".join(args[k + 1:]), depth + 1, "pwsh -c"))
                    break
        # wipe-list effects with targets
        if name in DISK_WRITERS or name.startswith("mkfs") or (name == "format" and args and re.match(r"^[a-z]:[\\/]?$", args[0], re.I)):
            classes.append("disk")
            whys.append(name)
            continue
        if name == "dd":
            for a in args:
                if a.startswith("of=") and names_device(a[3:].lower()):
                    classes.append("disk")
                    whys.append("dd of=device")
            continue
        targets = []
        if name in DELETE_PROGS:
            valued = {"-s", "--size", "-r", "--reference", "-n", "--iterations"} if name in ("truncate", "shred") else set()
            targets = operands(args, valued)
            if name == "truncate" and "-s" not in args and not any(a.startswith("--size") for a in args):
                pass
        elif name == "find" and "-delete" in args:
            for a in args:
                if a.startswith("-") or a in ("(", "!"):
                    break
                targets.append(a)
        elif name == "rsync" and any(re.match(r"^--del(e(t(e.*)?)?)?$", a) for a in args):
            targets = operands(args, set())[1:]
        elif name == "git" and "clean" in args:
            targets = []
        for t in targets:
            c = classify_path(t)
            if c:
                classes.append(c)
                whys.append("%s %s" % (name, t))
    return best(classes[class_start:]), "; ".join(whys)


# ------------------------------------------------------------------------------------------------------------------
# Python twins (ast)

DELETE_MODULES = {"shutil", "os", "pathlib", "os.path"}
PY_RECURSIVE = {("shutil", "rmtree"), ("os", "removedirs")}
PY_FILE = {("os", "remove"), ("os", "unlink")}
PY_DIR = {("os", "rmdir")}
PY_TRUNC = {("os", "truncate")}
PY_SHELL = {("os", "system"), ("os", "popen"), ("subprocess", "getoutput"), ("subprocess", "getstatusoutput"),
            ("commands", "getoutput")}
PY_SUBPROCESS = {"run", "call", "check_call", "check_output", "Popen"}
PY_EXEC_ARGV = {"execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe",
                "spawnv", "spawnve", "spawnvp", "spawnvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe", "posix_spawn",
                "posix_spawnp"}


class Unresolved(Exception):
    pass


class PyReader:
    def __init__(self, code: str, budget=None):
        self.twins = []
        self.literals = []
        self.budget = budget or Budget()
        self.tree = ast.parse(code)
        self.aliases = {}       # local name -> dotted module path or "module.attr"
        self.assign = {}        # name -> value expr (single assignment)
        self.assign_count = {}
        self.unresolved_n = 0
        self.literals = []      # S2: literal / foldable values
        self.twins = []         # (lang, text, why)
        self._scan_bindings()
        # well-known modules count as bound when the code never binds the name itself (a NameError would run
        # nothing, so this only ever adds a twin)
        for mod in ("os", "shutil", "subprocess", "pathlib", "sys", "importlib"):
            if mod not in self.aliases and self.assign_count.get(mod, 0) == 0:
                self.aliases[mod] = mod

    # -- bindings -------------------------------------------------------------------------------------------------
    def _bump(self, name):
        self.assign_count[name] = self.assign_count.get(name, 0) + 1

    def _scan_bindings(self):
        for node in self.budget.walk(self.tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.asname:
                        self.aliases[a.asname] = a.name
                    else:
                        self.aliases[a.name.split(".")[0]] = a.name.split(".")[0]
                    self._bump(a.asname or a.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                for a in node.names:
                    self.aliases[a.asname or a.name] = node.module + "." + a.name
                    self._bump(a.asname or a.name)
            elif isinstance(node, ast.Assign):
                for t in node.targets:
                    for n in self.budget.walk(t):
                        if isinstance(n, ast.Name):
                            self._bump(n.id)
                            if isinstance(t, ast.Name):
                                self.assign[n.id] = node.value
            elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                if isinstance(node.target, ast.Name):
                    self._bump(node.target.id)
                    if isinstance(node, ast.AnnAssign) and node.value is not None:
                        self.assign[node.target.id] = node.value
                    elif isinstance(node, ast.AugAssign):
                        self._bump(node.target.id)
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                for n in self.budget.walk(node.target):
                    if isinstance(n, ast.Name):
                        self._bump(n.id)
                        self._bump(n.id)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for it in node.items:
                    if it.optional_vars is not None:
                        for n in self.budget.walk(it.optional_vars):
                            if isinstance(n, ast.Name):
                                self._bump(n.id)
                                self._bump(n.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                for a in self.budget.walk(node.args):
                    if isinstance(a, ast.arg):
                        self._bump(a.arg)
                        self._bump(a.arg)
            elif isinstance(node, ast.NamedExpr):
                self._bump(node.target.id)
                self._bump(node.target.id)

    # -- dotted names -----------------------------------------------------------------------------------------------
    def dotted(self, node) -> str | None:
        """Resolve a callee to a dotted path through aliases: `s.rmtree` -> `shutil.rmtree`."""
        self.budget.tick()
        if isinstance(node, ast.Name):
            return self.aliases.get(node.id, node.id if node.id in ("exec", "eval", "compile", "open", "getattr", "__import__") else None) \
                if node.id in self.aliases or node.id in ("exec", "eval", "compile", "open", "getattr", "__import__") else None
        if isinstance(node, ast.Attribute):
            base = self.dotted(node.value)
            return base + "." + node.attr if base else None
        if isinstance(node, ast.Call):
            f = self.dotted(node.func)
            if f in ("__import__", "importlib.import_module") and node.args:
                try:
                    return self.resolve(node.args[0], 0)
                except Unresolved:
                    return None
            if f == "getattr" and len(node.args) >= 2:
                base = self.dotted(node.args[0])
                if base is None:
                    return None
                try:
                    return base + "." + self.resolve(node.args[1], 0)
                except Unresolved:
                    return base + ".<dynamic>"
            if f in ("pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath"):
                return "pathlib.Path()"
        return None

    def path_receiver(self, node):
        """For `Path(T).unlink()`-style calls: the Path(...) expression's resolved target, else raise."""
        return self.resolve(node, 0)

    # -- argument resolution ------------------------------------------------------------------------------------------
    def fresh(self) -> str:
        self.unresolved_n += 1
        return "$MURAGE_U%d" % self.unresolved_n

    def resolve(self, node, depth: int):
        """A literal value (str or list of str), or raise Unresolved."""
        self.budget.tick()
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (str, int, float)) and not isinstance(node.value, bool):
                return str(node.value)
            if isinstance(node.value, bytes):
                return node.value.decode("latin-1")
            raise Unresolved()
        if isinstance(node, ast.JoinedStr):
            out = ""
            for v in node.values:
                if isinstance(v, ast.Constant):
                    out += str(v.value)
                elif isinstance(v, ast.FormattedValue) and v.conversion == -1 and v.format_spec is None:
                    out += self._str(self.resolve(v.value, depth))
                else:
                    raise Unresolved()
            return out
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self._str(self.resolve(e, depth)) for e in node.elts]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            a, b = self.resolve(node.left, depth), self.resolve(node.right, depth)
            if isinstance(a, list) and isinstance(b, list):
                return a + b
            return self._str(a) + self._str(b)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self._join([self.resolve(node.left, depth), self.resolve(node.right, depth)])
        if isinstance(node, ast.Name):
            if depth >= 1 or self.assign_count.get(node.id, 0) != 1 or node.id not in self.assign:
                raise Unresolved()
            return self.resolve(self.assign[node.id], depth + 1)
        if isinstance(node, ast.Attribute):
            d = self.dotted(node)
            if d == "os.sep":
                return "/"
            if d == "sys.executable":
                return "python3"
            raise Unresolved()
        if isinstance(node, ast.Subscript):
            d = self.dotted(node.value)
            if d == "os.environ":
                key = self.resolve(node.slice, depth)
                if key == "HOME":
                    return "$HOME"
            raise Unresolved()
        if isinstance(node, ast.Call):
            f = self.dotted(node.func)
            args = node.args
            if f in ("os.path.join", "posixpath.join") and args:
                return self._join([self.resolve(a, depth) for a in args])
            if f in ("os.path.expanduser",) and len(args) == 1:
                return self.resolve(args[0], depth)
            if f in ("os.path.abspath", "os.path.normpath", "os.path.realpath", "str", "os.fspath") and len(args) == 1:
                return self.resolve(args[0], depth)
            if f in ("pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath"):
                return self._join([self.resolve(a, depth) for a in args]) if args else "."
            if f in ("pathlib.Path.home", "os.getcwd") or (isinstance(node.func, ast.Attribute) and node.func.attr == "home"
                                                           and self.dotted(node.func.value) in ("pathlib.Path", "pathlib.PurePath")):
                if f == "os.getcwd":
                    raise Unresolved()
                return "~"
            if f in ("os.getenv", "os.environ.get") and args:
                if self.resolve(args[0], depth) == "HOME":
                    return "$HOME"
                raise Unresolved()
            if isinstance(node.func, ast.Attribute) and node.func.attr in ("expanduser", "resolve", "absolute") and not args:
                return self.resolve(node.func.value, depth)
            if isinstance(node.func, ast.Attribute) and node.func.attr == "joinpath":
                return self._join([self.resolve(node.func.value, depth)] + [self.resolve(a, depth) for a in args])
        raise Unresolved()

    @staticmethod
    def _str(v):
        return " ".join(v) if isinstance(v, list) else v

    @staticmethod
    def _join(parts):
        out = ""
        for p in parts:
            p = PyReader._str(p)
            if p.startswith("/") or not out:
                out = p
            else:
                out = out.rstrip("/") + "/" + p
        return out

    def arg(self, node) -> str:
        try:
            return self._str(self.resolve(node, 0))
        except Unresolved:
            return self.fresh()

    # -- effects ------------------------------------------------------------------------------------------------------
    def kw(self, call, name):
        for k in call.keywords:
            if k.arg == name:
                return k.value
        return None

    def kw_true(self, call, name) -> bool:
        v = self.kw(call, name)
        return isinstance(v, ast.Constant) and v.value is True

    def twin_delete(self, flag: str, target: str, why: str):
        self.twins.append(("sh", "%s -- %s" % (flag, shlex.quote(target) if not target.startswith("$") else '"%s"' % target), why))

    def run(self):
        for node in self.budget.walk(self.tree):
            # S2 literals and foldable expressions
            if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)):
                self.literals.append(node.value if isinstance(node.value, str) else node.value.decode("latin-1"))
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                try:
                    v = self.resolve(node, 1)
                    self.literals.append(self._str(v))
                except Unresolved:
                    pass
            if not isinstance(node, ast.Call):
                continue
            f = self.dotted(node.func)
            attr = node.func.attr if isinstance(node.func, ast.Attribute) else None
            first = node.args[0] if node.args else None
            if f is None and attr in ("unlink", "rmdir") and isinstance(node.func, ast.Attribute):
                recv = node.func.value
                if isinstance(recv, ast.Call) and (self.dotted(recv.func) or "").startswith("pathlib."):
                    f = "pathlib.Path()." + attr
            if f is None:
                continue
            mod, _, name = f.rpartition(".")
            if f.endswith(".<dynamic>") and mod.split(".")[0] in ("shutil", "os", "pathlib"):
                self.twin_delete("rm -rf", self.fresh(), "unresolved callee on " + mod)
            elif (mod, name) in PY_RECURSIVE and first is not None:
                self.twin_delete("rm -rf", self.arg(first), f)
            elif (mod, name) in PY_FILE and first is not None:
                self.twin_delete("rm -f", self.arg(first), f)
            elif (mod, name) in PY_DIR and first is not None:
                self.twin_delete("rmdir", self.arg(first), f)
            elif (mod, name) in PY_TRUNC and first is not None:
                size = self.arg(node.args[1]) if len(node.args) > 1 else "0"
                t = self.arg(first)
                self.twins.append(("sh", "truncate -s %s -- %s" % (shlex.quote(size), shlex.quote(t) if not t.startswith("$") else '"%s"' % t), f))
            elif f in ("pathlib.Path().unlink", "pathlib.Path().rmdir") or (attr in ("unlink", "rmdir") and isinstance(node.func.value, ast.Call)
                                                                           and (self.dotted(node.func.value.func) or "").startswith("pathlib.")):
                recv = node.func.value
                t = self.arg(recv)
                self.twin_delete("rm -f" if name == "unlink" else "rmdir", t, f)
            elif mod == "pathlib.Path()" and name in ("unlink", "rmdir"):
                self.twin_delete("rm -f" if name == "unlink" else "rmdir", self.fresh(), f)
            elif (mod, name) in PY_SHELL and first is not None:
                self.twins.append(("sh", self.arg(first), f))
            elif mod == "subprocess" and name in PY_SUBPROCESS and first is not None:
                shell = self.kw_true(node, "shell")
                try:
                    v = self.resolve(first, 0)
                except Unresolved:
                    v = self.fresh()
                if isinstance(v, list):
                    self.twins.append(("sh", " ".join(shlex.quote(x) if not x.startswith("$MURAGE_U") else '"%s"' % x for x in v), f))
                elif shell or v.startswith("$MURAGE_U"):
                    self.twins.append(("sh", v if not v.startswith("$MURAGE_U") else '"%s"' % v, f))
                else:
                    self.twins.append(("sh", shlex.quote(v), f + " (argv0)"))
            elif mod == "os" and name in PY_EXEC_ARGV and node.args:
                if name.endswith(("v", "ve", "vp", "vpe")) or name.startswith("posix_spawn"):
                    argv_node = node.args[1] if len(node.args) > 1 else None
                    try:
                        argv = self.resolve(argv_node, 0) if argv_node is not None else []
                    except Unresolved:
                        argv = [self.fresh()]
                else:
                    argv = [self.arg(a) for a in node.args[1:]]
                argv = argv if isinstance(argv, list) else [argv]
                self.twins.append(("sh", " ".join(shlex.quote(x) if not x.startswith("$MURAGE_U") else '"%s"' % x for x in argv), f))
            elif f in ("exec", "eval", "compile") and first is not None:
                try:
                    v = self._str(self.resolve(first, 0))
                    self.twins.append(("py", v, f))
                except Unresolved:
                    pass
        return self


def lexical_strings(code: str, visit=None):
    """Forward-only quote scanner. Each source character is visited at most once.

    Yields (opening offset, end offset, raw body); an unfinished string is a cut.
    `visit` is an optional test counter, never a clock or payload callback.
    """
    i, n = 0, len(code)
    while i < n:
        ch = code[i]
        if visit:
            visit()
        i += 1
        if ch not in "\"'":
            continue
        start, body = i - 1, i
        while i < n:
            c = code[i]
            if visit:
                visit()
            i += 1
            if c == "\\":
                if i < n:
                    if visit:
                        visit()
                    i += 1
            elif c == ch:
                yield start, i, code[body:i - 1]
                break
        else:
            raise ReaderCut("unterminated fallback string")


def py_lexical_fallback(code: str, twins=None, lits=None, visit=None):
    """A parse rejection uses a complete lexical read; runtime/resource failures are cuts.

    Fixed callee patterns and the forward-only string scanner have no overlapping
    alternation. Caller-owned lists retain effects if scanning stops partway through.
    """
    twins = [] if twins is None else twins
    lits = [] if lits is None else lits
    for m in re.finditer(r"\b(shutil\.rmtree|os\.removedirs|os\.remove|os\.unlink|os\.rmdir|os\.truncate|\.unlink\(\)|\.rmdir\(\))", code):
        twins.append(("sh", 'rm -rf -- "$MURAGE_U0"', "lexical " + m.group(1)))
    calls = {m.end(): m.group(1) for m in re.finditer(
        r"\b(os\.system|os\.popen|subprocess\.\w+)\s*\(\s*", code)}
    for start, end, body in lexical_strings(code, visit):
        lits.append(body)
        if start in calls:
            j = end
            while j < len(code) and code[j].isspace():
                j += 1
            if j < len(code) and code[j] in ",)":
                twins.append(("sh", body, "lexical " + calls[start]))
    return twins, lits


# ------------------------------------------------------------------------------------------------------------------
# Node twins (lexical; the production port uses the same token rules)

JS_TOKEN = re.compile(r"""
   (?P<ws>\s+|//[^\n]*|/\*.*?\*/)
 | (?P<str>'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")
 | (?P<tpl>`(?:\\.|[^`\\])*`)
 | (?P<id>[A-Za-z_$][A-Za-z0-9_$]*)
 | (?P<num>\d+(?:\.\d+)?)
 | (?P<p>=>|\.\.\.|[{}()\[\];,.:=+?!<>|&*/%-])
""", re.S | re.X)


def js_unescape(body: str) -> str:
    try:
        return json.loads('"' + body.replace('"', '\\"').replace("\\'", "'") + '"')
    except json.JSONDecodeError:
        return body


def js_tokens(code: str, budget=None):
    out, i = [], 0
    while i < len(code):
        if budget:
            budget.tick()
        m = JS_TOKEN.match(code, i)
        if not m:
            out.append(("p", code[i]))
            i += 1
            continue
        i = m.end()
        k = m.lastgroup
        if k == "ws":
            continue
        v = m.group(k)
        if k == "str":
            out.append(("str", js_unescape(v[1:-1])))
        elif k == "tpl":
            body = v[1:-1]
            out.append(("str", js_unescape(body)) if "${" not in body else ("tpl", body))
        else:
            out.append((k, v))
    return out


JS_FS_MODS = {"fs", "node:fs", "fs/promises", "node:fs/promises", "fs-extra", "graceful-fs"}
JS_CP_MODS = {"child_process", "node:child_process"}
JS_OS_MODS = {"os", "node:os"}
JS_PATH_MODS = {"path", "node:path"}


class JsReader:
    def __init__(self, code: str, budget=None):
        self.twins, self.literals = [], []
        self.budget = budget or Budget()
        self.t = js_tokens(code, self.budget)
        self.alias = {}      # name -> "fs" | "fs.rmSync" | "cp" | "cp.execSync" | "os" | "path" | "rimraf"
        self.assign = {}     # name -> (start, end) token slice of the single initializer
        self.count = {}
        self.unresolved_n = 0
        self.twins = []
        self.literals = [v for k, v in self.t if k == "str"]
        self._bindings()

    def fresh(self):
        self.unresolved_n += 1
        return "$MURAGE_U%d" % self.unresolved_n

    def _module_of(self, i):
        """At token i: `require('x')` or `await import('x')` -> (module, next index)."""
        t = self.t
        if i + 3 < len(t) and t[i] == ("id", "require") and t[i + 1] == ("p", "(") and t[i + 2][0] == "str" and t[i + 3] == ("p", ")"):
            return t[i + 2][1], i + 4
        return None, i

    def _kind(self, mod):
        if mod in JS_FS_MODS:
            return "fs"
        if mod in JS_CP_MODS:
            return "cp"
        if mod in JS_OS_MODS:
            return "os"
        if mod in JS_PATH_MODS:
            return "path"
        if mod == "rimraf":
            return "rimraf"
        if mod == "vm" or mod == "node:vm":
            return "vm"
        return None

    def _end_of_expr(self, i):
        depth = 0
        while i < len(self.t):
            self.budget.tick()
            k, v = self.t[i]
            if v in ("(", "[", "{"):
                depth += 1
            elif v in (")", "]", "}"):
                if depth == 0:
                    return i
                depth -= 1
            elif depth == 0 and v in (";", ","):
                return i
            i += 1
        return i

    def _bindings(self):
        t = self.t
        n = len(t)
        for i in range(n):
            self.budget.tick()
            k, v = t[i]
            # import fs from 'fs'; import * as fs from 'fs'; import {rmSync as r} from 'fs'
            if (k, v) == ("id", "import"):
                j = i + 1
                names = []
                if j < n and t[j] == ("p", "*") and j + 2 < n and t[j + 1] == ("id", "as"):
                    names.append((t[j + 2][1], None))
                    j += 3
                elif j < n and t[j][0] == "id" and t[j][1] != "from":
                    names.append((t[j][1], None))
                    j += 1
                    if j < n and t[j] == ("p", ","):
                        j += 1
                if j < n and t[j] == ("p", "{"):
                    j += 1
                    while j < n and t[j] != ("p", "}"):
                        self.budget.tick()
                        if t[j][0] == "id":
                            src = t[j][1]
                            loc = src
                            if j + 2 < n and t[j + 1] == ("id", "as"):
                                loc = t[j + 2][1]
                                j += 2
                            names.append((loc, src))
                        j += 1
                    j += 1
                if j + 1 < n and t[j] == ("id", "from") and t[j + 1][0] == "str":
                    kind = self._kind(t[j + 1][1])
                    if kind:
                        for loc, src in names:
                            self.budget.tick()
                            self.alias[loc] = kind + ("." + src if src else "")
                            self.count[loc] = self.count.get(loc, 0) + 1
            if k == "id" and v in ("const", "let", "var"):
                j = i + 1
                if j < n and t[j] == ("p", "{"):
                    # const {rmSync, execSync: x} = require('...')
                    j += 1
                    pairs = []
                    while j < n and t[j] != ("p", "}"):
                        self.budget.tick()
                        if t[j][0] == "id":
                            src, loc = t[j][1], t[j][1]
                            if j + 2 < n and t[j + 1] == ("p", ":") and t[j + 2][0] == "id":
                                loc = t[j + 2][1]
                                j += 2
                            pairs.append((loc, src))
                        j += 1
                    j += 1
                    if j < n and t[j] == ("p", "="):
                        mod, _ = self._module_of(j + 1)
                        kind = self._kind(mod) if mod else None
                        for loc, src in pairs:
                            self.budget.tick()
                            self.count[loc] = self.count.get(loc, 0) + 1
                            if kind:
                                self.alias[loc] = kind + "." + src
                    continue
                # const a = ..., b = ...
                while j < n and t[j][0] == "id":
                    self.budget.tick()
                    name = t[j][1]
                    self.count[name] = self.count.get(name, 0) + 1
                    if j + 1 < n and t[j + 1] == ("p", "="):
                        mod, after = self._module_of(j + 2)
                        kind = self._kind(mod) if mod else None
                        end = self._end_of_expr(j + 2)
                        if kind:
                            # require('fs').promises / require('fs').rmSync
                            chain = []
                            q = after
                            while q + 1 < n and t[q] == ("p", ".") and t[q + 1][0] == "id":
                                self.budget.tick()
                                chain.append(t[q + 1][1])
                                q += 2
                            chain = [c for c in chain if c != "promises"]
                            self.alias[name] = kind + ("." + chain[0] if chain else "")
                        else:
                            self.assign[name] = (j + 2, end)
                        j = end
                    else:
                        j += 1
                    if j < n and t[j] == ("p", ","):
                        j += 1
                    else:
                        break
            # reassignment: NAME = ... (not after const/let/var) or NAME += ...
            if k == "id" and i + 1 < n and t[i + 1] in (("p", "="),) and (i == 0 or t[i - 1][1] not in ("const", "let", "var", ".", ",", "{")):
                self.count[v] = self.count.get(v, 0) + 1
            if k == "id" and i + 2 < n and t[i + 1][1] in ("+", "-") and t[i + 2] == ("p", "="):
                self.count[v] = self.count.get(v, 0) + 2

    # callee at token i -> (dotted, index of "(")
    def callee(self, i):
        t = self.t
        mod, j = self._module_of(i)
        if mod:
            base = self._kind(mod)
            if not base:
                return None, i
        elif t[i][0] == "id" and t[i][1] in self.alias:
            base, j = self.alias[t[i][1]], i + 1
        elif t[i][0] == "id" and t[i][1] in ("eval", "Function", "process"):
            base, j = t[i][1], i + 1
        else:
            return None, i
        chain = base.split(".")
        while j < len(t):
            self.budget.tick()
            if t[j] == ("p", ".") and j + 1 < len(t) and t[j + 1][0] == "id":
                chain.append(t[j + 1][1])
                j += 2
            elif t[j] == ("p", "[") and j + 2 < len(t) and t[j + 2] == ("p", "]"):
                chain.append(t[j + 1][1] if t[j + 1][0] == "str" else "<dynamic>")
                j += 3
            else:
                break
        chain = [c for c in chain if c != "promises"]
        if j < len(t) and t[j] == ("p", "("):
            return ".".join(chain), j
        return None, i

    def args(self, lp):
        """Token slices of each top-level argument of the call whose '(' is at lp."""
        out, depth, start, j = [], 0, lp + 1, lp + 1
        while j < len(self.t):
            self.budget.tick()
            v = self.t[j][1]
            if v in ("(", "[", "{"):
                depth += 1
            elif v in (")", "]", "}"):
                if depth == 0:
                    if j > start:
                        out.append((start, j))
                    return out
                depth -= 1
            elif v == "," and depth == 0:
                out.append((start, j))
                start = j + 1
            j += 1
        return out

    def resolve(self, s, e, depth=0):
        self.budget.tick()
        t = self.t[s:e]
        if not t:
            raise Unresolved()
        # a + b + c
        parts, cur, d = [], [], 0
        for k, v in t:
            self.budget.tick()
            if v in ("(", "[", "{"):
                d += 1
            elif v in (")", "]", "}"):
                d -= 1
            if v == "+" and d == 0:
                parts.append(cur)
                cur = []
            else:
                cur.append((k, v))
        parts.append(cur)
        if len(parts) > 1:
            out = ""
            for p in parts:
                self.budget.tick()
                out += self._atom(p, depth)
            return out
        return self._atom(t, depth)

    def _atom(self, t, depth):
        if len(t) == 1 and t[0][0] == "str":
            return t[0][1]
        if len(t) == 1 and t[0][0] == "num":
            return t[0][1]
        if len(t) == 1 and t[0][0] == "id":
            name = t[0][1]
            if depth >= 1 or self.count.get(name, 0) != 1 or name not in self.assign:
                raise Unresolved()
            s, e = self.assign[name]
            return self.resolve(s, e, depth + 1)
        flat = [v for _, v in t]
        if flat[:5] == ["process", ".", "env", ".", "HOME"] and len(flat) == 5:
            return "$HOME"
        if len(t) >= 2 and t[-1] == ("p", ")"):
            # os.homedir() / require('os').homedir() / path.join(...)
            base_i = 0
            sub = JsReader.__new__(JsReader)
            sub.budget = self.budget
            sub.t, sub.alias, sub.assign, sub.count, sub.unresolved_n = t, self.alias, {}, {}, 0
            dotted, lp = sub.callee(base_i)
            if dotted == "os.homedir":
                return "~"
            if dotted in ("path.join", "path.resolve", "path.posix.join"):
                vals = [self._atom_slice(t, a, b, depth) for a, b in sub.args(lp)]
                return PyReader._join(vals)
        if len(t) >= 3 and t[0] == ("p", "[") and t[-1] == ("p", "]"):
            raise Unresolved()
        raise Unresolved()

    def _atom_slice(self, t, a, b, depth):
        saved = self.t
        try:
            self.t = t
            return self.resolve(a, b, depth)
        finally:
            self.t = saved

    def arg(self, sl):
        try:
            return self.resolve(*sl)
        except Unresolved:
            return self.fresh()

    def argv(self, sl):
        s, e = sl
        t = self.t[s:e]
        if t and t[0] == ("p", "[") and t[-1] == ("p", "]"):
            inner = JsReader.__new__(JsReader)
            items, d, st = [], 0, 1
            for j in range(1, len(t) - 1):
                self.budget.tick()
                v = t[j][1]
                if v in ("(", "[", "{"):
                    d += 1
                elif v in (")", "]", "}"):
                    d -= 1
                elif v == "," and d == 0:
                    items.append((s + st, s + j))
                    st = j + 1
            if len(t) - 1 > st:
                items.append((s + st, s + len(t) - 1))
            return [self.arg(x) for x in items]
        return [self.fresh()]

    def has_true(self, sl, key):
        s, e = sl
        flat = [v for _, v in self.t[s:e]]
        for j in range(len(flat) - 2):
            self.budget.tick()
            if flat[j] == key and flat[j + 1] == ":" and flat[j + 2] == "true":
                return True
        return False

    def run(self):
        q = lambda x: '"%s"' % x if x.startswith("$") else shlex.quote(x)
        for i in range(len(self.t)):
            self.budget.tick()
            if i > 0 and self.t[i - 1] == ("p", "."):
                continue
            if i > 0 and self.t[i - 1] == ("id", "new") and self.t[i] == ("id", "Function"):
                pass
            dotted, lp = self.callee(i)
            if not dotted:
                continue
            a = self.args(lp)
            parts = dotted.split(".")
            kind, name = parts[0], parts[-1]
            if kind == "fs":
                rec = len(a) > 1 and self.has_true(a[1], "recursive")
                if name == "<dynamic>":
                    self.twins.append(("sh", 'rm -rf -- "%s"' % self.fresh(), "unresolved fs callee"))
                elif name in ("rmSync", "rm", "rmdirSync", "rmdir", "remove", "removeSync", "emptyDirSync", "emptyDir") and a:
                    t = self.arg(a[0])
                    if name in ("remove", "removeSync", "emptyDirSync", "emptyDir") or rec:
                        self.twins.append(("sh", "rm -rf -- " + q(t), dotted))
                    elif name.startswith("rmdir"):
                        self.twins.append(("sh", "rmdir -- " + q(t), dotted))
                    else:
                        self.twins.append(("sh", "rm -f -- " + q(t), dotted))
                elif name in ("unlinkSync", "unlink") and a:
                    self.twins.append(("sh", "rm -f -- " + q(self.arg(a[0])), dotted))
                elif name in ("truncateSync", "truncate") and a:
                    size = self.arg(a[1]) if len(a) > 1 else "0"
                    self.twins.append(("sh", "truncate -s %s -- %s" % (q(size), q(self.arg(a[0]))), dotted))
            elif kind == "rimraf" and a:
                self.twins.append(("sh", "rm -rf -- " + q(self.arg(a[0])), dotted))
            elif kind == "cp" and a:
                if name in ("exec", "execSync"):
                    v = self.arg(a[0])
                    self.twins.append(("sh", v if not v.startswith("$MURAGE_U") else '"%s"' % v, dotted))
                elif name in ("spawn", "spawnSync", "execFile", "execFileSync", "fork"):
                    prog = self.arg(a[0])
                    rest = self.argv(a[1]) if len(a) > 1 else []
                    shell = any(self.has_true(x, "shell") for x in a[1:])
                    words = [prog] + rest
                    text = " ".join(words) if shell else " ".join(q(x) for x in words)
                    self.twins.append(("sh", text, dotted))
            elif kind in ("eval", "Function") and a:
                try:
                    self.twins.append(("js", self.resolve(*a[-1]), dotted))
                except Unresolved:
                    pass
            elif kind == "vm" and name.startswith("run") and a:
                try:
                    self.twins.append(("js", self.resolve(*a[0]), dotted))
                except Unresolved:
                    pass
        return self


# ------------------------------------------------------------------------------------------------------------------
# the judge

def string_leaves(v, budget=None):
    budget = budget or Budget()
    budget.tick()
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from string_leaves(x, budget)
    elif isinstance(v, list):
        for x in v:
            yield from string_leaves(x, budget)


ROOT_LANG = {"terminal": "sh", "shell": "sh", "execute_code": "py", "python": "py", "node": "js"}


def reader_failure(classes, whys, exc):
    classes.append("cut")  # reader failure: never run
    whys.append("reader cut: " + type(exc).__name__)


def grammar_rejection(exc):
    """CPython also reports parser resource limits as SyntaxError; those must cut."""
    return isinstance(exc, SyntaxError) and not any(marker in str(exc).lower() for marker in (
        "too many nested parentheses", "exceeds the limit", "recursion depth", "memory", "too complex"))


def read_code(text, lng, classes, whys):
    reader_type = PyReader if lng == "py" else JsReader
    r = reader_type.__new__(reader_type)
    try:
        reader_type.__init__(r, text)
        r.run()
        return r.twins, r.literals
    except Exception as exc:
        # A grammar rejection is a normal transition to the lexical reader.
        # All runtime failures (including SyntaxError injected after parsing) cut.
        if not (lng == "py" and grammar_rejection(exc) and not hasattr(r, "tree")):
            reader_failure(classes, whys, exc)
        tw, lits = getattr(r, "twins", []), getattr(r, "literals", [])
        if lng == "py":
            try:
                py_lexical_fallback(text, tw, lits)
            except Exception as fallback_exc:
                reader_failure(classes, whys, fallback_exc)
        return tw, lits


def judge(identity: str, payload, mode: str = "nl") -> Verdict:
    if mode == "nl-cut":
        return Verdict("card", "cut", "hook message truncated (W9)")
    if mode != "nl":
        raise ValueError("judge covers the owner No-limits code reader only (mode nl / nl-cut)")
    classes, whys, twins = [], [], []
    try:
        judge_payload(identity, payload, classes, whys, twins)
    except Exception as exc:
        reader_failure(classes, whys, exc)
    cls = best(classes)
    return Verdict("card" if cls else "run", cls, "; ".join(whys)[:300], twins)


def judge_payload(identity, payload, classes, whys, twins):
    lang = ROOT_LANG.get(identity)
    if lang:
        work = [(lang, payload if isinstance(payload, str) else json.dumps(payload), 0, "root")]
    else:
        value = payload
        if isinstance(payload, str):
            bounded_text(payload)
        if isinstance(payload, str):
            try:
                value = json.loads(payload)
            except ValueError:
                value = payload
        work = []
        # today's commandArgument (shared/app-action-grant.ts:365): the first top-level command|cmd|script|code
        # string (or argv of strings, joined) is read as a shell command; every other string leaf as text
        cmd_key = None
        if isinstance(value, dict):
            for key in ("command", "cmd", "script", "code"):
                raw = value.get(key)
                if isinstance(raw, str) and raw.strip():
                    work.append(("sh", raw, 0, "commandArgument " + key))
                    cmd_key = key
                    break
                if isinstance(raw, list) and raw and all(isinstance(x, str) for x in raw):
                    work.append(("sh", " ".join(raw), 0, "commandArgument " + key))
                    cmd_key = key
                    break
        rest = {k: v for k, v in value.items() if k != cmd_key} if isinstance(value, dict) else value
        work += [("text", s, 0, "leaf") for s in string_leaves(rest)]
    visits = 0
    while work:
        visits += 1
        if visits > MAX_WORK:
            raise ReaderCut("payload work budget exceeded")
        lng, text, depth, how = work.pop(0)
        nested = []
        c, why = "", ""
        try:
            bounded_text(text)
            if lng == "sh":
                c, why = read_sh(text, depth, nested, collected=classes)
                if not c and plain_wipe(text):
                    c, why = "word", "plainWipe"
            elif lng == "text":
                c, why = read_sh(text, depth, [], text_mode=True, collected=classes)
            elif lng in ("py", "js"):
                c = target_free(text)
                why = "S1 " + c if c else ""
                if c:
                    classes.append(c)
                tw, lits = read_code(text, lng, classes, whys)
                # Queue collected twins before reading literals, which may themselves fail.
                for tl, tt, tw_why in tw:
                    twins.append((tl, tt, tw_why))
                    nested.append((tl, tt, depth + 1, "twin " + tw_why))
                for lit in lits:
                    try:
                        bounded_text(lit)
                        lc, lw = read_sh(lit, depth, [], text_mode=True, collected=classes)
                        if lc:
                            classes.append(lc)
                            whys.append("S2 literal: " + lw)
                    except Exception as exc:
                        reader_failure(classes, whys, exc)
        except Exception as exc:
            reader_failure(classes, whys, exc)
        if c:
            classes.append(c)
            whys.append("%s@%d %s: %s" % (lng, depth, how, why))
        for item in nested:
            if item[2] <= MAX_DEPTH:
                work.append(item)


def main(argv):
    if len(argv) >= 3:
        v = judge(argv[1], argv[2], argv[3] if len(argv) > 3 else "nl")
        print(json.dumps(v.__dict__))
        return 0
    print("usage: judge.py IDENTITY PAYLOAD [MODE]")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
