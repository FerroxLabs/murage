// WHEN THE ENGINE DIES, SAY SO.
//
// THE DEFECT THIS EXISTS FOR. On 2026-09-22 the server child crashed at
// 02:58:16Z. The window stayed open, every control still drew, and nothing
// anywhere said the engine was gone. From inside the app a dead server is
// indistinguishable from a dozen broken features: bots stop mid-turn, memory
// stops answering, tools go quiet, the browser reports itself unavailable,
// connected apps vanish, the phone cannot reconnect, and a new message reports
// that it could not be queued.
//
// The owner and his Chief of Staff spent an hour diagnosing NINE subsystems.
// There was one fault. This banner is the sentence that would have ended that
// hour in two seconds.
//
// It is deliberately not dismissible while the engine is down. A notice you
// can wave away is a notice that will be waved away, and the one thing worse
// than an app that has silently stopped working is an app that told you once.
import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";

/** What the main process reports on `server-lifecycle:state`. */
export type ServerLifecycle = {
  state: "running" | "restarting" | "failed";
  since: number | null;
  attempt: number;
};

/** Subscribes while mounted. No bridge (browser, dev, companion) means no
 *  desktop server to report on, so this renders nothing at all. */
export function useServerLifecycle(): ServerLifecycle | null {
  const [lifecycle, setLifecycle] = useState<ServerLifecycle | null>(null);
  useEffect(() => {
    const subscribe = window.muragebox?.onServerLifecycle;
    if (!subscribe) return;
    return subscribe((next: ServerLifecycle) => setLifecycle(next));
  }, []);
  return lifecycle;
}

/**
 * What to say, if anything. Kept out of the component so it can be tested
 * without a bridge, a window or a render.
 *
 * "running" says NOTHING. A banner that is always there is furniture, and
 * furniture is not read.
 */
export function serverLifecycleNotice(
  lifecycle: ServerLifecycle | null,
): { tone: "working" | "stopped"; text: string } | null {
  if (!lifecycle || lifecycle.state === "running") return null;
  if (lifecycle.state === "restarting") {
    return {
      tone: "working",
      // "Murage", not "the server": they did not install a server. And it says
      // what happens to their work, because that is the actual question.
      text: "Murage stopped unexpectedly and is starting again. Your bots will pick up where they left off.",
    };
  }
  return {
    tone: "stopped",
    // NOT "tell Sean". This banner shipped naming the owner, which is fine on
    // exactly one machine and meaningless on every other: a team member
    // reading it has no idea who that is, and the app has channels and teams
    // in it precisely so that other people use it. It names the log instead,
    // which is true wherever it is read and is the thing whoever helps will
    // actually want.
    text: "Murage has stopped and could not restart itself. Quit and open it again. If it keeps happening, the reason is in Library/Logs/murage/server.log.",
  };
}

export function ServerLifecycleBanner() {
  const notice = serverLifecycleNotice(useServerLifecycle());
  if (!notice) return null;

  const restarting = notice.tone === "working";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`flex items-center justify-center gap-2 px-4 py-2 text-[13px] font-medium ${
        restarting ? "bg-accent text-white" : "bg-danger text-white"
      }`}
    >
      {restarting
        ? <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
        : <PlugZap size={14} className="shrink-0" aria-hidden="true" />}
      <span>{notice.text}</span>
    </div>
  );
}
