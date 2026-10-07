// Cold-start timing marks, behind MURAGE_TURN_TRACE=1 like the turn trace
// (./turn-trace.ts) and memory/claim-trace.ts. Off, a mark is one environment
// read. `ms` is milliseconds since this process started, so the gap between two
// marks is the cost of the step between them. Fixed step names, never data.
import { turnTraceEnabled } from "./turn-trace.ts";

type Sink = (line: string) => void;
const defaultSink: Sink = line => console.log(line);

// The desktop splash's progress bar follows these real stages. Always on (not
// only under the trace), and only when there is a parent to tell: Electron's
// utility parentPort, or an IPC channel on a desktop-parent fork.
const STAGES = new Set(["module.loaded", "database.open", "store.ready", "skillSweep.done", "listen"]);
type Notify = (message: { type: "startup-stage"; stage: string; ms: number }) => void;
function parentNotify(): Notify | undefined {
  const proc = process as NodeJS.Process & { parentPort?: { postMessage(message: object): void } };
  if (proc.parentPort) return message => proc.parentPort!.postMessage(message);
  if (process.env.MURAGE_DESKTOP_PARENT === "1" && typeof process.send === "function") return message => { process.send!(message); };
  return undefined;
}
export function startupMark(step: string, sink: Sink = defaultSink, now: () => number = () => performance.now(), notify: Notify | undefined = parentNotify()): void {
  if (notify && STAGES.has(step)) { try { notify({ type: "startup-stage", stage: step, ms: Math.round(now()) }); } catch { /* a progress bar never breaks startup */ } }
  if (!turnTraceEnabled()) return;
  sink(`[turn-trace] phase=startup.${step} ms=${Math.round(now())}`);
}
