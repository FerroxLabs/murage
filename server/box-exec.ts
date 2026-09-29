// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// computer_exec on the cloud box: a command runs until it finishes, the
// owner's silence limit passes with no output and no work, or Stop.
//
// The box's REST command endpoint answers only when its command exits, and
// one request cannot wait forever, so a long command used to be cut off at
// the request's 120 s deadline however hard it was working. Now the command
// runs detached on the box as a job with its own session, and every request
// is short and bounded:
//
//   start   writes the job and waits a few seconds, so a quick command still
//           answers in ONE round trip with its output
//   poll    waits up to one poll window for the job to finish and reports
//           how much it has printed and how much processor time its
//           processes have used; a change in either is progress
//   stop    stops the job's whole session (TERM, then KILL) and collects
//           what it printed
//
// Resource rules the box-side supervisor keeps on its own:
//   - a lease: each start/poll writes the time; a job nobody has checked on
//     for `leaseSec` (its proxy was killed outright) is stopped
//   - output goes through a pipe to capped files, so a chatty command keeps
//     only a tail on disk, and a daemon it left running loses its output
//     pipe once the command itself exits (as it did on the old endpoint)
//   - finished jobs are collected and removed; one left behind is removed
//     by a later start after an hour

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
  leaseSec: 600,
  outputCapBytes: 32 * 1024 * 1024,
};

export function boxExecOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BoxExecOptions {
  const int = (value: string | undefined, fallback: number, min: number) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    firstWaitSec: int(env.MURAGE_EXEC_FIRST_WAIT_SEC, DEFAULT_BOX_EXEC_OPTIONS.firstWaitSec, 0),
    pollSec: int(env.MURAGE_EXEC_POLL_SEC, DEFAULT_BOX_EXEC_OPTIONS.pollSec, 1),
    leaseSec: int(env.MURAGE_EXEC_LEASE_SEC, DEFAULT_BOX_EXEC_OPTIONS.leaseSec, 3),
    outputCapBytes: int(env.MURAGE_EXEC_OUTPUT_CAP, DEFAULT_BOX_EXEC_OPTIONS.outputCapBytes, 65_536),
  };
}

/** The stop comes a little before the turn's own silence limit, so the bot
 * is told its command went quiet instead of the whole turn being stopped. */
export function commandSilenceMs(turnSilenceMs: number): number {
  return Math.max(1_000, turnSilenceMs - Math.min(60_000, Math.floor(turnSilenceMs / 4)));
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const JOB_ROOT = '"$HOME/.cache/murage-exec"';
const STDOUT_TAIL = 6_000;
const STDERR_TAIL = 2_000;
const KEEP_BYTES = 262_144;

/** Runs box-side as `bash sup <dir> <leaseSec> <capBytes>` in its own
 * session. The command gets a session of its own too, so its processor time
 * can be counted and the whole of it stopped by process group. */
function supervisorScript(): string {
  return [
    'J=$1; LEASE=$2; CAP=$3',
    'mkfifo "$J/o.fifo" "$J/e.fifo" || { echo 127 > "$J/rc"; exit 0; }',
    'cat "$J/o.fifo" >> "$J/out" & RO=$!',
    'cat "$J/e.fifo" >> "$J/err" & RE=$!',
    `setsid -w bash -c 'echo $$ > "$0/sid"; exec bash "$0/cmd"' "$J" > "$J/o.fifo" 2> "$J/e.fifo" < /dev/null &`,
    'P=$!',
    '(',
    '  while kill -0 "$P" 2>/dev/null; do',
    '    sleep 1',
    '    now=$(date +%s); l=$(cat "$J/lease" 2>/dev/null); l=${l:-0}',
    '    if [ $((now - l)) -gt "$LEASE" ]; then',
    '      S=$(cat "$J/sid" 2>/dev/null); S=${S:-$P}',
    '      echo lease > "$J/abandoned"',
    '      kill -TERM -- "-$S" 2>/dev/null; sleep 3; kill -KILL -- "-$S" 2>/dev/null',
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

/** Shell that prints the job's state lines, and its output when finished. */
function statusShell(): string {
  return [
    'st() {',
    '  if [ ! -d "$J" ]; then echo "EXEC_STATE missing"; return; fi',
    '  if [ -f "$J/rc" ]; then echo "EXEC_STATE done"; echo "EXEC_RC $(cat "$J/rc")"; else echo "EXEC_STATE running"; fi',
    '  n=0; for f in out err; do s=$(stat -c %s "$J/$f" 2>/dev/null || echo 0); d=$(cat "$J/$f.dropped" 2>/dev/null || echo 0); n=$((n + s + d)); done',
    '  echo "EXEC_BYTES $n"',
    '  S=$(cat "$J/sid" 2>/dev/null)',
    // utime+stime of every process in the command's session; the comm field
    // may hold spaces, so fields are counted after its closing paren
    `  if [ -n "$S" ]; then echo "EXEC_CPU $(cat /proc/[0-9]*/stat 2>/dev/null | awk -v s="$S" '{ sub(/^.*\\) /, ""); if ($4 == s) t += $12 + $13 } END { print t + 0 }')"; else echo "EXEC_CPU 0"; fi`,
    '}',
    'collect() {',
    '  if [ -f "$J/out.dropped" ] || [ -f "$J/err.dropped" ]; then echo "EXEC_DROPPED yes"; fi',
    `  echo "EXEC_STDOUT $(cat "$J/out.keep" "$J/out" 2>/dev/null | tail -c ${STDOUT_TAIL} | base64 -w0)"`,
    `  echo "EXEC_STDERR $(cat "$J/err.keep" "$J/err" 2>/dev/null | tail -c ${STDERR_TAIL} | base64 -w0)"`,
    '  rm -rf -- "${J:?}"',
    '}',
  ].join("\n");
}

const jobDir = (id: string) => {
  if (!/^[a-f0-9]{16,64}$/.test(id)) throw new Error("invalid job id");
  return `J=${JOB_ROOT}/${id}`;
};

/** Wait (box-side) up to `sec` for the job to finish, then report. */
function waitShell(sec: number): string {
  return [
    `end=$((SECONDS + ${Math.max(0, Math.trunc(sec))}))`,
    'while [ -d "$J" ] && [ ! -f "$J/rc" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.25; done',
    'st; if [ -f "$J/rc" ]; then collect; fi',
  ].join("\n");
}

export function startScript(id: string, command: string, opts: BoxExecOptions): string {
  return [
    jobDir(id),
    statusShell(),
    "umask 077",
    `mkdir -p ${JOB_ROOT} && mkdir "$J" || { echo "EXEC_START_FAILED"; exit 0; }`,
    // a job whose proxy never collected it is removed an hour after it ended
    `for d in ${JOB_ROOT}/*/; do if [ -f "\${d}rc" ] && [ -n "$(find "\${d}rc" -mmin +60 2>/dev/null)" ]; then rm -rf -- "\${d:?}"; fi; done`,
    `printf %s ${shq(b64(command))} | base64 -d > "$J/cmd"`,
    `printf %s ${shq(b64(supervisorScript()))} | base64 -d > "$J/sup"`,
    'date +%s > "$J/lease"',
    `setsid bash "$J/sup" "$J" ${Math.trunc(opts.leaseSec)} ${Math.trunc(opts.outputCapBytes)} < /dev/null > /dev/null 2>&1 &`,
    // the command writes its session id first thing; wait for it briefly so
    // an immediate stop always has a group to signal
    'i=0; while [ ! -s "$J/sid" ] && [ ! -f "$J/rc" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done',
    waitShell(opts.firstWaitSec),
  ].join("\n");
}

export function pollScript(id: string, waitSec: number): string {
  return [jobDir(id), statusShell(), 'if [ -d "$J" ]; then date +%s > "$J/lease"; fi', waitShell(waitSec)].join("\n");
}

/** `graceful`: wait for the session to end and collect its output. Without
 * it (the proxy itself is closing) the signals are sent and it returns. */
export function stopScript(id: string, graceful: boolean): string {
  const lines = [
    jobDir(id),
    statusShell(),
    'if [ ! -d "$J" ]; then echo "EXEC_STATE missing"; exit 0; fi',
    'S=$(cat "$J/sid" 2>/dev/null)',
    'if [ -n "$S" ]; then kill -TERM -- "-$S" 2>/dev/null; fi',
  ];
  if (!graceful) {
    // the follow-up runs in its own session so it outlives this request
    lines.push(
      `setsid bash -c 'sleep 3; [ -n "$1" ] && kill -KILL -- "-$1" 2>/dev/null; sleep 2; rm -rf -- "\${0:?}"' "$J" "$S" < /dev/null > /dev/null 2>&1 &`,
      'echo "EXEC_STATE stopping"',
    );
    return lines.join("\n");
  }
  lines.push(
    'i=0; while [ ! -f "$J/rc" ] && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done',
    'if [ ! -f "$J/rc" ] && [ -n "$S" ]; then kill -KILL -- "-$S" 2>/dev/null; fi',
    'i=0; while [ ! -f "$J/rc" ] && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done',
    'st; collect',
  );
  return lines.join("\n");
}

export interface ExecStatus {
  state: "done" | "running" | "missing" | "unknown";
  exitCode: number | null;
  bytes: number;
  cpu: number;
  stdout: string;
  stderr: string;
  dropped: boolean;
}

export function parseStatus(stdout: string): ExecStatus {
  const line = (key: string) => stdout.match(new RegExp(`^${key} ?(.*)$`, "m"))?.[1];
  const state = line("EXEC_STATE");
  const decode = (value: string | undefined) => (value ? Buffer.from(value.trim(), "base64").toString("utf8") : "");
  return {
    state: state === "done" || state === "running" || state === "missing" ? state : "unknown",
    exitCode: line("EXEC_RC") !== undefined && /^-?\d+$/.test(line("EXEC_RC")!.trim()) ? Number(line("EXEC_RC")) : null,
    bytes: Number(line("EXEC_BYTES") ?? 0) || 0,
    cpu: Number(line("EXEC_CPU") ?? 0) || 0,
    stdout: decode(line("EXEC_STDOUT")),
    stderr: decode(line("EXEC_STDERR")),
    dropped: line("EXEC_DROPPED") === "yes",
  };
}

export type ExecOutcome =
  | { kind: "done"; exitCode: number | null; stdout: string; stderr: string; dropped: boolean }
  | { kind: "silent"; silentMs: number; stdout: string; stderr: string; dropped: boolean }
  | { kind: "stopped" }
  | { kind: "failed"; detail: string };

export interface BoxExecDeps {
  /** One bounded round trip to the box. `timeoutMs` bounds the request, never the job. */
  run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<BoxRun>;
  /** The turn's silence limit right now (the owner's setting). */
  turnSilenceMs(): number;
  /** The command printed or worked since the last poll. */
  progress(): void;
  newId(): string;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const REQUEST_MARGIN_MS = 30_000;

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
  timeoutMs = graceful ? 20_000 : 2_500,
): Promise<ExecStatus | null> {
  try {
    const out = await deps.run(stopScript(id, graceful), timeoutMs);
    return parseStatus(out.stdout);
  } catch {
    return null;
  }
}

export async function runBoxExec(
  command: string,
  deps: BoxExecDeps,
  opts: BoxExecOptions,
  signal: AbortSignal,
  onJob?: (id: string | null) => void,
): Promise<ExecOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const id = deps.newId();
  onJob?.(id);
  try {
    let first: BoxRun;
    try {
      first = await deps.run(startScript(id, command, opts), opts.firstWaitSec * 1000 + REQUEST_MARGIN_MS);
    } catch (error) {
      // the request may have started the job before it failed
      await stopBoxJob(deps, id, false);
      return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (/^EXEC_START_FAILED$/m.test(first.stdout)) {
      return { kind: "failed", detail: "the computer could not create the command's working folder" };
    }
    let status = parseStatus(first.stdout);
    if (status.state === "unknown") {
      await stopBoxJob(deps, id, false);
      return { kind: "failed", detail: first.stderr.slice(0, 300) || `exit ${first.exitCode ?? "unknown"}` };
    }
    let lastBytes = status.bytes;
    let lastCpu = status.cpu;
    let lastProgress = now();
    let failingSince: number | null = null;
    if (status.state === "running" && lastBytes > 0) deps.progress();
    while (status.state === "running") {
      if (signal.aborted) {
        await stopBoxJob(deps, id, false);
        return { kind: "stopped" };
      }
      const limit = commandSilenceMs(deps.turnSilenceMs());
      if (now() - lastProgress >= limit) {
        const final = await stopBoxJob(deps, id, true);
        return {
          kind: "silent",
          silentMs: limit,
          stdout: final?.stdout ?? "",
          stderr: final?.stderr ?? "",
          dropped: final?.dropped ?? false,
        };
      }
      // never wait past the silence limit inside one poll
      const waitSec = Math.max(1, Math.min(opts.pollSec, Math.floor((limit - (now() - lastProgress)) / 1000)));
      let out: BoxRun;
      try {
        out = await deps.run(pollScript(id, waitSec), waitSec * 1000 + REQUEST_MARGIN_MS, signal);
      } catch (error) {
        if (signal.aborted) continue;
        failingSince ??= now();
        // the box-side lease has stopped the job by now
        if (now() - failingSince >= opts.leaseSec * 1000) {
          return {
            kind: "failed",
            detail: `lost contact with the computer for ${Math.round(opts.leaseSec / 60) || 1} minutes, so the command was stopped (${error instanceof Error ? error.message : String(error)})`,
          };
        }
        await sleep(2_000, signal);
        continue;
      }
      const next = parseStatus(out.stdout);
      if (next.state === "unknown") {
        failingSince ??= now();
        if (now() - failingSince >= opts.leaseSec * 1000) {
          return { kind: "failed", detail: out.stderr.slice(0, 300) || `exit ${out.exitCode ?? "unknown"}` };
        }
        await sleep(2_000, signal);
        continue;
      }
      failingSince = null;
      if (next.state === "missing") {
        return { kind: "failed", detail: "the command's record disappeared from the computer (it may have restarted)" };
      }
      if (next.bytes !== lastBytes || next.cpu !== lastCpu) {
        lastBytes = next.bytes;
        lastCpu = next.cpu;
        lastProgress = now();
        deps.progress();
      }
      status = next;
    }
    if (status.state === "missing") {
      return { kind: "failed", detail: "the command's record disappeared from the computer (it may have restarted)" };
    }
    return { kind: "done", exitCode: status.exitCode, stdout: status.stdout, stderr: status.stderr, dropped: status.dropped };
  } finally {
    onJob?.(null);
  }
}
