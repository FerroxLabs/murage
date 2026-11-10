#!/bin/bash
# Checks GetConsoleWindow() for a console probe launched through the Chrome spawn path; does not validate other spawns, stdio, handle inheritance, or cleanup.
# smoke-windows-no-console.sh <engine.exe>: run on a native Windows runner (Git Bash), never on a developer machine.
# Proves the engine's browser child gets NO console window. The engine's daemon runs detached (no console of its own),
# and chrome-headless-shell.exe is a console-subsystem program, so before omb.3 Windows opened a console window for it.
#   1. A tiny console program (fake.exe) records GetConsoleWindow() (0 = no console window) to a file, then waits.
#   2. CONTROL: a detached process with no console starts fake.exe the plain way (what the bug did). It must see a
#      console window (non-zero). If it does not, this runner cannot show the bug and the proof is INCONCLUSIVE (exit 1).
#   3. The engine is started with --executable-path fake.exe, so its daemon spawns fake.exe exactly where it spawns Chrome.
#      fake.exe must report 0.
set -u
BIN=${1:?usage: smoke-windows-no-console.sh <engine.exe>}
D=$(mktemp -d); cd "$D" || exit 1
CSC=$(ls /c/Windows/Microsoft.NET/Framework64/v4.*/csc.exe 2>/dev/null | tail -1)
[ -n "$CSC" ] || { echo "NOCONSOLE FAIL: csc.exe not found on this runner"; exit 1; }
cat > fake.cs <<'EOF'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
class Fake {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  static void Main(string[] args) {
    File.WriteAllText(Environment.GetEnvironmentVariable("FAKE_OUT") + ".pid", System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
    File.WriteAllText(Environment.GetEnvironmentVariable("FAKE_OUT"), "hwnd=" + GetConsoleWindow().ToInt64());
    Thread.Sleep(40000);
  }
}
EOF
"$CSC" -nologo -target:exe -out:fake.exe fake.cs || { echo "NOCONSOLE FAIL: could not compile the probe"; exit 1; }
# The control launcher is a GUI-subsystem program: like the engine daemon it owns no console, and it starts the
# console probe the plain way (no CREATE_NO_WINDOW), which is exactly what the bug did.
cat > launcher.cs <<'EOF'
using System;
using System.Diagnostics;
class Launcher {
  static void Main(string[] args) {
    var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("FAKE_EXE")) { UseShellExecute = false, CreateNoWindow = false };
    Process.Start(psi);
  }
}
EOF
"$CSC" -nologo -target:winexe -out:launcher.exe launcher.cs || { echo "NOCONSOLE FAIL: could not compile the launcher"; exit 1; }
export FAKE_EXE=$(cygpath -w "$D/fake.exe")
# Kill only the probe processes whose PIDs the probes recorded (never by image name).
kill_probe() { local p; p=$(cat "$1.pid" 2>/dev/null | tr -d '\r\n'); case "${p:-}" in ""|*[!0-9]*) ;; *) taskkill //PID "$p" //F >/dev/null 2>&1 || true;; esac; }
wait_for() { for _ in $(seq 1 30); do [ -s "$1" ] && return 0; sleep 1; done; return 1; }

export FAKE_OUT=$(cygpath -w "$D/control.txt")
"$D/launcher.exe"
wait_for "$D/control.txt" || {
  echo "NOCONSOLE FAIL: control probe never ran"
  echo "diag: fake.exe exists: $(ls -l fake.exe 2>&1 | head -1)"; echo "diag: FAKE_EXE=$FAKE_EXE FAKE_OUT=$FAKE_OUT"
  ( "$D/fake.exe" & sleep 3; echo "diag: direct run wrote: $(cat "$D/control.txt" 2>&1)"; kill_probe "$D/control.txt" )
  kill_probe "$D/control.txt"
  exit 1; }
CONTROL=$(cat "$D/control.txt"); kill_probe "$D/control.txt"; echo "control (plain spawn from a console-less process): $CONTROL"
case "$CONTROL" in hwnd=0) echo "NOCONSOLE INCONCLUSIVE: the plain spawn also shows no console window on this runner"; exit 1;; hwnd=*) ;; *) echo "NOCONSOLE FAIL: unreadable control result"; exit 1;; esac

mkdir -p "$D/sock" "$D/home"; chmod 700 "$D/sock"
export FAKE_OUT=$(cygpath -w "$D/engine.txt")
export AGENT_BROWSER_CONTROL_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
export AGENT_BROWSER_SOCKET_DIR=$D/sock HOME=$D/home
"$BIN" --session noconsole --executable-path "$FAKE_EXE" open about:blank > "$D/open.out" 2>&1 &
OPENPID=$!
fail=0
if wait_for "$D/engine.txt"; then
  RESULT=$(cat "$D/engine.txt"); echo "engine browser child: $RESULT"
  [ "$RESULT" = "hwnd=0" ] || { echo "NOCONSOLE FAIL: the browser child got a console window"; fail=1; }
else
  echo "NOCONSOLE FAIL: the engine never started the browser child"; head -5 "$D/open.out"; fail=1
fi
DPID=$(cat "$D/sock/noconsole.pid" 2>/dev/null)
case "${DPID:-}" in ""|*[!0-9]*) ;; *) taskkill //PID "$DPID" //F >/dev/null 2>&1 || true;; esac
kill "$OPENPID" 2>/dev/null || true
kill_probe "$D/engine.txt"
[ "$fail" -eq 0 ] && echo "NOCONSOLE OK: control opened a console window, the engine's browser child did not"
exit $fail
