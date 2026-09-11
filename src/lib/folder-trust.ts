// The renderer's reading of a folder-trust notice (shared/folder-trust.ts):
// the transcripts render it as FolderTrustRow, and every one-line surface
// (sidebar preview, timeline) spells it "Folder not trusted — …" rather than
// the raw prefix. Same pattern as src/lib/host-stop.ts.
import { t } from "@/lib/i18n";
import { folderTrustNotice } from "../../shared/folder-trust.ts";

export { folderTrustNotice };

/** "Folder not trusted — <sources> left out" / "Folder trusted — <sources>
 * apply from the next turn"; undefined for any other activity name. */
export function folderTrustLabel(name: string | undefined | null): string | undefined {
  const notice = folderTrustNotice(name);
  if (!notice) return undefined;
  return notice.kind === "withheld"
    ? t("folderTrust.withheldLabel", { sources: notice.sources })
    : t("folderTrust.lateLabel", { sources: notice.sources });
}
