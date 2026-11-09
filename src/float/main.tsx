// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRoot } from "react-dom/client";
import { bootLocaleReady, t } from "@/lib/i18n";
import { Bubble } from "./Bubble";
import { Dock } from "./Dock";
import "../styles.css";
import "./float.css";

const theme = window.matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => { document.documentElement.dataset.skin = theme.matches ? "light" : "dark"; };
applyTheme(); theme.addEventListener("change", applyTheme);
void bootLocaleReady.then(() => {
  const kind = document.documentElement.dataset.floatKind;
  if (kind !== "bubble" && kind !== "dock") return;
  document.title = t(kind === "bubble" ? "float.bubble" : "float.dock");
  createRoot(document.getElementById("root")!).render(kind === "bubble" ? <Bubble /> : <Dock />);
});
