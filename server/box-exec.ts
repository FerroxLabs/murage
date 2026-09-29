// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// computer_exec on the cloud box: a command runs until it finishes, the
// owner's silence limit passes with no output and no work, or Stop.
//
// The box's REST command endpoint answers only when its command exits, and
// one request cannot wait forever, so a long command used to be cut off at
// the request's 120 s deadline however hard it was working. Now the command
// runs detached on the box as a job in a session of its own, and every
// request is short and bounded:
//
//   start    writes the job and waits a few seconds, so a quick command still
//            answers in ONE round trip with its output
//   poll     waits up to one poll window for the job to finish and reports
//            how much it has printed and how much processor time its
//            processes (its session and everything descended from it) used
//   stop     ends those processes (TERM, then KILL) and collects the output
//   cleanup  removes a finished job once its result has been delivered
//
// Progress is new output, processor use above a trickle (1% of the window,
// children already finished included), or storage reads and writes (a quiet
// download): an idle server's timer ticks are not work.
//
// Resource rules the box-side supervisor keeps on its own:
//   - a lease: each start/poll writes the time; a job nobody has checked on
//     for `leaseSec` (its proxy was killed outright) is stopped, and a stop
//     expires the lease too, so the supervisor ends a job even when the stop
//     could not signal it itself
//   - output goes through a pipe to capped files, so a chatty command keeps
//     only a tail on disk, and a daemon it left running loses its output
//     pipe once the command itself exits (as it did on the old endpoint)
//   - a record from before a reboot is never signalled (its ids may belong
//     to someone else now); stale and abandoned records are swept at start

export interface BoxRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface BoxExecOptions {
  /** How long the start request waits for a quick command to finish. */
  firstWaitSec: number;
  /** How long one poll waits for the job before reporting. */
  pollSec: number;
  /** A job unchecked for this long is stopped box-side. */
  leaseSec: number;
  /** Per output stream, bytes kept on disk before the older part is dropped. */
  outputCapBytes: number;
}

export const DEFAULT_BOX_EXEC_OPTIONS: BoxExecOptions = {
  firstWaitSec: 20,
  pollSec: 15,
  leaseSec: 180,
  outputCapBytes: 32 * 1024 * 1024,
};

const KEEP_BYTES = 262_144;
const MIN_OUTPUT_CAP = 2 * KEEP_BYTES;

export function boxExecOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BoxExecOptions {
  const int = (value: string | undefined, fallback: number, min: number) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    firstWaitSec: int(env.MURAGE_EXEC_FIRST_WAIT_SEC, DEFAULT_BOX_EXEC_OPTIONS.firstWaitSec, 0),
    pollSec: int(env.MURAGE_EXEC_POLL_SEC, DEFAULT_BOX_EXEC_OPTIONS.pollSec, 1),
    leaseSec: int(env.MURAGE_EXEC_LEASE_SEC, DEFAULT_BOX_EXEC_OPTIONS.leaseSec, 3),
    outputCapBytes: int(env.MURAGE_EXEC_OUTPUT_CAP, DEFAULT_BOX_EXEC_OPTIONS.outputCapBytes, MIN_OUTPUT_CAP),
  };
}

/** The stop comes a little before the turn's own silence limit, so the bot
 * is told its command went quiet instead of the whole turn being stopped. */
export function commandSilenceMs(turnSilenceMs: number): number {
  return Math.max(1_000, turnSilenceMs - Math.min(60_000, Math.floor(turnSilenceMs / 4)));
}

/** Processor time that counts as work over a window: 1% of it, at least a
 * tick. Finished children count from 5%, so a loop that keeps starting a
 * probe while it waits for something (curl, nc, sleep 0.1) is not work. */
export function cpuProgressTicks(windowMs: number, hz: number, share = 0.01): number {
  return Math.max(1, Math.ceil((windowMs / 1000) * hz * share));
}
const CHILD_CPU_SHARE = 0.05;

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const JOB_ROOT = '"$HOME/.cache/murage-exec"';
const STDOUT_TAIL = 6_000;
const STDERR_TAIL = 2_000;
/** Seconds past its lease after which a record with no result is abandoned. */
const ABANDON_MARGIN_SEC = 120;

/** Shell helpers every script shares. `$J` is the job folder, `$BOOT` this
 * boot's id. */
const HELPERS = [
  'BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)',
  // the job's processes: its session, and everything descended from it (sudo
  // and job-control shells start new sessions or groups underneath)
  // mode cpu: own and finished children's processor ticks; mode pids: one per line
  'members() {',
  `  cat /proc/[0-9]*/stat 2>/dev/null | awk -v s="$S" -v mode="$1" '{ p = $1; sub(/^.*\\) /, ""); pp[p] = $2; t[p] = $12 + $13; c[p] = $14 + $15; if ($4 == s) m[p] = 1 } END { k = 1; while (k) { k = 0; for (p in pp) if (!(p in m) && (pp[p] in m)) { m[p] = 1; k = 1 } } n = 0; d = 0; for (p in m) { if (mode == "cpu") { n += t[p]; d += c[p] } else print p } if (mode == "cpu") printf "%.0f %.0f\\n", n, d }'`,
  '}',
  // a session id is trusted only when it is a real one from this boot
  'sidok() {',
  '  S=$(cat "$J/sid" 2>/dev/null)',
  '  case "$S" in ""|*[!0-9]*) S=""; return 1;; esac',
  '  if [ "$S" -le 1 ] || [ "$(cat "$J/boot" 2>/dev/null)" != "$BOOT" ]; then S=""; return 1; fi',
  // a live leader must be the one this job started, not a reused id
  // (a leader that has just exited, or a record without the time, skips it)
  '  local st0 want; want=$(cat "$J/sidstart" 2>/dev/null)',
  '  if [ -n "$want" ] && [ -r "/proc/$S/stat" ] && read -r st0 < "/proc/$S/stat" 2>/dev/null && [ -n "$st0" ]; then',
  '    set -- ${st0##*")" }',
  '    if [ "${20}" != "$want" ]; then S=""; return 1; fi',
  '  fi',
  '}',
  // bytes the job's processes read from or wrote to storage
  // (a running total: a member that exits keeps the bytes last seen for it)
  'io() {',
  `  for p in $(members pids); do printf '%s %s\\n' "$p" "$(awk '/^(read|write)_bytes:/ { s += $2 } END { printf "%.0f", s }' "/proc/$p/io" 2>/dev/null || echo 0)"; done > "$J/io.now"`,
  '  touch "$J/io.seen"',
  `  set -- $(awk -v base="$(cat "$J/io.base" 2>/dev/null || echo 0)" 'FILENAME == ARGV[1] { seen[$1] = $2; next } { now[$1] = $2 } END { for (p in seen) if (!(p in now)) base += seen[p]; t = base; for (p in now) t += now[p]; printf "%.0f %.0f\\n", base, t }' "$J/io.seen" "$J/io.now")`,
  '  echo "${1:-0}" > "$J/io.base"; mv -f "$J/io.now" "$J/io.seen"; echo "${2:-0}"',
  '}',
  // the whole tree is listed before anything is signalled: a child whose
  // parent dies first is re-parented away and would no longer be found
  'sig() { sidok && sigS "$1"; return 0; }',
  // signal session $S as it stands (the supervisor knows its own)
  'sigS() {',
  '  set -- "$1" $(members pids)',
  '  sg=$1; shift',
  '  kill "-$sg" -- "-$S" 2>/dev/null',
  '  for p in "$@"; do kill "-$sg" "$p" 2>/dev/null || sudo -n kill "-$sg" "$p" 2>/dev/null; done',
  '}',
  'lease() { date +%s > "$J/lease.tmp" && mv -f "$J/lease.tmp" "$J/lease"; }',
  'expire() { echo 0 > "$J/lease.tmp" && mv -f "$J/lease.tmp" "$J/lease"; }',
].join("\n");

/** Runs box-side as `bash sup <dir> <leaseSec> <capBytes>` in its own
 * session. The command gets a session of its own too. */
function supervisorScript(): string {
  return [
    'J=$1; LEASE=$2; CAP=$3',
    HELPERS,
    'mkfifo "$J/o.fifo" "$J/e.fifo" || { echo 127 > "$J/rc"; exit 0; }',
    'cat "$J/o.fifo" >> "$J/out" & RO=$!',
    'cat "$J/e.fifo" >> "$J/err" & RE=$!',
    `setsid -w bash -c 'read -r l < /proc/$$/stat; set -- \${l##*")" }; echo "\${20}" > "$0/sidstart"; echo $$ > "$0/sid"; exec bash "$0/cmd"' "$J" > "$J/o.fifo" 2> "$J/e.fifo" < /dev/null &`,
    'P=$!',
    '(',
    '  S=$P',
    '  while kill -0 "$P" 2>/dev/null; do',
    '    sleep 1',
    // a record removed from under a live job: nobody can check on it any more
    '    if [ ! -d "$J" ]; then sigS TERM; sleep 3; sigS KILL; break; fi',
    '    now=$(date +%s); l=$(cat "$J/lease" 2>/dev/null)',
    '    case "$l" in ""|*[!0-9]*) continue;; esac',
    '    if [ $((now - l)) -gt "$LEASE" ]; then',
    '      echo lease > "$J/abandoned"',
    '      sigS TERM; sleep 3; sigS KILL',
    '      break',
    '    fi',
    '    for f in out err; do',
    '      s=$(stat -c %s "$J/$f" 2>/dev/null || echo 0)',
    '      if [ "$s" -gt "$CAP" ]; then',
    `        tail -c ${KEEP_BYTES} "$J/$f" > "$J/$f.keep"; : > "$J/$f"`,
    '        d=$(cat "$J/$f.dropped" 2>/dev/null || echo 0)',
    `        echo $((d + s - ${KEEP_BYTES})) > "$J/$f.dropped"`,
    '      fi',
    '    done',
    '  done',
    ') & M=$!',
    'wait "$P"; rc=$?',
    'kill "$M" 2>/dev/null',
    // the readers end on their own at EOF; a daemon the command left holding
    // the pipe gets one second, then loses it
    '( sleep 1; kill "$RO" "$RE" 2>/dev/null ) & K=$!',
    'wait "$RO" "$RE" 2>/dev/null',
    'kill "$K" 2>/dev/null',
    'echo "$rc" > "$J/rc.tmp" && mv "$J/rc.tmp" "$J/rc"',
  ].join("\n");
}

/** Shell that prints the job's state lines (st) and its output (collect). */
const STATUS = [
  'st() {',
  '  if [ ! -d "$J" ] || [ -f "$J/cancel" ] || [ "$(cat "$J/boot" 2>/dev/null)" != "$BOOT" ]; then echo "EXEC_STATE missing"; return; fi',
  '  if [ -f "$J/rc" ]; then echo "EXEC_STATE done"; echo "EXEC_RC $(cat "$J/rc")"; else echo "EXEC_STATE running"; fi',
  '  if [ -f "$J/abandoned" ]; then echo "EXEC_ABANDONED yes"; fi',
  '  n=0; for f in out err; do s=$(stat -c %s "$J/$f" 2>/dev/null || echo 0); d=$(cat "$J/$f.dropped" 2>/dev/null || echo 0); n=$((n + s + d)); done',
  '  echo "EXEC_BYTES $n"',
  '  if sidok; then set -- $(members cpu); echo "EXEC_CPU ${1:-0}"; echo "EXEC_CCPU ${2:-0}"; echo "EXEC_IO $(io)"; else echo "EXEC_CPU 0"; echo "EXEC_CCPU 0"; echo "EXEC_IO 0"; fi',
  '  echo "EXEC_HZ $(getconf CLK_TCK 2>/dev/null || echo 100)"',
  '}',
  // the record stays until the proxy's cleanup (or the next start's sweep),
  // so a poll whose answer was lost can be asked again
  'collect() {',
  '  if [ -f "$J/out.dropped" ] || [ -f "$J/err.dropped" ]; then echo "EXEC_DROPPED yes"; fi',
  `  echo "EXEC_STDOUT $(cat "$J/out.keep" "$J/out" 2>/dev/null | tail -c ${STDOUT_TAIL} | base64 -w0)"`,
  `  echo "EXEC_STDERR $(cat "$J/err.keep" "$J/err" 2>/dev/null | tail -c ${STDERR_TAIL} | base64 -w0)"`,
  '  if [ -f "$J/rc" ]; then : > "$J/collected"; fi',
  '}',
].join("\n");

const jobDir = (id: string) => {
  if (!/^[a-f0-9]{16,64}$/.test(id)) throw new Error("invalid job id");
  return `R=${JOB_ROOT}; J="$R/${id}"`;
};

/** Wait (box-side) up to `sec` for the job to finish, then report. */
function waitShell(sec: number): string {
  return [
    `end=$((SECONDS + ${Math.max(0, Math.trunc(sec))}))`,
    'while [ -d "$J" ] && [ ! -f "$J/rc" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.25; done',
    'st; if [ -f "$J/rc" ] && [ ! -f "$J/cancel" ]; then collect; fi',
  ].join("\n");
}

/** Stale records: from another boot, delivered, finished over an hour ago,
 * or abandoned (no result, lease long gone: its supervisor died). */
function sweepShell(leaseSec: number): string {
  return [
    'for d in "$R"/*/; do',
    '  [ -d "$d" ] || continue',
    '  ( J=${d%/}',
    '    old() { [ -n "$(find "$1" -maxdepth 0 -mmin +"$2" 2>/dev/null)" ]; }',
    '    b=$(cat "$J/boot" 2>/dev/null); l=$(cat "$J/lease" 2>/dev/null)',
    // a record still being written (by another start or stop) is left alone
    '    if [ -z "$b" ]; then old "$J" 10 && rm -rf -- "${J:?}"; exit 0; fi',
    '    if [ "$b" != "$BOOT" ]; then rm -rf -- "${J:?}"; exit 0; fi',
    // a stop's tombstone outlives any start still in flight
    '    if [ -f "$J/cancel" ]; then old "$J/cancel" 10 && rm -rf -- "${J:?}"; exit 0; fi',
    // delivered: kept a while in case the answer was lost on the way
    '    if [ -f "$J/collected" ]; then old "$J/collected" 10 && rm -rf -- "${J:?}"; exit 0; fi',
    // a stop in progress expired the lease on purpose
    '    if [ -f "$J/stopping" ] && ! old "$J/stopping" 10; then exit 0; fi',
    '    if [ -f "$J/rc" ]; then old "$J/rc" 60 && rm -rf -- "${J:?}"; exit 0; fi',
    '    case "$l" in ""|*[!0-9]*) old "$J" 10 && rm -rf -- "${J:?}"; exit 0;; esac',
    `    if [ $(( $(date +%s) - l )) -gt ${Math.trunc(leaseSec) + ABANDON_MARGIN_SEC} ]; then`,
    '      sig KILL; sleep 1',
    // kept (and retried by the next sweep) while anything of it still runs
    '      if sidok && [ -n "$(members pids)" ]; then exit 0; fi',
    '      rm -rf -- "${J:?}"',
    '    fi',
    '  )',
    'done',
  ].join("\n");
}

export function startScript(id: string, command: string, opts: BoxExecOptions): string {
  return [
    jobDir(id),
    HELPERS,
    STATUS,
    // only the records are private; the command keeps the box's own umask
    '( umask 077; mkdir -p "$R" ) || { echo "EXEC_START_FAILED"; exit 0; }',
    'if ! mkdir -m 700 "$J" 2>/dev/null; then',
    // a stop that arrived first leaves a tombstone, and the job never starts
    '  if [ -f "$J/cancel" ]; then echo "EXEC_STATE cancelled"; else echo "EXEC_START_FAILED"; fi',
    '  exit 0',
    'fi',
    "lease",
    'echo "$BOOT" > "$J/boot"',
    sweepShell(opts.leaseSec),
    `printf %s ${shq(b64(command))} | base64 -d > "$J/cmd"`,
    `printf %s ${shq(b64(supervisorScript()))} | base64 -d > "$J/sup"`,
    `setsid bash "$J/sup" "$J" ${Math.trunc(opts.leaseSec)} ${Math.trunc(opts.outputCapBytes)} < /dev/null > /dev/null 2>&1 &`,
    // the command writes its session id first thing; wait for it briefly so
    // an immediate stop always has a session to signal
    'i=0; while [ ! -s "$J/sid" ] && [ ! -f "$J/rc" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done',
    waitShell(opts.firstWaitSec),
  ].join("\n");
}

export function pollScript(id: string, waitSec: number): string {
  return [
    jobDir(id),
    HELPERS,
    STATUS,
    'if [ -d "$J" ] && [ ! -f "$J/rc" ] && [ ! -f "$J/cancel" ] && [ ! -f "$J/stopping" ]; then lease; fi',
    waitShell(waitSec),
  ].join("\n");
}

/** `graceful`: wait for the job to end and collect its output. Without it
 * (the proxy itself is closing) the signals are sent and it returns at once;
 * a follow-up in its own session finishes the job off. */
export function stopScript(id: string, graceful: boolean): string {
  const lines = [
    jobDir(id),
    HELPERS,
    STATUS,
    'mkdir -p "$R" 2>/dev/null',
    // not started yet: leave a tombstone so a late start never runs it
    'if mkdir -m 700 "$J" 2>/dev/null; then echo "$BOOT" > "$J/boot"; : > "$J/cancel"; : > "$J/collected"; echo "EXEC_STATE missing"; exit 0; fi',
    // a start in progress writes the session id within two seconds
    'i=0; while [ ! -s "$J/sid" ] && [ ! -f "$J/rc" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done',
    'if [ -f "$J/rc" ]; then echo "EXEC_ALREADY_DONE yes"; st; collect; exit 0; fi',
    'if [ "$(cat "$J/boot" 2>/dev/null)" != "$BOOT" ]; then echo "EXEC_STATE missing"; exit 0; fi',
    // the supervisor also ends a job whose lease has run out
    ': > "$J/stopping"',
    "expire",
    "sig TERM",
  ];
  if (!graceful) {
    const followUp = [
      'J=$1',
      HELPERS,
      'sleep 3; [ -f "$J/rc" ] || sig KILL',
      'sleep 2; [ -f "$J/rc" ] && : > "$J/collected"',
    ].join("\n");
    lines.push(
      `printf %s ${shq(b64(followUp))} | base64 -d > "$J/stop"`,
      'setsid bash "$J/stop" "$J" < /dev/null > /dev/null 2>&1 &',
      'echo "EXEC_STATE stopping"',
    );
    return lines.join("\n");
  }
  lines.push(
    'i=0; while [ ! -f "$J/rc" ] && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done',
    'if [ ! -f "$J/rc" ]; then sig KILL; fi',
    'i=0; while [ ! -f "$J/rc" ] && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done',
    'st; collect',
  );
  return lines.join("\n");
}

/** Removes a finished job once its result has been delivered. */
export function cleanupScript(id: string): string {
  return [jobDir(id), 'if [ -f "$J/rc" ] || [ -f "$J/cancel" ]; then rm -rf -- "${J:?}"; fi'].join("\n");
}

export interface ExecStatus {
  state: "done" | "running" | "missing" | "cancelled" | "stopping" | "unknown";
  exitCode: number | null;
  bytes: number;
  cpu: number;
  /** Processor time of the job's children that have already finished. */
  ccpu: number;
  io: number;
  hz: number;
  stdout: string;
  stderr: string;
  dropped: boolean;
  abandoned: boolean;
  alreadyDone: boolean;
}

export function parseStatus(stdout: string): ExecStatus {
  const line = (key: string) => stdout.match(new RegExp(`^${key} ?(.*)$`, "m"))?.[1];
  const state = line("EXEC_STATE");
  const decode = (value: string | undefined) => (value ? Buffer.from(value.trim(), "base64").toString("utf8") : "");
  const rc = line("EXEC_RC")?.trim();
  const hz = Number(line("EXEC_HZ"));
  return {
    state:
      state === "done" || state === "running" || state === "missing" || state === "cancelled" || state === "stopping"
        ? state
        : "unknown",
    exitCode: rc !== undefined && /^-?\d+$/.test(rc) ? Number(rc) : null,
    bytes: Number(line("EXEC_BYTES") ?? 0) || 0,
    cpu: Number(line("EXEC_CPU") ?? 0) || 0,
    ccpu: Number(line("EXEC_CCPU") ?? 0) || 0,
    io: Number(line("EXEC_IO") ?? 0) || 0,
    hz: Number.isFinite(hz) && hz > 0 ? hz : 100,
    stdout: decode(line("EXEC_STDOUT")),
    stderr: decode(line("EXEC_STDERR")),
    dropped: line("EXEC_DROPPED") === "yes",
    abandoned: line("EXEC_ABANDONED") === "yes",
    alreadyDone: line("EXEC_ALREADY_DONE") === "yes",
  };
}

export type ExecOutcome =
  | { kind: "done"; exitCode: number | null; stdout: string; stderr: string; dropped: boolean; abandoned: boolean }
  | { kind: "silent"; silentMs: number; stdout: string; stderr: string; dropped: boolean }
  | { kind: "stopped" }
  | { kind: "failed"; detail: string };

export interface BoxExecDeps {
  /** One bounded round trip to the box. `timeoutMs` bounds the request, never
   * the job. Only a start may wake a sleeping box: a job cannot outlive one. */
  run(command: string, timeoutMs: number, signal?: AbortSignal, wake?: boolean): Promise<BoxRun>;
  /** The turn's silence limit right now (the owner's setting). */
  turnSilenceMs(): number;
  /** The command printed or worked since the last poll. */
  progress(): void;
  newId(): string;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const REQUEST_MARGIN_MS = 30_000;
/** Storage reads and writes that count as work over a window (a quiet download). */
const IO_PROGRESS_BYTES = 65_536;
const MISSING = "the command's record disappeared from the computer (it may have restarted)";

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Stop a job, best effort. `graceful` collects its output; the rest only signal. */
export async function stopBoxJob(
  deps: Pick<BoxExecDeps, "run">,
  id: string,
  graceful: boolean,
  timeoutMs = graceful ? 25_000 : 5_000,
): Promise<ExecStatus | null> {
  try {
    const out = await deps.run(stopScript(id, graceful), timeoutMs, undefined, false);
    return parseStatus(out.stdout);
  } catch {
    return null;
  }
}

/** Remove a delivered job's record, best effort (the next start sweeps it otherwise). */
export async function cleanupBoxJob(deps: Pick<BoxExecDeps, "run">, id: string): Promise<void> {
  try {
    await deps.run(cleanupScript(id), 15_000, undefined, false);
  } catch {
    /* swept later */
  }
}

export async function runBoxExec(
  command: string,
  deps: BoxExecDeps,
  opts: BoxExecOptions,
  signal: AbortSignal,
  onJob?: (id: string) => void,
): Promise<ExecOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const id = deps.newId();
  onJob?.(id);
  // the turn's clock was last touched before this request; so is this one's
  let lastProgress = now();
  let first: BoxRun;
  try {
    first = await deps.run(startScript(id, command, opts), opts.firstWaitSec * 1000 + REQUEST_MARGIN_MS, signal, true);
  } catch (error) {
    // the request may have started the job before it failed (or was stopped)
    await stopBoxJob(deps, id, false);
    if (signal.aborted) return { kind: "stopped" };
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (/^EXEC_START_FAILED$/m.test(first.stdout)) {
    return { kind: "failed", detail: "the computer could not create the command's working folder" };
  }
  let status = parseStatus(first.stdout);
  if (status.state === "cancelled") return { kind: "stopped" };
  if (status.state === "unknown") {
    await stopBoxJob(deps, id, false);
    return { kind: "failed", detail: first.stderr.slice(0, 300) || `exit ${first.exitCode ?? "unknown"}` };
  }
  let lastBytes = status.bytes;
  let lastCpu = status.cpu;
  let lastCcpu = status.ccpu;
  let lastIo = status.io;
  let lastPollAt = now();
  let failingSince: number | null = null;
  const window0 = lastPollAt - lastProgress;
  if (status.state === "running" && (lastBytes > 0 || lastCpu >= cpuProgressTicks(window0, status.hz)
    || lastCcpu >= cpuProgressTicks(window0, status.hz, CHILD_CPU_SHARE) || lastIo >= IO_PROGRESS_BYTES)) {
    lastProgress = lastPollAt;
    deps.progress();
  }
  const giveUp = async (detail: string): Promise<ExecOutcome> => {
    await stopBoxJob(deps, id, false);
    return { kind: "failed", detail };
  };
  while (status.state === "running") {
    if (signal.aborted) {
      await stopBoxJob(deps, id, false);
      return { kind: "stopped" };
    }
    const limit = commandSilenceMs(deps.turnSilenceMs());
    if (now() - lastProgress >= limit) {
      const final = await stopBoxJob(deps, id, true);
      if (final?.alreadyDone && final.state === "done") {
        return { kind: "done", exitCode: final.exitCode, stdout: final.stdout, stderr: final.stderr, dropped: final.dropped, abandoned: final.abandoned };
      }
      return { kind: "silent", silentMs: limit, stdout: final?.stdout ?? "", stderr: final?.stderr ?? "", dropped: final?.dropped ?? false };
    }
    // never wait past the silence limit inside one poll
    const waitSec = Math.max(1, Math.min(opts.pollSec, Math.floor((limit - (now() - lastProgress)) / 1000)));
    let out: BoxRun;
    try {
      out = await deps.run(pollScript(id, waitSec), waitSec * 1000 + REQUEST_MARGIN_MS, signal, false);
    } catch (error) {
      if (signal.aborted) continue;
      failingSince ??= now();
      // the box-side lease has stopped the job by now
      if (now() - failingSince >= opts.leaseSec * 1000) {
        return giveUp(`lost contact with the computer for ${Math.max(1, Math.round(opts.leaseSec / 60))} minutes, so the command was stopped (${error instanceof Error ? error.message : String(error)})`);
      }
      await sleep(2_000, signal);
      continue;
    }
    const next = parseStatus(out.stdout);
    if (next.state === "unknown") {
      failingSince ??= now();
      if (now() - failingSince >= opts.leaseSec * 1000) return giveUp(out.stderr.slice(0, 300) || `exit ${out.exitCode ?? "unknown"}`);
      await sleep(2_000, signal);
      continue;
    }
    failingSince = null;
    if (next.state !== "running" && next.state !== "done") return { kind: "failed", detail: MISSING };
    const at = now();
    const window = at - lastPollAt;
    const worked = next.cpu - lastCpu >= cpuProgressTicks(window, next.hz)
      || next.ccpu - lastCcpu >= cpuProgressTicks(window, next.hz, CHILD_CPU_SHARE)
      || next.io - lastIo >= IO_PROGRESS_BYTES;
    if (next.bytes !== lastBytes || worked) {
      lastProgress = at;
      deps.progress();
    }
    lastBytes = next.bytes;
    lastCpu = next.cpu;
    lastCcpu = next.ccpu;
    lastIo = next.io;
    lastPollAt = at;
    status = next;
  }
  if (status.state !== "done") return { kind: "failed", detail: MISSING };
  return {
    kind: "done",
    exitCode: status.exitCode,
    stdout: status.stdout,
    stderr: status.stderr,
    dropped: status.dropped,
    abandoned: status.abandoned,
  };
}
