# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
import hashlib
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import fetch_build_input as download


class Response(io.BytesIO):
    def geturl(self):
        return "https://fixture.example/input"


class PinnedInputs(unittest.TestCase):
    def test_corruption_fallback_and_failed_atomic_write(self):
        good = b"reviewed bytes"
        pin = {"urls": ["https://primary.example/input", "https://mirror.example/input"],
               "sha256": hashlib.sha256(good).hexdigest(), "bytes": len(good)}
        with tempfile.TemporaryDirectory() as root, patch.object(download, "PINS", {"fixture": pin}):
            output = pathlib.Path(root) / "archive"
            calls = []

            def serve(request, **_):
                calls.append(request.full_url)
                return Response(good if len(calls) == 2 else b"poison")

            download.fetch_input(pin["urls"][0], output, pin["sha256"], serve)
            self.assertEqual(output.read_bytes(), good)
            self.assertEqual(calls, pin["urls"])
            with self.assertRaises(ValueError):
                download.fetch_input(pin["urls"][0], output, pin["sha256"], lambda *a, **kw: Response(b"poison"))
            self.assertEqual(output.read_bytes(), good)
            self.assertEqual(list(pathlib.Path(root).iterdir()), [output])
            with self.assertRaises(ValueError):
                download.fetch_input(pin["urls"][0], output, "0" * 64, serve)


if __name__ == "__main__":
    unittest.main()
