import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";

export function conversationExportFilename(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
  return `conversation${slug ? `-${slug}` : ""}.md`;
}

/** Capture the selected task before awaiting authentication or download. */
export async function downloadConversation(threadId: string, title: string): Promise<string> {
  const filename = conversationExportFilename(title);
  await ensureDesktopSurfaceSecret();
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/export?format=markdown`, {
    headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() },
  });
  if (!response.ok) throw new Error(response.status === 404
    ? "This conversation is unavailable or you no longer have access."
    : "Could not export this conversation. Try again.");
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/markdown") {
    throw new Error("The server did not return a Markdown conversation.");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  try {
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return filename;
}
