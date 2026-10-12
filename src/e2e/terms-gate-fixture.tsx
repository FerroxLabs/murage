// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page terms-gate.human.spec.ts drives: the real TermsGate over a stand-in
// app. `@/state/store` is aliased by the spec to a store whose `api` calls
// window.__termsRequest, which the spec scripts (answer, fail, slow).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TermsGate } from "@/components/TermsGate";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.skin = params.get("skin") ?? "dark";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TermsGate><div data-app className="p-8 text-ink">The app behind the gate.</div></TermsGate>
  </StrictMode>,
);
