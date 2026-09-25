import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";
import { nativeAvailable } from "@/lib/native-shell";
import { saveBlob, saveUrl } from "@/lib/save-file";

export function conversationExportFilename(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
  return `conversation${slug ? `-${slug}` : ""}.md`;
}

/** Capture the selected task before awaiting authentication or download. */
export async function downloadConversation(threadId: string, title: string): Promise<string> {
  const filename = conversationExportFilename(title);
  const path = `/api/threads/${encodeURIComponent(threadId)}/export?format=markdown`;
  // The phone app downloads the route itself with the page's cookie; it
  // reports a refused or non-Markdown answer as a failed save.
  if (await nativeAvailable("saveFile")) {
    await saveUrl(path, filename);
    return filename;
  }
  await ensureDesktopSurfaceSecret();
  const response = await fetch(path, {
    headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() },
  });
  if (!response.ok) throw new Error(response.status === 404
    ? "This conversation is unavailable or you no longer have access."
    : "Could not export this conversation. Try again.");
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/markdown") {
    throw new Error("The server did not return a Markdown conversation.");
  }
  await saveBlob(await response.blob(), filename);
  return filename;
}
