import { useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";

/** A turn that ran with its folder's own files held back — the person said
 * "Don't trust", or nobody has decided yet and the engine asked on its own —
 * and which sources were left out; or a folder trusted after the engine had
 * already started, whose instructions apply from the next turn. Neutral,
 * like StoppedRow: not a tool run (so it stays visible with Settings → Tool
 * calls off) and not an error (FUIGOTRUST1).
 *
 * A withheld notice with a bot and conversation carries "Trust this folder":
 * it records the decision for this conversation's own folder, the way the
 * trust card does, so the next turn applies the folder's files. */
export function FolderTrustRow({ kind, sources, botId, threadId }: { kind: "withheld" | "late"; sources: string; botId?: string; threadId?: string }) {
  const withheld = kind === "withheld";
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const canTrust = withheld && Boolean(botId && threadId);
  const trust = async () => {
    setState("busy");
    try {
      await api("/api/folder-trust", { method: "POST", body: JSON.stringify({ bot: botId, thread: threadId }) });
      setState("done");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="folder-trust-row"
        data-folder-trust={kind}
        title={withheld ? t("folderTrust.withheldDescription") : t("folderTrust.lateDescription")}
        className={`${CHIP} text-ink-secondary`}
      >
        <span className="shrink-0" aria-hidden="true">
          {withheld ? <ShieldOff size={12} className="opacity-70" /> : <ShieldCheck size={12} className="opacity-70" />}
        </span>
        <span className={CHIP_NAME}>
          {withheld ? t("folderTrust.withheldLabel", { sources }) : t("folderTrust.lateLabel", { sources })}
        </span>
        {canTrust && state !== "done" && (
          <button
            type="button"
            data-testid="folder-trust-row-trust"
            onClick={() => void trust()}
            disabled={state === "busy"}
            className="shrink-0 rounded-md px-1.5 text-ink underline-offset-2 hover:underline disabled:opacity-50"
          >
            {t("folderTrust.trust")}
          </button>
        )}
        {canTrust && state === "done" && <span className="shrink-0" data-testid="folder-trust-row-done">{t("folderTrust.trustedNextTurn")}</span>}
        {canTrust && state === "error" && <span className="shrink-0 text-danger">{t("folderTrust.trustError")}</span>}
      </div>
    </div>
  );
}
