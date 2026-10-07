// Spec §3.5 "Tapping a notification": a notification for a removed computer
// is dropped with a toast. Native sends only a code; the words live here.
export const NOTICE_TEXT: Record<string, string> = {
  removedWorkspace: "That notification was for a computer that is no longer on this phone.",
};

export function noticeText(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(NOTICE_TEXT, code) ? NOTICE_TEXT[code] : null;
}

export function showNotice(root: HTMLElement, text: string): void {
  const toast = document.createElement("div");
  toast.className = "notice";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  root.append(toast);
  setTimeout(() => toast.remove(), 4000);
}
