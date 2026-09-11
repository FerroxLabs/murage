import { ShieldCheck, ShieldOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";

/** A turn that ran with its folder's own files held back — the person said
 * "Don't trust", or nobody has decided yet and the engine asked on its own —
 * and which sources were left out; or a folder trusted after the engine had
 * already started, whose instructions apply from the next turn. Neutral,
 * like StoppedRow: not a tool run (so it stays visible with Settings → Tool
 * calls off) and not an error (FUIGOTRUST1). */
export function FolderTrustRow({ kind, sources }: { kind: "withheld" | "late"; sources: string }) {
  const withheld = kind === "withheld";
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
      </div>
    </div>
  );
}
