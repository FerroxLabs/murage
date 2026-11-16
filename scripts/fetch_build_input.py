# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fetch reviewed inputs using the same pins as the Node build scripts."""
import hashlib
import json
import os
import pathlib
import tempfile
import urllib.request

PINS = json.loads(pathlib.Path(__file__).with_name("build-inputs.json").read_text())


def fetch_input(url, destination, expected_sha=None, opener=urllib.request.urlopen):
    pin = next((pin for pin in PINS.values() if url in pin["urls"]), None)
    if pin is None or (expected_sha is not None and expected_sha != pin["sha256"]):
        raise ValueError("Input has no matching reviewed sha256 pin")
    destination = pathlib.Path(destination)
    urls = [url] + [source for source in pin["urls"] if source != url]
    last = None
    for source in urls:
        fd, temporary = tempfile.mkstemp(prefix=".build-input-", dir=destination.parent)
        try:
            headers = {"Accept": "application/octet-stream"} if source.startswith("https://api.github.com/") else {}
            if not source.startswith("https://"):
                raise ValueError("Build inputs require HTTPS")
            with os.fdopen(fd, "wb") as output:
                with opener(urllib.request.Request(source, headers=headers), timeout=180) as response:
                    if not response.geturl().startswith("https://"):
                        raise ValueError("Build input redirect requires HTTPS")
                    digest, size = hashlib.sha256(), 0
                    while True:
                        part = response.read(1024 * 1024)
                        if not part:
                            break
                        size += len(part)
                        if size > pin["bytes"]:
                            raise ValueError("Build input bytes limit exceeded")
                        digest.update(part)
                        output.write(part)
            if size != pin["bytes"] or digest.hexdigest() != pin["sha256"]:
                raise ValueError("Build input size or sha256 mismatch")
            os.replace(temporary, destination)
            return destination
        except Exception as error:
            last = error
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    raise ValueError(f"Build input download failed: {last}")
