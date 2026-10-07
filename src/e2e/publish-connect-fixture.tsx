// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page publish-connect.human.spec.ts draws: the Connect Netlify card in
// each of its steps, and the "Sites this bot published" list with Add an
// existing site and a site that needs attention. Static views only; nothing
// here talks to a harness. `@/state/store` is aliased by the spec to a stub.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectNetlifyView, PublishedSitesView, type ConnectNetlifyViewProps, type SiteRow } from "@/components/PublishCard";
import "@/styles.css";

const noop = () => {};
const Frame = ({ name, children }: { name: string; children: ReactNode }) => <section data-shot={name} className="flex flex-col gap-1"><div className="text-[12px] text-ink-secondary">{name}</div>{children}</section>;
const connect = (name: string, extra: Partial<ConnectNetlifyViewProps>) => (
  <Frame name={name}><ConnectNetlifyView state="needed" desktop step="start" shell onSignIn={noop} onUseToken={noop} onBack={noop} onSaveToken={noop} onOpenPage={noop} {...extra} /></Frame>
);
const sites: SiteRow[] = [
  { siteId: "a1", name: "my-shop", url: "https://my-shop.netlify.app", lastPublishedAt: Date.UTC(2026, 9, 3), lastFileCount: 12, origin: "created" },
  { siteId: "b2", name: "quiz", url: "https://quiz-night.netlify.app", lastPublishedAt: 0, lastFileCount: 0, origin: "created", needsAttention: true },
];

function Gallery() {
  return (
    <div className="flex min-h-screen flex-col gap-6 bg-app p-4 text-ink sm:p-8">
      {connect("connect-start", {})}
      {connect("connect-signing-in", { step: "signing-in" })}
      {connect("connect-token-after-sign-in", { step: "token", why: "sign-in-not-enough" })}
      {connect("connect-token-rejected", { step: "token", why: "token-rejected", error: undefined })}
      {connect("connect-no-shell", { step: "token", shell: false, why: "no-shell" })}
      {connect("connect-connected", { state: "connected" })}
      {connect("connect-phone", { desktop: false })}
      <Frame name="sites-add-and-attention"><PublishedSitesView botName="Mira" sites={sites} desktop onAdd={noop} onOpen={noop} onAsk={noop} /></Frame>
      <Frame name="sites-add-error"><PublishedSitesView botName="Mira" sites={[]} desktop onAdd={noop} addError="Netlify has no site with that address in your account. Check it and try again." /></Frame>
    </div>
  );
}

document.documentElement.dataset.skin = new URLSearchParams(location.search).get("skin") ?? "dark";
createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
