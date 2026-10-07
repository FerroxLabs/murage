#!/usr/bin/env python3
"""The iOS counterpart of cdp.mjs: Web Inspector on the simulator.

usage: wir.py <udid> <page-url-prefix> <script.js> [json-args]
       wir.py <udid> <page-url-prefix> --url
       wir.py <udid> --list

Runs the script's body as `async (args) => { ... }` in the first inspectable
page of com.murage.mobile whose URL starts with the prefix, and prints the
JSON result. Waits up to 30 s for the page. --url prints the page's URL,
--list every page of the app. It talks to the simulator's webinspectord over
its launchd socket (binary-plist RPC, then the Target domain), so it reaches
only WebViews a debug build made inspectable. Exit 2: no such page; 3: the
page went away before answering.
"""
import json
import os
import plistlib
import socket
import struct
import subprocess
import sys
import time
import uuid

BUNDLE = "com.murage.mobile"


def inspector_socket(udid):
    ps = subprocess.run(["ps", "-ax", "-o", "pid=,command="], capture_output=True, text=True).stdout
    pids = [line.split(None, 1)[0] for line in ps.splitlines() if "launchd_sim" in line and udid in line]
    for pid in pids:
        names = subprocess.run(["lsof", "-a", "-p", pid, "-U", "-F", "n"], capture_output=True, text=True).stdout
        for name in names.splitlines():
            if name.startswith("n") and name.endswith("webinspectord_sim.socket"):
                return name[1:]
    sys.exit(f"no Web Inspector socket for simulator {udid}")


class Inspector:
    def __init__(self, udid):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(inspector_socket(udid))
        self.conn = str(uuid.uuid4()).upper()
        self.apps = {}
        self.listings = {}
        self.data = []
        self.send("_rpc_reportIdentifier:", {})
        self.send("_rpc_getConnectedApplications:", {})

    def send(self, selector, argument):
        argument = dict(argument, WIRConnectionIdentifierKey=self.conn)
        body = plistlib.dumps({"__selector": selector, "__argument": argument}, fmt=plistlib.FMT_BINARY)
        self.sock.sendall(struct.pack(">I", len(body)) + body)

    def read_exact(self, size):
        chunks = b""
        while len(chunks) < size:
            chunk = self.sock.recv(size - len(chunks))
            if not chunk:
                raise EOFError("the inspector socket closed")
            chunks += chunk
        return chunks

    def pump(self, timeout):
        """Reads one message (or none before the timeout) and files it."""
        self.sock.settimeout(timeout)
        try:
            size = struct.unpack(">I", self.read_exact(4))[0]
        except socket.timeout:
            return False
        self.sock.settimeout(None)
        message = plistlib.loads(self.read_exact(size))
        selector = message.get("__selector")
        argument = message.get("__argument", {})
        if selector in ("_rpc_reportConnectedApplicationList:",):
            self.apps = dict(argument.get("WIRApplicationDictionaryKey", {}))
        elif selector in ("_rpc_applicationConnected:", "_rpc_applicationUpdated:"):
            self.apps[argument["WIRApplicationIdentifierKey"]] = argument
        elif selector == "_rpc_applicationDisconnected:":
            self.apps.pop(argument.get("WIRApplicationIdentifierKey"), None)
        elif selector == "_rpc_applicationSentListing:":
            self.listings[argument["WIRApplicationIdentifierKey"]] = argument.get("WIRListingKey", {})
        elif selector == "_rpc_applicationSentData:":
            self.data.append(json.loads(argument["WIRMessageDataKey"]))
        return True

    def our_apps(self):
        ids = [key for key, app in self.apps.items() if app.get("WIRApplicationBundleIdentifierKey") == BUNDLE]
        # WebContent proxies hosted by the app carry its id as their host.
        ids += [key for key, app in self.apps.items() if app.get("WIRHostApplicationIdentifierKey") in ids]
        return ids

    def pages(self):
        self.listings = {}
        for app in self.our_apps():
            self.send("_rpc_forwardGetListing:", {"WIRApplicationIdentifierKey": app})
        end = time.time() + 1.0
        while time.time() < end and len(self.listings) < len(self.our_apps()):
            self.pump(0.2)
        found = []
        for app, listing in self.listings.items():
            for page in listing.values():
                if page.get("WIRTypeKey") in ("WIRTypeWeb", "WIRTypeWebPage"):
                    found.append((app, page["WIRPageIdentifierKey"], page.get("WIRURLKey", "")))
        return found


class Page:
    def __init__(self, inspector, app, page):
        self.inspector = inspector
        self.app = app
        self.page = page
        self.sender = str(uuid.uuid4()).upper()
        self.target = None
        self.next_id = 0
        inspector.send("_rpc_forwardSocketSetup:", {
            "WIRApplicationIdentifierKey": app, "WIRPageIdentifierKey": page,
            "WIRSenderKey": self.sender, "WIRAutomaticallyPause": False,
            "WIRMessageDataTypeChunkSupportedKey": 0,
        })
        end = time.time() + 2.0
        while time.time() < end and self.target is None:
            self.inspector.pump(0.2)
            self.take_targets()

    def take_targets(self):
        for message in list(self.inspector.data):
            if message.get("method") == "Target.targetCreated":
                info = message["params"]["targetInfo"]
                if info.get("type") == "page" and not info.get("isProvisional"):
                    self.target = info["targetId"]
                self.inspector.data.remove(message)

    def raw(self, message):
        self.inspector.send("_rpc_forwardSocketData:", {
            "WIRApplicationIdentifierKey": self.app, "WIRPageIdentifierKey": self.page,
            "WIRSenderKey": self.sender, "WIRSocketDataKey": json.dumps(message).encode(),
        })

    def call(self, method, params, timeout=60):
        self.next_id += 1
        inner_id = self.next_id
        inner = {"id": inner_id, "method": method, "params": params}
        if self.target:
            self.next_id += 1
            self.raw({"id": self.next_id, "method": "Target.sendMessageToTarget",
                      "params": {"targetId": self.target, "message": json.dumps(inner)}})
        else:
            self.raw(inner)
        end = time.time() + timeout
        while time.time() < end:
            for message in list(self.inspector.data):
                reply = message
                if message.get("method") == "Target.dispatchMessageFromTarget":
                    reply = json.loads(message["params"]["message"])
                if reply.get("id") == inner_id and ("result" in reply or "error" in reply):
                    self.inspector.data.remove(message)
                    if "error" in reply:
                        raise RuntimeError(reply["error"].get("message", str(reply["error"])))
                    return reply["result"]
                if message.get("method") == "Target.targetDestroyed" and message["params"].get("targetId") == self.target:
                    raise EOFError("the page went away")
            if not self.inspector.pump(0.5):
                continue
        raise TimeoutError(method)

    def close(self):
        self.inspector.send("_rpc_forwardDidClose:", {
            "WIRApplicationIdentifierKey": self.app, "WIRPageIdentifierKey": self.page, "WIRSenderKey": self.sender,
        })


def main():
    udid, prefix = sys.argv[1], sys.argv[2]
    inspector = Inspector(udid)
    deadline = time.time() + 30
    chosen = None
    while time.time() < deadline:
        try:
            while inspector.pump(0.1):
                pass
            pages = inspector.pages()
        except (EOFError, OSError):
            # webinspectord drops a client while an app comes or goes; connect again.
            time.sleep(0.5)
            inspector = Inspector(udid)
            continue
        if prefix == "--list":
            print(json.dumps([url for _, _, url in pages]))
            return
        matching = [page for page in pages if page[2].startswith(prefix)]
        if matching:
            chosen = max(matching, key=lambda page: page[1])
            break
        time.sleep(0.5)
    if not chosen:
        print(f"no inspectable page starting with {prefix}", file=sys.stderr)
        sys.exit(2)
    if sys.argv[3] == "--url":
        print(json.dumps(chosen[2]))
        return
    script = open(sys.argv[3], encoding="utf-8").read()
    args = sys.argv[4] if len(sys.argv) > 4 else "{}"
    page = Page(inspector, chosen[0], chosen[1])
    expression = f"(async (args) => {{\n{script}\n}})({args})"
    try:
        evaluated = page.call("Runtime.evaluate", {"expression": expression, "returnByValue": False, "emulateUserGesture": True})
        if evaluated.get("wasThrown"):
            print(evaluated["result"].get("description", "threw"), file=sys.stderr)
            sys.exit(1)
        settled = page.call("Runtime.awaitPromise", {"promiseObjectId": evaluated["result"]["objectId"], "returnByValue": True})
        if settled.get("wasThrown"):
            print(settled["result"].get("description", "rejected"), file=sys.stderr)
            sys.exit(1)
        print(json.dumps(settled["result"].get("value")))
    except (EOFError, TimeoutError) as gone:
        print(f"the page went away before answering: {gone}", file=sys.stderr)
        sys.exit(3)
    finally:
        try:
            page.close()
        except OSError:
            pass


if __name__ == "__main__":
    main()
