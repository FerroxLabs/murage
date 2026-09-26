import { callNative, nativeHas } from "./native-shell";
import { PAIR_AGAIN_PATH } from "./session-check";

/** "Sign out this device", from the device.
 *
 * Revokes the device on the computer (`DELETE /session/device`, answered by
 * the browser door), not only this browser's session: a phone that signs out
 * should stop counting toward the device cap and stop showing as paired.
 *
 * A 401 is success. It means this device is already not signed in, which is
 * the state the person asked for. */
export type RemoteSignOutResult = { ok: true } | { ok: false; error: string };

export async function signOutThisDevice(fetchImpl: typeof fetch = fetch): Promise<RemoteSignOutResult> {
  let res: Response;
  try {
    res = await fetchImpl("/session/device", { method: "DELETE", credentials: "same-origin" });
  } catch {
    return { ok: false, error: "Couldn't reach your computer. Check the connection and try again." };
  }
  if (res.ok || res.status === 401) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { ok: false, error: typeof body.error === "string" ? body.error : "Couldn't sign out. Try again." };
}

/** Where a signed-out device goes: the app's own re-pair screen when this
 * page is running inside the Murage app AND the hello()-negotiated bridge
 * actually lists `signOut` (an older app build may not), the door's own
 * sign-in page otherwise — also the fallback if the native call itself
 * rejects, since the device is signed out on the computer either way and the
 * person still needs somewhere to land. */
export async function afterSignOut(win: Window = window): Promise<void> {
  if (nativeHas("signOut")) {
    try {
      await callNative("signOut");
      return;
    } catch {
      // fall through to the browser's own sign-in page
    }
  }
  win.location.replace(PAIR_AGAIN_PATH);
}
