// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE WELCOME ("Ember pops in"). First thing a brand-new install paints, full window, above the main view: near-black
// (light theme #f7f7f8), the Murage logo, Ember popping up from behind the mark's lower left, two plain lines and one
// quiet button. No sound, no film, no loop. It waits for the person; Get started fades it out and the Chief's thread
// shows the hello card underneath.
//
//   reduced motion  the finished logo, Ember in place, no fade, no blink
//   keyboard        Get started is focused on arrival; Enter or Space presses it; Escape does nothing
//   offline         identical, nothing here needs the network
//
// Mounted once, in App.tsx, on a confirmed desktop only. The rule for when it shows is welcomeShouldShow.

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

import { useSetupView } from "@/components/FirstRunChrome";
import { APP_VERSION } from "@/lib/whats-new";
import {
  FIRST_RUN_WELCOME,
  WELCOME_FADE_MS,
  markWelcomeSeen,
  welcomeFootLine,
  welcomeSeen,
  welcomeShouldShow,
} from "@/lib/first-run-welcome";
import { STARTER_TEAM } from "@/lib/first-run-starter-team";
import { TeamFaces } from "./TeamFaces";
import { MurageLockup, useLightSkin, useLockupReducedMotion } from "./MurageLockup";

export function FirstRunWelcome() {
  const { view } = useSetupView();
  const light = useLightSkin();
  const [seen, setSeen] = useState(welcomeSeen);
  const [leaving, setLeaving] = useState(false);
  const still = useLockupReducedMotion();
  const button = useRef<HTMLButtonElement>(null);
  const show = welcomeShouldShow(view, seen);

  // The rule is the current one: if the view stops being a first run (or hello is answered) the welcome goes with it.
  const visible = show;

  useEffect(() => {
    if (visible) button.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      markWelcomeSeen();
      setSeen(true);
    }, WELCOME_FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (!visible) return null;

  const start = () => {
    if (leaving) return;
    markWelcomeSeen();
    if (still) {
      setSeen(true);
      return;
    }
    setLeaving(true);
  };

  const ground = light ? "#f7f7f8" : "#111111";
  const ink = light ? "#111111" : "#f4f4f5";
  const quiet = light ? "rgba(17,17,17,0.62)" : "rgba(244,244,245,0.62)";
  const foot = light ? "rgba(17,17,17,0.4)" : "rgba(244,244,245,0.4)";

  return (
    <div
      data-box-exempt="a full-window welcome screen, not a box over the app"
      className="first-run-welcome"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Murage"
      data-leaving={leaving ? "true" : "false"}
      onKeyDown={(event) => {
        // A full-window screen with one control: Tab stays on it, and Escape stops here so nothing behind it hears it.
        if (event.key === "Tab") {
          event.preventDefault();
          button.current?.focus();
        } else if (event.key === "Escape") {
          event.stopPropagation();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "56px 16px 40px",
        background: ground,
        color: ink,
        opacity: leaving ? 0 : 1,
        animation: still || leaving ? undefined : `first-run-welcome-in ${WELCOME_FADE_MS}ms ease-out both`,
        transition: still ? undefined : `opacity ${WELCOME_FADE_MS}ms ease-out`,
      }}
    >
      <div style={{ maxWidth: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
        <div style={{ maxWidth: "100%", overflow: "visible" }}>
          <MurageLockup size={84} mode="pop" className="first-run-welcome-logo" />
        </div>
        <TeamFaces members={STARTER_TEAM} label="Your starter team" quiet={quiet} />
        <p style={{ margin: 0, textAlign: "center", fontSize: 17, lineHeight: 1.55, color: quiet }}>
          {FIRST_RUN_WELCOME.lead}
          <br />
          {FIRST_RUN_WELCOME.line}
        </p>
        <button
          ref={button}
          type="button"
          onClick={start}
          onKeyDown={(event) => {
            // Enter and Space press it; every other key, Escape included, does nothing. start() is idempotent, so
            // the browser's own click that follows cannot press it twice.
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              start();
            }
          }}
          className="first-run-welcome-start"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 18px",
            border: 0,
            borderRadius: 999,
            background: "transparent",
            color: ink,
            fontSize: 15,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {FIRST_RUN_WELCOME.start}
          <ArrowRight size={16} color="#ff6b35" aria-hidden="true" />
        </button>
      </div>
      <p style={{ position: "absolute", bottom: 20, margin: 0, fontSize: 11, color: foot }}>{welcomeFootLine(APP_VERSION)}</p>
    </div>
  );
}
