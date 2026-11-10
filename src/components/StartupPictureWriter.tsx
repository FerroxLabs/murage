// SPDX-License-Identifier: AGPL-3.0-or-later
// The cached start-up picture's writer (FIRSTRUN-1019 section 2.2, slice B). Mounted once in the app shell on the desktop app. When the
// Chief's name, colour, body or photo, or the first two teammates, change, it draws the Chief's REAL Ember face twice off screen (image A
// at rest, image B looking up, animation paused), serialises each as a standalone SVG, adds the next tip in the person's words and hands
// it to main (`startupPicture.save`), which validates it and keeps it for the next start's splash. Debounced 2 s, at most once a minute,
// never while the welcome is up (src/lib/startup-picture-schedule.ts). It draws nothing on screen.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useStore } from "@/state/store";
import { languageCode, localeVersion, subscribeLocale } from "@/lib/i18n";
import { isPhoneClient } from "@/lib/phone-client";
import { sanitizerReady } from "@/lib/trusted-html";
import { resourceNeedsTicket, ticketedResourceUrl } from "@/lib/live-events";
import { loadTipStrings } from "@/locales/startup-tips";
import { createPictureScheduler, pictureSignature } from "@/lib/startup-picture-schedule";
import {
  composeStartupPicture,
  downscalePhoto,
  scaleInBrowser,
  standaloneSvg,
  FACE_PX,
  type ComposeInput,
  type FaceBot,
  type FaceState,
} from "@/lib/startup-picture-compose";
import { rosterForTips, startupOs } from "@/lib/startup-tips";
import { EmberAvatar } from "./Avatar";
import type { EmberColor, EmberState } from "@/lib/mascot";

const FRAME_WAIT_MS = 400;

/** Wait for the avatar's paused face to be drawn: two animation frames, or a short timeout where frames do not run (a hidden window). */
function drawn(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_MS);
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
}

/** The real Ember component for this bot in this state, paused, serialised as a standalone SVG with every id prefixed. null when nothing drew. */
export async function renderMascotFace(bot: FaceBot, state: FaceState, prefix: string): Promise<string | null> {
  await sanitizerReady();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${FACE_PX}px;height:${FACE_PX}px;opacity:0;pointer-events:none;overflow:hidden`;
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(
      <EmberAvatar color={(bot.color ?? "orange") as EmberColor} body={bot.mascotBody} state={state as EmberState} size={FACE_PX} animated={false} trackPointer={false} label={bot.name} />,
    ));
    await drawn();
    const svg = host.querySelector("svg");
    return svg ? standaloneSvg(svg.outerHTML, prefix) : null;
  } finally {
    root.unmount();
    host.remove();
  }
}

const browserPhotoDeps = {
  // on the desktop an /api picture needs a single-use ticket, the same one <img> takes (src/components/DesktopImg.tsx)
  fetchImpl: async (url: string, init: RequestInit) => fetch(resourceNeedsTicket(url) ? await ticketedResourceUrl(url) : url, init),
  scale: scaleInBrowser,
};

export interface StartupPictureWriterDeps {
  /** `window.muragebox.startupPicture.save`: absent on a phone or browser, where nothing is written. */
  save?: (payload: unknown) => Promise<boolean>;
  /** The tip index this start showed, from main. */
  sessionTip?: () => Promise<number | null>;
  compose?: (input: ComposeInput) => Promise<unknown>;
}

function bridgeDeps(): StartupPictureWriterDeps {
  const bridge = typeof window === "undefined" ? undefined : window.muragebox?.startupPicture;
  return bridge ? { save: bridge.save, sessionTip: bridge.sessionTip } : {};
}

export function StartupPictureWriter({ chiefBotId, suspended, deps }: { chiefBotId: string | null; suspended: boolean; deps?: StartupPictureWriterDeps }): null {
  const { state } = useStore();
  useSyncExternalStore(subscribeLocale, localeVersion);
  const language = languageCode();
  const phoneAvailable = !isPhoneClient();
  const roster = useMemo(() => rosterForTips(state.bots as unknown as FaceBot[], chiefBotId), [state.bots, chiefBotId]);
  const wired = deps ?? bridgeDeps();
  const canWrite = typeof wired.save === "function";
  const signature = canWrite ? pictureSignature(roster as never, language, phoneAvailable) : null;

  const latest = useRef({ roster, language, phoneAvailable, wired });
  latest.current = { roster, language, phoneAvailable, wired };

  const scheduler = useRef<ReturnType<typeof createPictureScheduler> | null>(null);
  useEffect(() => {
    const created = createPictureScheduler({
      run: async (_signature, isCurrent) => {
        const { roster: current, language: lang, phoneAvailable: phone, wired: d } = latest.current;
        if (!d.save) return false;
        // A failed lookup is not "no picture yet": saving then would reset the saved rotation to the second tip. Skip this write; the
        // next change tries again.
        let sessionTip: number | null;
        try { sessionTip = await (d.sessionTip?.() ?? Promise.resolve(null)); } catch { return false; }
        if (!isCurrent()) return false;
        const input: ComposeInput = {
          roster: current,
          language: lang,
          os: startupOs(window.muragebox?.platform),
          phoneAvailable: phone,
          sessionTip: typeof sessionTip === "number" ? sessionTip : null,
          loadStrings: loadTipStrings,
          renderMascot: (bot, face) => renderMascotFace(bot, face, face === "idle" ? "fa" : "fb"),
          loadPhoto: (url) => downscalePhoto(url, browserPhotoDeps),
          now: Date.now,
        };
        const payload = await (d.compose ?? composeStartupPicture)(input);
        // changed, suspended (the welcome opened) or unmounted while composing: never save
        if (!payload || !isCurrent()) return false;
        return (await d.save(payload)) === true;
      },
    });
    scheduler.current = created;
    return () => { created.dispose(); scheduler.current = null; };
  }, []);
  useEffect(() => { scheduler.current?.update(signature, suspended); }, [signature, suspended]);
  return null;
}
