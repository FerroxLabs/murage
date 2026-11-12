#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Signal 48a0a5e capture sanitizer. Unknown schemas fail closed; no raw diagnostics.

scrub.py raw.jsonl staged.json
scrub.py --bundle raw-directory NEW-staging-directory
scrub.py --review staging-directory review.json
The review file must enumerate every staged artifact and its exact SHA-256.
This tool never publishes, copies raw files, or declares a capture reviewed.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit, parse_qs

COMMIT = "48a0a5e90cb0c36153f0276c0affff090e588290"
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
PHONE = re.compile(r"\+[0-9]{6,15}\Z")
FILES = set("version listAccounts-one listAccounts-two startLink finishLink subscribeReceive own-note edit remote-delete expiry owner-to-friend desktop-note own-echo send send-timestamp other-sender-sync pni-sync other-account-text other-account-attachment phone-unlink rate-limit unlink group history malformed-identity long-text timer".split())

class Rejected(ValueError):
    pass

def require(ok):
    if not ok:
        raise Rejected("Capture requires schema review")

def obj(value, fields, required=()):
    require(type(value) is dict and set(value) <= fields.keys() and set(required) <= value.keys())
    return {k: fields[k](v) for k, v in value.items()}

def string(v):
    require(type(v) is str and len(v) <= 2_000_000)
    return v

def integer(v):
    require(type(v) is int and 0 <= v <= 9007199254740991)
    return v

def boolean(v):
    require(type(v) is bool)
    return v

def nullable(fn):
    return lambda v: None if v is None else fn(v)

def array(fn):
    def apply(v):
        require(type(v) is list and len(v) <= 10000)
        return [fn(x) for x in v]
    return apply

def enum(*values):
    def apply(v):
        require(type(v) is str and v in values)
        return v
    return apply

def text(v):
    v = string(v)
    # Retain the admission length boundary, never the original text.
    return "x" * len(v) if len(v) > 2000 else ("sanitized text" if v else "")

class Scrubber:
    def __init__(self):
        self.maps = {}
        self.times = []
        self.base = None

    def token(self, kind, value):
        table = self.maps.setdefault(kind, {})
        return table.setdefault(value, len(table) + 1)

    def identity(self, v, kind="ACI"):
        v = string(v)
        if v.upper().startswith("PNI:"):
            return "PNI:" + self.identity(v[4:], "PNI")
        if v.upper().startswith("ACI:"):
            return "ACI:" + self.identity(v[4:], "ACI")
        if PHONE.fullmatch(v):
            return "+1555%07d" % self.token("phone", v)
        if not UUID.fullmatch(v):
            return "invalid-identity"  # Keep malformed identity rejection observable.
        n = self.token("identity", (kind, v.lower()))
        # Valid v4 UUID; distinct ACI/PNI even for identical raw UUID bytes.
        return "00000000-0000-4000-8000-%012x" % n

    def number(self, v):
        require(PHONE.fullmatch(string(v)) is not None)
        return self.identity(v)

    def time(self, v):
        integer(v)
        if not v:
            return 0
        self.times.append(v)
        return v if self.base is None else 1800000000000 + v - self.base

    def opaque(self, v):
        string(v)
        return "fixture-%d" % self.token("opaque", v)

    def link(self, v):
        uri = urlsplit(string(v))
        query = parse_qs(uri.query, strict_parsing=True)
        require(uri.scheme == "sgnl" and uri.netloc == "linkdevice" and not uri.path and not uri.fragment
                and set(query) == {"uuid", "pub_key"} and all(len(x) == 1 and bool(x[0]) for x in query.values()))
        n = self.token("link", v)
        return "sgnl://linkdevice?uuid=00000000-0000-4000-8000-%012x&pub_key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%%3D" % n

    def attachment(self, v):
        return obj(v, {"contentType": enum("image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "audio/aac", "audio/ogg", "application/octet-stream", "application/pdf", "text/x-signal-plain", "text/plain"),
            "filename": nullable(lambda x: (string(x), "fixture.bin")[1]), "id": nullable(self.opaque),
            "size": nullable(integer), "width": nullable(integer), "height": nullable(integer),
            "caption": nullable(text), "uploadTimestamp": nullable(self.time), "isVoiceNote": boolean},
            ("contentType",))

    def data(self, v, sent=False):
        fields = {"timestamp": self.time, "message": nullable(text), "expiresInSeconds": nullable(integer),
            **{k: boolean for k in ("isExpirationUpdate", "viewOnce", "isEndSession", "isProfileKeyUpdate", "hasProfileKey")},
            "attachments": array(self.attachment), "remoteDelete": lambda x: obj(x, {"targetTimestamp": self.time, "timestamp": self.time}, ("targetTimestamp",)),
            "groupInfo": lambda x: obj(x, {"groupId": self.opaque, "type": enum("DELIVER", "UPDATE", "QUIT", "REQUEST_INFO"), "name": text}),
        }
        if sent:
            fields.update({"destination": nullable(self.identity), "destinationNumber": nullable(self.number),
                "destinationUuid": nullable(self.identity), "editMessage": self.edit})
        return obj(v, fields)

    def edit(self, v):
        return obj(v, {"targetSentTimestamp": self.time, "dataMessage": self.data}, ("targetSentTimestamp", "dataMessage"))

    def received(self, v):
        if type(v) is dict and "subscription" in v:
            return obj(v, {"subscription": integer, "result": self.received}, ("subscription", "result"))
        return obj(v, {"account": self.identity, "envelope": lambda e: obj(e, {
            "source": nullable(self.identity), "sourceNumber": nullable(self.number), "sourceUuid": self.identity,
            "sourceName": nullable(lambda x: (string(x), "Fixture")[1]), "sourceDevice": integer,
            **{k: self.time for k in ("timestamp", "serverReceivedTimestamp", "serverDeliveredTimestamp")},
            "dataMessage": self.data, "editMessage": self.edit,
            "syncMessage": lambda x: obj(x, {"sentMessage": lambda y: self.data(y, True)}),
        }, ("sourceUuid", "sourceDevice", "timestamp"))}, ("account", "envelope"))

    def result(self, v):
        if type(v) is int:
            return integer(v)  # subscription id
        if type(v) is list:
            return array(lambda x: obj(x, {"number": self.number, "aci": self.identity}, ("number", "aci")))(v)
        require(type(v) is dict)
        if "version" in v:
            return obj(v, {"version": enum("0.14.11-SNAPSHOT")}, ("version",))
        if "deviceLinkUri" in v:
            return obj(v, {"deviceLinkUri": self.link}, ("deviceLinkUri",))
        if "aci" in v:
            return obj(v, {"number": self.number, "aci": self.identity}, ("number", "aci"))
        return obj(v, {"timestamp": self.time, "results": array(lambda x: obj(x, {
            "recipientAddress": lambda y: obj(y, {"uuid": self.identity, "number": nullable(self.number)}, ("uuid", "number")),
            "type": enum("SUCCESS", "RATE_LIMIT_FAILURE", "NETWORK_FAILURE", "IDENTITY_FAILURE", "UNREGISTERED_FAILURE"),
            "retryAfterSeconds": integer}, ("recipientAddress", "type")))})

    def frame(self, v):
        require(type(v) is dict and v.get("jsonrpc") == "2.0")
        common = {"jsonrpc": enum("2.0"), "id": nullable(lambda x: self.token("rpc-id", (type(x).__name__, string(x) if type(x) is str else integer(x))))}
        if "method" in v:
            require(v["method"] == "receive")
            return obj(v, {**common, "method": enum("receive"), "params": self.received}, ("method", "params"))
        require(("result" in v) != ("error" in v) and "id" in v)
        def code(x):
            require(type(x) is int and -32768 <= x <= -1)
            return x
        return obj(v, {**common, "result": self.result, "error": lambda x: obj(x, {
            "code": code, "message": text, "data": lambda y: obj(y, {"response": self.result}, ("response",))}, ("code", "message"))})

    def frames(self, groups):
        # One session for ALL files. First pass validates every value/key before
        # creating output; second pass rebases time with one common origin.
        for frames in groups:
            for f in frames:
                self.frame(f)
        self.base = min(self.times, default=1800000000000)
        return [[self.frame(f) for f in frames] for frames in groups]

def read_frames(path):
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 16 * 1024 * 1024)
    raw = path.read_text()
    if path.suffix == ".jsonl":
        return [json.loads(line) for line in raw.splitlines() if line.strip()]
    value = json.loads(raw)
    return value if type(value) is list else [value]

def encoded(value):
    return json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + "\n"

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def review(root, review_path):
    # Review attestation is an independently written input, never auto-generated.
    require(root.is_dir() and not root.is_symlink())
    r = json.loads(review_path.read_text())
    require(type(r) is dict and set(r) == {"reviewer", "signalCliCommit", "artifacts"})
    require(type(r["reviewer"]) is str and bool(r["reviewer"].strip()) and r["signalCliCommit"] == COMMIT)
    files = sorted(root.iterdir())
    require(all(f.is_file() and not f.is_symlink() for f in files))
    require(r["artifacts"] == {f.name: digest(f) for f in files})
    print("Every staged artifact has an exact review digest; publication remains a separate step.")

def main(args):
    require(len(args) in (2, 3))
    if len(args) == 3 and args[0] == "--review":
        review(Path(args[1]), Path(args[2])); return
    if len(args) == 3:
        require(args[0] == "--bundle")
        source, target = map(Path, args[1:])
        require(source.is_dir() and not source.is_symlink() and not target.exists())
        paths = sorted(source.iterdir())
        require(bool(paths) and all(p.stem in FILES and p.suffix in (".json", ".jsonl") for p in paths))
        require(len({p.stem for p in paths}) == len(paths))
        groups = Scrubber().frames([read_frames(p) for p in paths])
        # Exactly one raw frame per production fixture; multi-frame files must be
        # split by the capture owner, never silently selecting a convenient frame.
        require(all(len(g) == 1 for g in groups))
        with tempfile.TemporaryDirectory(prefix="signal-scrub-", dir=target.parent) as temporary:
            staging = Path(temporary) / "staged"; staging.mkdir(mode=0o700)
            for path, frames in zip(paths, groups):
                (staging / (path.stem + ".json")).write_text(encoded(frames[0]))
            inventory = {p.name: digest(p) for p in sorted(staging.iterdir())}
            (staging / "SANITIZATION.json").write_text(encoded({"signalCliCommit": COMMIT, "artifacts": inventory, "reviewRequired": True}))
            os.rename(staging, target)
    else:
        source, target = map(Path, args)
        require(not target.exists() and not target.is_symlink())
        frames = Scrubber().frames([read_frames(source)])[0]
        # All validation succeeds before any output is opened.
        with target.open("x") as out:
            out.write(encoded(frames))
    print("Sanitized staging output created; every artifact requires review before publication.")

if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        print("Sanitization/review refused; no raw diagnostics emitted.", file=sys.stderr)
        sys.exit(1)
