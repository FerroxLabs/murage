// Setting up a computer your bots can use, on your own machine.
//
// Not a wall of instructions: it looks at what you actually have and only
// tells you the next thing to do. Each step reports its own state, so a
// half-finished setup is obvious instead of mysterious.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Card, CommandLine } from "./SettingsModal";
import { cn } from "@/lib/cn";

interface Status {
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  image_ref: string;
  container_name: string;
  commands: Record<string, string>;
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col gap-2">{children}</div>}
      </div>
    </div>
  );
}

export function LocalComputerSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/local-computer")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);
  // while the user is following the steps in a terminal, keep up with them
  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const c = status?.commands ?? {};
  const ready = status?.container === "running";

  return (
    <>
      <Card
        title="A computer of its own"
        subtitle="Your bots can drive a Linux desktop running on this Mac — free, disposable, and separate from your own desktop and files. It runs in a container, so nothing it does touches your machine."
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
            )}
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : ready ? (
              <Check size={12} />
            ) : (
              <Circle size={9} />
            )}
            {loading ? "Checking…" : ready ? "Ready" : "Not set up yet"}
          </span>
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && (
            <a
              href={c.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised"
            >
              <ExternalLink size={12} /> Watch the screen
            </a>
          )}
        </div>
      </Card>

      <Card title="Setup" subtitle="Run these in Terminal. This panel notices when each step is done.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Any of these works — we use whichever you already have. <b className="text-ink">Colima</b> and{" "}
              <b className="text-ink">Podman</b> are free for everyone; Docker Desktop needs a paid licence for
              companies over 250 people or $10M revenue, and for government use.
            </div>
            <CommandLine command="brew install colima docker && colima start" />
          </Step>

          <Step
            n={2}
            title={
              status?.runtime && !status.daemonUp
                ? `Start ${status.runtime} — it's installed but not running`
                : "Start the runtime"
            }
            done={Boolean(status?.daemonUp)}
          >
            <CommandLine command="colima start" />
          </Step>

          <Step n={3} title="Download the desktop image (about 1 GB, once)" done={Boolean(status?.image)}>
            <CommandLine command={c.pull ?? ""} />
          </Step>

          <Step
            n={4}
            title={status?.container === "stopped" ? "Start the computer again" : "Start the computer"}
            done={status?.container === "running"}
          >
            <CommandLine command={status?.container === "stopped" ? (c.start ?? "") : (c.run ?? "")} />
          </Step>
        </div>
      </Card>

      {status && !status.runtime && (
        <Card title="">
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              No container runtime found on this machine yet. Step 1 installs one; everything after it is
              automatic.
            </span>
          </div>
        </Card>
      )}

      <Card
        title="What this is"
        subtitle={`The desktop image is ${status?.image_ref ?? "Anthropic's computer-use demo image"} — an MIT-licensed Linux desktop with a browser, a file manager and an editor, plus the tools a bot needs to see the screen and click. It runs as "${status?.container_name ?? "openmausbot-computer"}", and you can stop or delete it any time.`}
      >
        <div className="flex flex-col gap-2">
          <CommandLine command={c.stop ?? ""} />
          <CommandLine command={c.remove ?? ""} />
        </div>
      </Card>
    </>
  );
}
