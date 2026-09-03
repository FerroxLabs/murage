import { useCallback, useEffect, useState } from "react";

import {
  INSTALL_DISMISSED_KEY,
  installInvite,
  isAppleMobile,
  type InstallInvite,
} from "./install-prompt";

/** The event Chromium fires when a site is installable. Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const stored = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    // A private window, or site data blocked. Not remembering a dismissal is
    // a smaller failure than throwing during render.
    return false;
  }
};

const remember = (key: string) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* nothing to do; the invite simply returns next launch */
  }
};

const isStandalone = (): boolean => {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* matchMedia is absent in some embedded webviews */
  }
  // Safari's own, and the ONLY signal iOS gives about installation.
  return (navigator as { standalone?: boolean }).standalone === true;
};

/** Whether to invite this browser to install, and how.
 *
 * `beforeinstallprompt` is captured with `preventDefault()` so Chromium's own
 * banner is suppressed in favour of a button placed where it makes sense.
 * Once captured the event is single-use: after `prompt()` resolves it cannot
 * be replayed, so it is dropped and the invite goes away either way. */
export function useInstallPrompt(): {
  invite: InstallInvite;
  install: () => void;
  dismiss: () => void;
} {
  const [captured, setCaptured] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => stored(INSTALL_DISMISSED_KEY));
  const [standalone, setStandalone] = useState(() => isStandalone());

  useEffect(() => {
    const onBefore = (event: Event) => {
      event.preventDefault();
      setCaptured(event as BeforeInstallPromptEvent);
    };
    // Fires after a successful install, on the page that is about to be
    // replaced by the installed one. Clears the invite so it cannot linger.
    const onInstalled = () => {
      setCaptured(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBefore);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBefore);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    if (!captured) return;
    void captured.prompt().finally(() => setCaptured(null));
  }, [captured]);

  const dismiss = useCallback(() => {
    remember(INSTALL_DISMISSED_KEY);
    setDismissed(true);
  }, []);

  const invite = installInvite({
    standalone,
    secure: typeof window !== "undefined" && window.isSecureContext,
    captured: captured !== null,
    ios: isAppleMobile(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    dismissed,
  });

  return { invite, install, dismiss };
}
