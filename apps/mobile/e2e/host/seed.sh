#!/usr/bin/env bash
# Seeds the ISOLATED E2E host (never the live app) with a realistic small
# org — a handful of bots with distinct roles and two team rooms — so the
# phone app has something real to show instead of one bot and no rooms.
#
# Idempotent: safe to re-run. Skips any bot or room whose name already
# exists, and only sends a sample message into a thread that has none yet.
#
# Reads the host's auth the same way mint.sh reads host.env, and refuses to
# run unless the target is exactly the isolated server (127.0.0.1:28799).
# This script must NEVER reach Sean's live Murage (the live app's ports, the
# same numbers without the leading 2) or its data.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOST="127.0.0.1"
PORT="28799"
BASE="http://$HOST:$PORT"

[[ -f "$HERE/host.env" ]] || { echo "host.env missing: run run-host.sh first" >&2; exit 1; }
source "$HERE/host.env"

# Hard guard, independent of anything host.env says: this script only ever
# talks to the isolated server port. The live app's ports (no leading 2)
# must never be reachable from here.
if [[ "$HOST" != "127.0.0.1" || "$PORT" != "28799" ]]; then
  echo "refusing: target must be 127.0.0.1:28799" >&2
  exit 1
fi

health_body=$(curl -s --max-time 10 "$BASE/api/health" || true)
health_pid=$(printf '%s' "$health_body" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("pid",""))
except Exception: print("")' 2>/dev/null || true)
[[ -n "$health_pid" ]] || { echo "no isolated server answering at $BASE/api/health" >&2; exit 1; }
if [[ -n "${SERVER_PID:-}" && "$health_pid" != "$SERVER_PID" ]]; then
  echo "refusing: /api/health pid ($health_pid) does not match host.env SERVER_PID (${SERVER_PID}) — this is not our isolated host" >&2
  exit 1
fi

# The desktop-app handshake (server/index.ts, /api/desktop-secret): offered
# only because run-host.sh started this server with
# MURAGE_ALLOW_DEV_DESKTOP_SECRET=1. Never logged, never written to disk.
SECRET=$(curl -s --max-time 10 -H 'x-murage-surface: desktop' "$BASE/api/desktop-secret" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("secret",""))
except Exception: print("")')
[[ -n "$SECRET" ]] || { echo "could not obtain the desktop secret from $BASE/api/desktop-secret" >&2; exit 1; }

MURAGE_SEED_BASE="$BASE" MURAGE_SEED_SECRET="$SECRET" python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ["MURAGE_SEED_BASE"]
SECRET = os.environ["MURAGE_SEED_SECRET"]
HEADERS = {
    "x-murage-surface": "desktop",
    "x-murage-surface-secret": SECRET,
    "Content-Type": "application/json",
}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else {})
        except ValueError:
            return e.code, {}


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


status, state = call("GET", "/api/bots")
if status != 200:
    fail(f"failed to read current state: HTTP {status} {state.get('error')}")

bots_by_name = {b["name"]: b for b in state["bots"]}
groups_by_name = {g.get("name"): g for g in state["groups"] if g.get("name")}

DESIRED_BOTS = [
    {
        "name": "Scout",
        "title": "Researcher",
        "description": "Digs up sources, checks facts, and briefs the team before anyone writes a word.",
    },
    {
        "name": "Quill",
        "title": "Writer",
        "description": "Drafts copy, blog posts, and release notes in the team's voice.",
    },
    {
        "name": "Iris",
        "title": "Designer",
        "description": "Turns rough ideas into clean layouts, mockups, and visual polish.",
    },
    {
        "name": "Cole",
        "title": "Developer",
        "description": "Ships code, reviews pull requests, and keeps the build green.",
    },
    {
        "name": "Piper",
        "title": "Sales & Ops",
        "description": "Runs outreach, tracks the pipeline, and keeps the trains running on time.",
    },
]

for spec in DESIRED_BOTS:
    if spec["name"] in bots_by_name:
        print(f"bot exists, skipping: {spec['name']}")
        continue
    status, res = call(
        "POST",
        "/api/bots",
        {"name": spec["name"], "title": spec["title"], "description": spec["description"]},
    )
    if status != 201:
        fail(f"failed to create bot {spec['name']}: HTTP {status} {res.get('error')}")
    bots_by_name[spec["name"]] = res["bot"]
    print(f"created bot: {spec['name']} ({spec['title']})")

DESIRED_GROUPS = [
    {
        "name": "Content Team",
        "members": ["Quill", "Iris", "Scout"],
        "bulletin": "Content Team: research, writing, and design working together on what ships next.",
    },
    {
        "name": "Product Team",
        "members": ["Cole", "Piper", "Ember"],
        "bulletin": "Product Team: engineering, sales/ops, and the chief of staff keeping the roadmap moving.",
    },
]

for spec in DESIRED_GROUPS:
    if spec["name"] in groups_by_name:
        print(f"room exists, skipping: {spec['name']}")
        continue
    member_ids = []
    missing = []
    for name in spec["members"]:
        bot = bots_by_name.get(name)
        (member_ids.append(bot["id"]) if bot else missing.append(name))
    if missing:
        fail(f"cannot create room {spec['name']}: missing bot(s) {missing}")
    # completed setup (bulletin + defaultResponder), the same shape the
    # desktop UI's room-setup wizard submits, so the room is immediately
    # usable rather than stuck behind "finish room setup" on the first send.
    body = {
        "name": spec["name"],
        "memberIds": member_ids,
        "setup": {"bulletin": spec["bulletin"], "defaultResponder": {"kind": "everyone"}},
    }
    status, res = call("POST", "/api/groups", body)
    if status != 201:
        fail(f"failed to create room {spec['name']}: HTTP {status} {res.get('error')}")
    groups_by_name[spec["name"]] = res["group"]
    print(f"created room: {spec['name']} ({', '.join(spec['members'])})")

# Belt-and-suspenders for a room that already existed but was left with its
# setup incomplete (e.g. an earlier partial run): finish it the same way the
# desktop UI's room-setup wizard does, so it is not stuck refusing every
# message with "finish room setup before sending the first message".
for spec in DESIRED_GROUPS:
    group = groups_by_name.get(spec["name"])
    if not group:
        continue
    if group.get("setupCompletedAt") is None and group.get("setupSkippedAt") is None:
        status, res = call(
            "PATCH",
            f"/api/groups/{group['id']}/setup",
            {
                "action": "complete",
                "bulletin": spec["bulletin"],
                "defaultResponder": {"kind": "everyone"},
                "cwd": None,
            },
        )
        if status != 200:
            print(f"note: could not finish setup for {spec['name']}: HTTP {status} {res.get('error')}", file=sys.stderr)
        else:
            groups_by_name[spec["name"]] = res["group"]
            print(f"finished setup for room: {spec['name']}")

# A couple of short sample threads, only into a thread that has no messages
# yet — easy through the API, and the fake engine answers with canned text.
status, state = call("GET", "/api/bots")
if status != 200:
    fail(f"failed to re-read state before seeding messages: HTTP {status} {state.get('error')}")
bots_by_name = {b["name"]: b for b in state["bots"]}
groups_by_name = {g.get("name"): g for g in state["groups"] if g.get("name")}

SAMPLE_MESSAGES = [
    ("bot", "Scout", "Pull together three recent sources on our onboarding flow and brief the team."),
    ("group", "Content Team", "Let's line up next week's content calendar."),
]

for kind, name, text in SAMPLE_MESSAGES:
    table = bots_by_name if kind == "bot" else groups_by_name
    obj = table.get(name)
    if not obj:
        continue
    if obj.get("messages"):
        print(f"thread already has messages, skipping sample: {name}")
        continue
    path = f"/api/bots/{obj['id']}/messages" if kind == "bot" else f"/api/groups/{obj['id']}/messages"
    status, res = call("POST", path, {"text": text})
    if status != 202:
        print(f"note: sample message to {name} did not send: HTTP {status} {res.get('error')}", file=sys.stderr)
        continue
    print(f"sent sample message to {name}")

print("seed complete")
PY
