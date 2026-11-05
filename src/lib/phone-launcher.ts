// 1.0.16 F3: "Your computers", the way back from a phone workspace to the
// app's own list of computers. It exists only inside the Murage phone app,
// when this build lists `showLauncher`; the browser and the desktop app never
// show it. Pressing it asks the app to close the workspace and show the list,
// the same thing the home-screen "Switch computer" quick action does.
import { useEffect, useState } from "react";
import { callNative, inNativeShell, nativeAvailable } from "@/lib/native-shell";

export async function showYourComputers(): Promise<void> {
  try { await callNative("showLauncher"); } catch { /* an app that cannot show it leaves the workspace as it was */ }
}

/** True once the app has said it can show its computer list; false everywhere else. */
export function usePhoneLauncher(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!inNativeShell()) return;
    let active = true;
    nativeAvailable("showLauncher").then(
      (has) => { if (active) setAvailable(has); },
      () => { /* stays hidden */ },
    );
    return () => { active = false; };
  }, []);
  return available;
}
