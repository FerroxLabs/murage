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
 * page is running inside the Murage app, the door's sign-in page otherwise. */
export function afterSignOut(win: Window = window): void {
  const native = (win as Window & { murageNative?: { signOut?: () => unknown } }).murageNative;
  if (typeof native?.signOut === "function") {
    native.signOut();
    return;
  }
  win.location.replace("/");
}
