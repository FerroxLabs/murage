import { api } from "@/state/store";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";

interface ExportedPlaybook {
  name: string;
  members: number;
  markdown: string;
}

function downloadPlaybook(playbook: ExportedPlaybook): { name: string; members: number } {
  const slug =
    playbook.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "botmrr-team";
  const blob = new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: playbook.name, members: playbook.members };
}

export interface TeamExportSelection { botIds: string[]; playbookKeys: string[]; routineIds: string[] }
export interface ZipExportSelection extends TeamExportSelection { skillIds: string[] }

/** Binary responses need the same desktop proof as api(), without its JSON
 * response parser. The reviewed name provides a portable local filename. */
export async function downloadSelectedBotPackageZip(
  selection: ZipExportSelection, previewHash: string, acknowledgeWarnings: boolean,
  reviewed: { name: string; members: number },
): Promise<{ name: string; members: number }> {
  await ensureDesktopSurfaceSecret();
  const response = await fetch("/api/packages/export", {
    method: "POST",
    headers: { "content-type": "application/json", "x-murage-surface": "desktop", ...desktopSurfaceHeaders() },
    body: JSON.stringify({ action: "download", selection, previewHash, acknowledgeWarnings }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? "Package download failed."), { status: response.status });
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/zip") throw new Error("The server did not return a ZIP package.");
  const blob = await response.blob();
  const slug = reviewed.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "murage-package";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = slug + ".zip";
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return reviewed;
}

/** Download only the exact selection whose preview the user reviewed. */
export async function downloadSelectedBotPackage(selection: TeamExportSelection, previewHash: string, acknowledgeWarnings: boolean): Promise<{ name: string; members: number }> {
  const playbook = (await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "package", action: "download", selection, previewHash, acknowledgeWarnings }),
  })) as ExportedPlaybook;
  return downloadPlaybook(playbook);
}
