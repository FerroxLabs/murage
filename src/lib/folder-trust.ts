// The renderer's reading of a folder-trust notice (shared/folder-trust.ts):
// the transcripts render it as FolderTrustRow, and every one-line surface
// (sidebar preview, timeline) spells it "Folder not trusted — …" rather than
// the raw prefix. Same pattern as src/lib/host-stop.ts.
import { t } from "@/lib/i18n";
import { folderTrustNotice } from "../../shared/folder-trust.ts";

export { folderTrustNotice };

/** "Folder not trusted — <sources> left out" / "Folder trusted — <sources>
 * apply in a new conversation"; undefined for any other activity name. */
export function folderTrustLabel(name: string | undefined | null): string | undefined {
  const notice = folderTrustNotice(name);
  if (!notice) return undefined;
  if (notice.kind === "passed") return t("folderTrust.passedLabel", { key: notice.key! });
  if (notice.kind === "storedNo") return t("folderTrust.storedNoLabel");
  if (notice.kind === "chosen") return t("folderTrust.chosenLabel", { sources: notice.sources });
  if (notice.kind === "late") return t("folderTrust.lateLabel", { sources: notice.sources });
  const withheld = t("folderTrust.withheldLabel", { sources: notice.sources });
  return notice.key ? `${withheld} ${t("folderTrust.forgetToAsk", { key: notice.key })}` : withheld;
}
