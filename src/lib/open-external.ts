// Leaving the page, on each surface.
//
//   desktop  window.muragebox.openExternal — the system browser, via Electron.
//   phone    murageNative.openExternal — the system browser, via the app.
//            The workspace WebView has no tabs: window.open answers null and
//            a target=_blank link does nothing at all (spec §3.2, §3.6).
//   browser  a blank tab opened FIRST, then navigated, so the OAuth origin
//            never receives an opener reference while a real null still
//            means "blocked" (unchanged from ConnectorCard and PluginsPanel).
import { callNative, nativeHas } from "./native-shell";
import { reportSaveFailure, saveSource, saveUrl } from "./save-file";

/** `nativeHas` is synchronous on purpose: this runs inside a click, and a
 * browser only lets a tab open during the gesture that asked for it. The
 * feature list is fetched at boot (main.tsx), long before the first tap. */
export async function openExternalPage(url: string, blockedMessage: string): Promise<void> {
  if (window.muragebox?.openExternal) {
    await window.muragebox.openExternal(url);
    return;
  }
  if (nativeHas("openExternal")) {
    await callNative("openExternal", url);
    return;
  }
  const opened = window.open("", "_blank");
  if (!opened) throw new Error(blockedMessage);
  opened.opener = null;
  opened.location.replace(url);
}

export type NativeClick = { kind: "save"; url: string; filename: string } | { kind: "external"; url: string } | null;

function nameFromPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split("/").pop() ?? "") || "download";
  } catch {
    return "download";
  }
}

/** What the phone app should do with a click on this anchor, if anything.
 *
 * A same-origin target=_blank link is deliberately left alone: the system
 * browser has no session cookie, so sending it there would land on the
 * sign-in page. Native keeps same-origin navigation inside the WebView. */
export function nativeClickAction(
  anchor: { href: string; target: string; hasDownload: boolean; download: string },
  pageOrigin: string,
): NativeClick {
  let url: URL;
  try {
    url = new URL(anchor.href, pageOrigin);
  } catch {
    return null;
  }
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (anchor.hasDownload) {
    // Native downloads only what this page or its own server holds (M2). A
    // download link to another site is a page in the system browser.
    const source = saveSource(url.href, pageOrigin);
    if (source !== "external") return { kind: "save", url: url.href, filename: anchor.download || nameFromPath(url) };
    return web ? { kind: "external", url: url.href } : null;
  }
  if (anchor.target !== "_blank") return null;
  if (!web) return null;
  return url.origin === pageOrigin ? null : { kind: "external", url: url.href };
}

/** `saveUrl` re-checks native availability itself (spec-correct for a call
 * with no other context) before it will touch its blob:/data: branch, which
 * reads the bytes here because native cannot. This click already ran that
 * same check via `nativeHas` a line above; only the blob:/data: branch is
 * still needed from `saveUrl`, so a server URL (the only other kind
 * `nativeClickAction` saves) skips straight to the native call. */
function saveDownload(url: string, filename: string, pageOrigin: string): Promise<unknown> {
  if (saveSource(url, pageOrigin) === "page") return saveUrl(url, filename);
  return callNative("saveFile", { kind: "url", url, filename });
}

/** One listener for every anchor in the app, instead of an edit per link.
 *
 * Bubble phase on the document, so it runs AFTER React's own handlers: a
 * component that handled the click itself (MediaPlayer renews an expired
 * download link and saves through that) has already called preventDefault,
 * and is left alone. */
export function routeNativeClicks(
  doc: Pick<Document, "addEventListener" | "removeEventListener"> = document,
  pageOrigin: string = globalThis.location?.origin ?? "",
): () => void {
  const onClick = (event: Event) => {
    const mouse = event as MouseEvent;
    if (mouse.defaultPrevented || mouse.button !== 0) return;
    const anchor = (mouse.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const action = nativeClickAction(
      { href: anchor.href, target: anchor.target, hasDownload: anchor.hasAttribute("download"), download: anchor.getAttribute("download") ?? "" },
      pageOrigin,
    );
    if (!action) return;
    if (action.kind === "save" ? !nativeHas("saveFile") : !nativeHas("openExternal")) return;
    mouse.preventDefault();
    if (action.kind === "save") {
      void saveDownload(action.url, action.filename, pageOrigin).catch(reportSaveFailure);
      return;
    }
    void callNative("openExternal", action.url).catch((error) => console.warn("murage: the phone app could not finish that", error));
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
