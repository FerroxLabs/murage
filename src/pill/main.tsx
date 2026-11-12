// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRoot } from "react-dom/client";
import { bootLocaleReady, t } from "@/lib/i18n";
import "../styles.css";
import { Pill } from "./Pill";

const theme = window.matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => { document.documentElement.dataset.skin = theme.matches ? "light" : "dark"; };
applyTheme();
theme.addEventListener("change", applyTheme);
void bootLocaleReady.then(() => {
  document.title = t("pill.title");
  createRoot(document.getElementById("root")!).render(<Pill />);
});
