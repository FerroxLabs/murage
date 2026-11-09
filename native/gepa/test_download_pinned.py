"""Tests the embedded download helper of build-linux.py and build-mac.py (offline, no network)."""
import http.client, os, pathlib, re, shutil, sys, tempfile, time, unittest, urllib.error, urllib.request
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
START, END = "# --- Download resilience", "# ------------------------------------------------------------------------------\n"

def load(name):
    text = (HERE / name).read_text()
    block = text[text.index(START):]
    block = block[: block.index(END, 10) + len(END)]
    ns = {"os": os, "re": re, "shutil": shutil, "sys": sys, "time": time, "urllib": urllib}
    exec(compile(block, name, "exec"), ns)
    return ns

class FakeResponse:
    def __init__(self, data, length=None):
        self.data, self.pos = data, 0
        self.headers = {} if length is None else {"Content-Length": str(length)}
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self, n=-1):
        chunk = self.data[self.pos:] if n < 0 else self.data[self.pos:self.pos + n]
        self.pos += len(chunk); return chunk

def http_error(code): return urllib.error.HTTPError("https://x.test/f", code, "x", {}, None)

class Case(unittest.TestCase):
    def run_helper(self, ns, script, **kw):
        calls = []
        def fake(url, timeout=None):
            calls.append(url); r = script(url, len(calls))
            if isinstance(r, Exception): raise r
            return FakeResponse(r[0], r[1]) if isinstance(r, tuple) else FakeResponse(r)
        dest = pathlib.Path(tempfile.mkdtemp()) / "f"
        with mock.patch.object(urllib.request, "urlopen", fake), mock.patch.dict(os.environ, kw.pop("env", {}), clear=False):
            try: result = ns["download_pinned"]("https://www.python.org/ftp/python/3.13.15/Python-3.13.15.tar.xz", dest, sleep=lambda s: None, **kw)
            except Exception as error: result = error
        return result, calls, dest

    def each(self):
        for name in ("build-linux.py", "build-mac.py"):
            yield load(name)

    def test_recovers_after_transient_errors(self):
        for ns in self.each():
            script = lambda u, n: http_error(504) if n == 1 else (http.client.IncompleteRead(b"x") if n == 2 else b"whole")
            r, calls, dest = self.run_helper(ns, script)
            self.assertEqual(len(calls), 3); self.assertEqual(dest.read_bytes(), b"whole")

    def test_silent_truncation_is_retried(self):
        for ns in self.each():
            r, calls, dest = self.run_helper(ns, lambda u, n: (b"par", 5) if n == 1 else (b"whole", 5))
            self.assertEqual(len(calls), 2); self.assertEqual(dest.read_bytes(), b"whole")

    def test_404_is_not_retried_upstream_then_mirror(self):
        for ns in self.each():
            r, calls, _ = self.run_helper(ns, lambda u, n: http_error(404))
            self.assertIsInstance(r, urllib.error.HTTPError); self.assertEqual(len(calls), 2)
            self.assertIn("build-mirror-1/Python-3.13.15.tar.xz", calls[1])

    def test_falls_back_to_mirror_after_exhaustion(self):
        for ns in self.each():
            r, calls, dest = self.run_helper(ns, lambda u, n: b"mirror" if "build-mirror" in u else http_error(504), attempts=3)
            self.assertEqual(len(calls), 4); self.assertEqual(dest.read_bytes(), b"mirror"); self.assertIn("build-mirror", r)

    def test_mirror_off_and_bad_base(self):
        for ns in self.each():
            for base in ("off", "http://m.test/", "https://u:p@m.test/x/", "https://m.test/x/?q=1", "https://m.test/x"):
                with mock.patch.dict(os.environ, {"MURAGE_PACKAGE_MIRROR_BASE": base}):
                    self.assertIsNone(ns["_mirror_url"]("https://a.test/dir/f.tar.xz"), base)
            with mock.patch.dict(os.environ, {"MURAGE_PACKAGE_MIRROR_BASE": "https://m.test/x/"}):
                self.assertEqual(ns["_mirror_url"]("https://a.test/dir/f.tar.xz"), "https://m.test/x/f.tar.xz")
            r, calls, _ = self.run_helper(ns, lambda u, n: http_error(504), attempts=2, env={"MURAGE_PACKAGE_MIRROR_BASE": "off"})
            self.assertEqual(len(calls), 2)

    def test_no_mirror_when_not_requested(self):
        for ns in self.each():
            r, calls, _ = self.run_helper(ns, lambda u, n: http_error(504), attempts=2, mirror=False)
            self.assertEqual(len(calls), 2)

    def test_hash_checks_untouched(self):
        for name, needles in {"build-linux.py": ["CPython source hash mismatch", "OpenSSL source hash mismatch"], "build-mac.py": ["SHA256 mismatch"]}.items():
            text = (HERE / name).read_text()
            for needle in needles: self.assertIn(needle, text)

if __name__ == "__main__":
    unittest.main()
