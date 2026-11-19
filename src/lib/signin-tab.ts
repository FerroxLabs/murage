// A browser blocks a tab that does not come from a click, and the vendor's link only arrives a moment after the click. So the
// click opens an empty tab first and the link is pointed at it when it arrives. No Cloud imports: the desktop does not use it
// (its main process opens the system browser), but nothing here depends on that.
let reserved: Window | null = null;

/** Call from the click itself, before anything is awaited. Returns whether a tab was opened. */
export function reserveSignInTab(open: (url: string, target: string) => Window | null = (url, target) => window.open(url, target)): boolean {
  if (reserved && !reserved.closed) return true;
  try {
    const tab = open("about:blank", "_blank");
    if (!tab) return false;
    try { tab.opener = null; tab.document.title = "Signing in..."; tab.document.body.textContent = "Opening your sign-in..."; } catch { /* cross origin already */ }
    reserved = tab;
    return true;
  } catch { return false; }
}

/** Point the reserved tab at `url`, or open a new tab. false when the browser blocked it. */
export function openSignInTab(url: string, open: (url: string, target: string) => Window | null = (target, name) => window.open(target, name)): boolean {
  const tab = reserved;
  reserved = null;
  if (tab && !tab.closed) { try { tab.location.href = url; return true; } catch { /* fall through to a new tab */ } }
  const fresh = open(url, "_blank");
  if (!fresh) return false;
  try { fresh.opener = null; } catch { /* cross origin already */ }
  return true;
}

/** Close an unused reserved tab (the sign-in was cancelled before a link came). */
export function releaseSignInTab(): void {
  const tab = reserved;
  reserved = null;
  if (tab && !tab.closed) { try { tab.close(); } catch { /* gone */ } }
}
