#!/usr/bin/env python3
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reference Hermes 0.22.2 correlation state machine (tool identity r1.2). Pure stdlib; reads frames as data.

    ask -> answer (Murage sends) -> one-shot token -> permission completion -> execution start -> updates -> end

run_trace(trace) -> Outcome. The production tripwire (server/drivers/acp/tool-tripwire.ts) must give the same
Outcome (result, trip_at, sent, overlay, performed) for every trace in hermes_traces.jsonl.

Frames: {"dir": "out"|"in"|"ctl", "msg": {...}}. "out" is engine -> Murage (stdout), "in" is Murage -> engine
(stdin; Murage's own answers and requests). "ctl" is a Murage-internal event: {"reload": {...}}.

Normative rules (each cites the real frames it was built from):
  R-ASK      a session/request_permission is one of: hook ask, native edit ask, native dangerous-command ask, or
             unproven. Only these shapes are proven (S0 frames.jsonl:9, 38, 83; S0b frames.jsonl:39, 42).
  R-SEND     Murage's answer is what the state machine acts on. An allow on an unproven/unbound ask is SENT as
             reject (runtime.error). A reloaded card whose identity frame differs from the driver-held ask frame
             is answered reject.
  R-TOKEN    an allow sent on a proven hook ask records one token {key, input, parent}. parent = the open
             execute_code execution at that moment, if any (S0b G3: nested calls from execute_code).
  R-PCOMP    a tool_call_update whose toolCallId is a known ask id is a permission completion (S0 frames.jsonl:11):
             legal only after the answer was sent, once, with only {sessionUpdate, toolCallId, status} and status
             completed|failed. It never creates, consumes or binds a token.
  R-START    a tool_call is an execution start. Its identity is the title prefix + the pinned kind (version
             pinned). Then: C1 standing class | C2 edit obligation | C3 own-unasked | C4 host computer | hook-asked:
             consume the OLDEST unconsumed, unexpired token with the same key whose echo check passes; else TRIP.
  R-ECHO     terminal: start text == "$ " + input.command. execute_code: the Hermes template over code points.
             Unpolished names (mcp__*, unknown): rawInput present -> canonical(rawInput) == canonical(input);
             rawInput absent -> input must be {} (Hermes omits rawInput for empty arguments, tools.py:806-807).
             Other polished names: key only.
  R-UPD      a tool_call_update for an execution must carry its frozen kind/title if any; once terminal, nothing
             more. An update for an id that is neither an ask nor a started execution -> TRIP.
  R-EDIT     write_file/patch start: a diff block -> TRIP; else an obligation {path}. A native edit ask binds the
             oldest open obligation with the same key and path (V4A: mode patch, path null). completed with the
             obligation unsatisfied -> TRIP; failed -> no trip.
  R-CMD      a native dangerous-command ask binds exactly one of: an open terminal execution whose echo is
             "$ " + command; else (S0b G3) exactly one unconsumed, unexpired NESTED terminal token whose
             input.command == command. Zero or several -> unproven -> reject.
  R-NEST     a token whose parent execute_code closes expires unconsumed (it can never authorize a later start).
  R-MODE     at session/prompt the session mode must be "default" (S0 E4), else REFUSE.
  R-D5       base config administrator pre_tool_call hooks: policy "drop" -> overlay ["murage"] (default);
             policy "refuse" -> REFUSE the turn before session/prompt (the safe fallback).
"""
from __future__ import annotations

import json
import re
import sys

VERSION_PIN = "0.22.2"
# TOOL_KIND_MAP of hermes acp_adapter/tools.py:18-31 at d923a5eb (0.22.2); default "other"
PINNED_KIND = {}
for _kind, _names in {
    "read": ("read_file", "skill_view", "skills_list", "browser_snapshot", "browser_vision", "browser_get_images", "vision_analyze"),
    "edit": ("write_file", "patch", "skill_manage"),
    "search": ("search_files",),
    "execute": ("terminal", "process", "execute_code", "browser_click", "browser_type", "browser_scroll",
                "browser_press", "browser_back", "delegate_task", "image_generate", "text_to_speech"),
    "fetch": ("web_search", "web_extract", "browser_navigate"),
    "other": ("todo",),
    "think": ("_thinking",),
}.items():
    for _n in _names:
        PINNED_KIND[_n] = _kind
# _POLISHED_TOOLS (tools.py:36-52)
POLISHED = set("""todo memory session_search delegate_task read_file write_file patch search_files terminal process
 execute_code skill_view skills_list skill_manage web_search web_extract browser_navigate browser_click browser_type
 browser_press browser_scroll browser_back browser_snapshot browser_console browser_get_images browser_vision
 vision_analyze image_generate text_to_speech cronjob send_message clarify discord discord_admin feishu_doc_read
 feishu_drive_list_comments feishu_drive_list_comment_replies feishu_drive_reply_comment feishu_drive_add_comment
 kanban_create kanban_show kanban_comment kanban_complete kanban_block kanban_request_review kanban_request_changes
 kanban_link kanban_heartbeat yb_query_group_info yb_query_group_members yb_search_sticker yb_send_dm
 yb_send_sticker""".split())
# r1.2 C1 (S0b G2, fallback B): only free tools whose pinned kind is NOT the default "other"
C1_DEFAULT = ["read_file", "search_files", "skills_list", "skill_view", "vision_analyze", "web_search", "web_extract"]
C2 = {"write_file", "patch"}
ALLOW = {"allow_once", "allow_session", "allow_always"}
PLACEHOLDER = re.compile(r"^<([A-Za-z0-9_-]+)> \(plugin approval rule\)$")
TITLE = re.compile(r"^([A-Za-z0-9_-]+)(?:: |$)")


def canonical(v):
    """Sorted keys at every depth, arrays in order, strings exact (no normalisation)."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def execute_code_echo(code: str) -> str:
    # tools.py:731-734; Python slices code points
    preview = code[:1200] + ("\n... (%d chars total, truncated)" % len(code) if len(code) > 1200 else "")
    return "Running Python helper script:\n\n```python\n%s\n```" % preview if preview else "Running Python helper script"


def start_text(u):
    c = u.get("content")
    if isinstance(c, list) and c and isinstance(c[0], dict) and c[0].get("type") == "content":
        inner = c[0].get("content")
        if isinstance(inner, dict) and inner.get("type") == "text":
            return inner.get("text")
    return None


def has_diff(u):
    c = u.get("content")
    return isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "diff" for x in c)


class Trip(Exception):
    def __init__(self, at, why):
        super().__init__(why)
        self.at, self.why = at, why


class Fsm:
    def __init__(self, ctx):
        self.ctx = ctx
        self.c1 = set(ctx.get("c1", C1_DEFAULT))
        self.c3 = set(ctx.get("c3", []))
        self.version = None
        self.mode = None
        self.asks = {}        # jsonrpc id -> ask
        self.ask_by_tc = {}   # toolCallId -> ask
        self.tokens = []
        self.execs = {}
        self.obligations = []
        self.sent = {}
        self.errors = []
        self.performed = []
        self.overlay = None
        self.pending_reload = {}

    # -- identity ------------------------------------------------------------------------------------------------------
    def pinned(self):
        return self.version == VERSION_PIN

    def classify_ask(self, tc):
        ri = tc.get("rawInput")
        tcid = tc.get("toolCallId")
        if not self.pinned() or not isinstance(ri, dict):
            return {"type": "unproven"}
        keys = set(ri)
        if keys == {"command", "description"}:
            m = PLACEHOLDER.match(ri["command"]) if isinstance(ri["command"], str) else None
            if m:
                try:
                    msg = json.loads(ri["description"])
                except (TypeError, ValueError):
                    return {"type": "unproven"}
                if (isinstance(msg, dict) and msg.get("murage") == 1 and msg.get("v") == 1 and msg.get("tool") == m.group(1)
                        and msg.get("truncated") is False and isinstance(msg.get("input"), dict)):
                    return {"type": "hook", "key": "hermes/hermes/" + m.group(1), "name": m.group(1), "input": msg["input"]}
                return {"type": "unproven"}
            if tc.get("kind") == "execute" and isinstance(ri["command"], str) and isinstance(ri["description"], str):
                return {"type": "cmd", "key": "hermes/hermes/terminal", "command": ri["command"]}
            return {"type": "unproven"}
        if (keys == {"tool", "arguments"} and tc.get("kind") == "edit" and isinstance(tcid, str)
                and re.match(r"^edit-approval-\d+$", tcid) and ri["tool"] in C2 and isinstance(ri["arguments"], dict)):
            return {"type": "edit", "key": "hermes/hermes/" + ri["tool"], "name": ri["tool"], "arguments": ri["arguments"]}
        return {"type": "unproven"}

    def start_identity(self, u):
        title, kind = u.get("title"), u.get("kind")
        if not self.pinned() or not isinstance(title, str):
            return None
        m = TITLE.match(title)
        if not m or m.group(1) == "tool":
            return None
        name = m.group(1)
        if kind != PINNED_KIND.get(name, "other"):
            return None
        return name

    # -- echo ------------------------------------------------------------------------------------------------------------
    def echo_ok(self, name, token_input, u):
        if name == "terminal":
            cmd = token_input.get("command")
            return isinstance(cmd, str) and start_text(u) == "$ " + cmd
        if name == "execute_code":
            code = token_input.get("code")
            return isinstance(code, str) and start_text(u) == execute_code_echo(code)
        if name not in POLISHED:
            if "rawInput" in u:
                return canonical(u["rawInput"]) == canonical(token_input)
            return token_input == {}
        return True

    # -- frames ----------------------------------------------------------------------------------------------------------
    def open_execute_code(self):
        opened = [e for e in self.execs.values() if e["name"] == "execute_code" and e["status"] is None]
        return opened[-1]["tcid"] if opened else None

    def on_ask(self, i, msg):
        tc = msg["params"]["toolCall"]
        a = self.classify_ask(tc)
        a.update({"id": msg.get("id"), "tcid": tc.get("toolCallId"), "frame": canonical(tc), "sent": None, "closed": False, "at": i})
        if a["tcid"] in self.ask_by_tc or a["tcid"] in self.execs:
            raise Trip(i, "ask toolCallId reused")
        if a["type"] == "edit":
            args = a["arguments"]
            cands = [o for o in self.obligations if o["key"] == a["key"] and not o["satisfied"] and o["open"]
                     and (o["path"] == args.get("path") if args.get("mode") != "patch" else o["path"] is None)]
            if cands:
                a["obligation"] = cands[0]
            else:
                a["type"] = "unproven"
        elif a["type"] == "cmd":
            execs = [e for e in self.execs.values() if e["name"] == "terminal" and e["status"] is None and e["echo"] == "$ " + a["command"]]
            nested = [t for t in self.tokens if not t["consumed"] and not t["expired"] and t["parent"] and t["key"] == "hermes/hermes/terminal"
                      and t["input"].get("command") == a["command"]]
            if len(execs) == 1:
                a["bind"] = ("exec", execs[0])
            elif not execs and len(nested) == 1:
                a["bind"] = ("nested", nested[0])
            else:
                a["type"] = "unproven"
        self.asks[a["id"]] = a
        self.ask_by_tc[a["tcid"]] = a

    def on_answer(self, i, msg):
        a = self.asks.get(msg.get("id"))
        if a is None or a["sent"] is not None:
            return
        opt = (((msg.get("result") or {}).get("outcome") or {}).get("optionId"))
        allow = opt in ALLOW
        reload = self.pending_reload.get(a["tcid"])
        if allow and (a["type"] == "unproven" or (reload is not None and reload != a["frame"])):
            self.errors.append("runtime.error: allow on %s ask %s sent as reject" % (a["type"] if reload is None else "reloaded", a["tcid"]))
            allow = False
        a["sent"] = "allow" if allow else "reject"
        self.sent[a["tcid"]] = a["sent"]
        if not allow:
            return
        if a["type"] == "hook":
            self.tokens.append({"key": a["key"], "name": a["name"], "input": a["input"], "consumed": False, "expired": False,
                                "parent": self.open_execute_code(), "ask": a["tcid"]})
        elif a["type"] == "edit":
            a["obligation"]["satisfied"] = True
            a["obligation"]["ask"] = a["tcid"]
        elif a["type"] == "cmd":
            kind, target = a["bind"]
            if kind == "nested":
                target["consumed"] = True
                self.performed.append([target["key"], "nested:" + target["parent"], "in-parent"])

    def on_start(self, i, u):
        tcid = u.get("toolCallId")
        if tcid in self.execs or tcid in self.ask_by_tc:
            raise Trip(i, "start reuses an id")
        name = self.start_identity(u)
        if name is None:
            raise Trip(i, "start identity unproven")
        key = "hermes/hermes/" + name
        e = {"tcid": tcid, "name": name, "key": key, "kind": u.get("kind"), "status": None, "echo": start_text(u), "auth": None, "obligation": None}
        if name in self.c1:
            e["auth"] = "C1"
        elif name in C2:
            if has_diff(u):
                raise Trip(i, "edit start carries a diff: Hermes approved it itself")
            locs = u.get("locations") or []
            path = locs[0].get("path") if locs and isinstance(locs[0], dict) else None
            ob = {"key": key, "path": path, "satisfied": False, "open": True, "tcid": tcid}
            self.obligations.append(ob)
            e["obligation"], e["auth"] = ob, "C2"
        elif name in self.c3:
            e["auth"] = "C3"
        elif self.ctx.get("host_computer") and re.match(r"^mcp__computer__[A-Za-z0-9_]+$", name) and self.ctx.get("computer_servers", 1) == 1:
            e["auth"] = "C4"
        else:
            for t in self.tokens:
                if not t["consumed"] and not t["expired"] and t["key"] == key and self.echo_ok(name, t["input"], u):
                    t["consumed"] = True
                    e["auth"] = "token:" + t["ask"]
                    break
            if e["auth"] is None:
                raise Trip(i, "no token for " + key)
        self.execs[tcid] = e

    def on_update(self, i, u):
        tcid = u.get("toolCallId")
        if tcid in self.ask_by_tc:
            a = self.ask_by_tc[tcid]
            if a["sent"] is None or a["closed"] or set(u) - {"sessionUpdate", "toolCallId", "status"} or u.get("status") not in ("completed", "failed"):
                raise Trip(i, "bad permission completion")
            a["closed"] = True
            return
        e = self.execs.get(tcid)
        if e is None:
            raise Trip(i, "update for an unknown execution")
        if e["status"] is not None:
            raise Trip(i, "update after the execution ended")
        if "kind" in u and u["kind"] != e["kind"]:
            raise Trip(i, "frozen kind changed")
        if "title" in u:
            m = TITLE.match(u["title"]) if isinstance(u["title"], str) else None
            if not m or m.group(1) != e["name"]:
                raise Trip(i, "frozen title changed")
        st = u.get("status")
        if st in ("completed", "failed"):
            if e["obligation"] is not None:
                e["obligation"]["open"] = False
                if st == "completed" and not e["obligation"]["satisfied"]:
                    raise Trip(i, "edit completed without a bound edit allow")
            e["status"] = st
            self.performed.append([e["key"], e["auth"], st])
            if e["name"] == "execute_code":
                for t in self.tokens:
                    if t["parent"] == tcid and not t["consumed"]:
                        t["expired"] = True

    def on_prompt(self, i):
        hooks = self.ctx.get("admin_pre_tool_call", [])
        policy = self.ctx.get("d5_policy", "drop")
        if hooks and policy == "refuse":
            return "refuse"
        self.overlay = ["murage"]
        if self.mode != "default":
            return "refuse"
        return None


def run_trace(trace):
    f = Fsm(trace.get("ctx", {}))
    out = {"result": "accept", "trip_at": None, "why": "", "sent": f.sent, "overlay": None, "performed": f.performed, "errors": f.errors}
    try:
        for i, fr in enumerate(trace["frames"]):
            d, m = fr["dir"], fr["msg"]
            if d == "ctl":
                if "reload" in m:
                    f.pending_reload[m["reload"]["toolCallId"]] = canonical(m["reload"]["identityFrame"])
                continue
            if d == "in":
                meth = m.get("method")
                if meth == "session/prompt":
                    r = f.on_prompt(i)
                    out["overlay"] = f.overlay
                    if r:
                        out.update(result=r, trip_at=i, why="turn refused before prompt")
                        return out
                elif meth == "session/set_mode":
                    f.mode = m["params"]["modeId"]
                elif "result" in m and "id" in m:
                    f.on_answer(i, m)
                continue
            if "result" in m and isinstance(m["result"], dict):
                r = m["result"]
                if "agentInfo" in r:
                    f.version = r["agentInfo"].get("version")
                if "modes" in r:
                    f.mode = r["modes"].get("currentModeId")
                continue
            meth = m.get("method")
            if meth == "session/request_permission":
                f.on_ask(i, m)
            elif meth == "session/update":
                u = m["params"]["update"]
                su = u.get("sessionUpdate")
                if su == "tool_call":
                    f.on_start(i, u)
                elif su == "tool_call_update":
                    f.on_update(i, u)
    except Trip as t:
        out.update(result="trip", trip_at=t.at, why=t.why)
    out["overlay"] = f.overlay
    out["unperformed"] = unperformed(f)
    return out


def unperformed(f):
    """Allowed asks whose permitted action never happened (must be empty on every must-accept trace)."""
    left = []
    for a in f.asks.values():
        if a["sent"] != "allow":
            continue
        if a["type"] == "hook":
            tok = [t for t in f.tokens if t["ask"] == a["tcid"]]
            used = tok and tok[0]["consumed"] and (
                any(p[1] == "token:" + a["tcid"] for p in f.performed) or
                (tok[0]["parent"] and any(p[1] == "nested:" + tok[0]["parent"] for p in f.performed)))
            if not used:
                left.append(a["tcid"])
        elif a["type"] == "edit":
            e = f.execs.get(a["obligation"]["tcid"])
            if not e or e["status"] is None:
                left.append(a["tcid"])
        elif a["type"] == "cmd":
            kind, target = a["bind"]
            if kind == "exec" and target["status"] is None:
                left.append(a["tcid"])
    return left


# ---------------------------------------------------------------------------------------------------------------------
# Codex (S0b G4): identity parity of a hook delivery and the item with the same call id. Codex has no tripwire.

def codex_hook_key(h, mounts):
    name = h.get("tool_name")
    if name == "Bash":
        return "codex/codex/shell"
    m = re.match(r"^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$", name or "")
    if m and m.group(1) in mounts:
        return "codex/mcp:%s/%s" % (m.group(1), m.group(2))
    return None


def codex_item_key(item, hook):
    t = item.get("type")
    if t == "commandExecution":
        return "codex/codex/shell"
    if t == "fileChange":
        # S0b G4: a shell apply_patch is delivered to the hook as Bash and emits fileChange with the same id
        cmd = ((hook or {}).get("tool_input") or {}).get("command")
        if hook and hook.get("tool_name") == "Bash" and isinstance(cmd, str) and re.match(r"^apply_patch(\s|$)", cmd):
            return "codex/codex/shell"
        return "codex/codex/edit"
    if t == "mcpToolCall":
        return "codex/mcp:%s/%s" % (item.get("server"), item.get("tool"))
    if t == "webSearch":
        return "codex/codex/web_search"
    return None


def run_codex(trace):
    mounts = set(trace.get("ctx", {}).get("mounts", []))
    hooks = {h["tool_use_id"]: h for h in trace["hooks"]}
    bad = []
    for item in trace["items"]:
        h = hooks.get(item["id"])
        hk = codex_hook_key(h, mounts) if h else None
        ik = codex_item_key(item, h)
        if hk is None or ik is None or hk != ik:
            bad.append(item["id"])
    return {"result": "reject" if bad else "accept", "bad": bad}


if __name__ == "__main__":
    for line in open(sys.argv[1]):
        t = json.loads(line)
        print(t["id"], json.dumps(run_codex(t) if t.get("engine") == "codex" else run_trace(t))[:300])
