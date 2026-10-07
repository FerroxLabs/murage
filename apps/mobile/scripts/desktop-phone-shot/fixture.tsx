// The desktop's Settings, then "Phone and other devices", drawn on its own
// for desktop-phone-shot.mjs. Everything on it is made up: the bridge below is
// a stub, the code and the sign-in token are fake, the login is
// you@example.com and the address is an example name. Nothing here talks to a
// real Murage, a real sidecar or Tailscale; /api is refused before it leaves.
//
// ?state=on (default): on, remote access on, a code showing.
// ?state=off: off, before the switch. ?state=confirm: off, the switch pressed.
// ?theme=light|dark.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CompanionSection } from "@/components/CompanionSection";
import type { CompanionState } from "@/components/PhoneSetupFlow";
import { applySkin } from "@/lib/skins";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const mode = params.get("state") ?? "on";
applySkin(params.get("theme") === "light" ? "light" : "dark");

const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url, location.href).pathname.startsWith("/api")) return Promise.reject(new Error("fixture: no API"));
  return realFetch(input, init);
};

const host = "your-computer.example.ts.net";
const now = Date.now();
const on: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8811,
  devices: [
    { id: "example-phone", name: "Example phone", createdAt: now - 3 * 86_400_000, lastSeenAt: now - 20 * 60_000, cloudDesktopAccess: false },
  ],
  connectedDeviceIds: [],
  pairing: { code: "123456", token: `murage_pair_${"Example0".repeat(5)}Exa`, expiresAt: now + 10 * 60_000 },
  tailscale: host,
  tailnetLogin: "you@example.com",
  browser: { scheme: "https", host, port: 443 },
  remoteAccess: { on: true, desired: true, url: `https://${host}`, available: true, reason: null, problem: null },
};
const off: CompanionState = {
  ...on,
  enabled: false,
  pairing: null,
  browser: null,
  remoteAccess: { on: false, desired: false, url: null, available: true, reason: null, problem: null },
};
const state = mode === "on" ? on : off;
const answer = () => Promise.resolve(state);

(window as unknown as { muragebox: unknown }).muragebox = {
  companion: {
    state: answer, start: answer, stop: answer, keepAwake: answer, pairing: answer,
    cloudDesktop: answer, revoke: answer, refreshTailscale: answer, remoteAccess: answer,
  },
  companionAccount: {
    state: () => Promise.resolve({ available: false, status: "signed-out" }),
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-screen bg-app p-8">
      <div className="mx-auto max-w-[760px]" data-shot="page">
        <CompanionSection profileEmail="you@example.com" />
      </div>
    </div>
  </StrictMode>,
);

if (mode === "confirm") {
  const press = () => {
    const main = document.querySelector<HTMLButtonElement>('[aria-label^="Turn on:"]');
    if (main) main.click();
    else setTimeout(press, 50);
  };
  press();
}
