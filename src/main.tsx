import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, readPreference, resolveSkin, watchSystemSkin } from "./lib/skins";
import "./styles.css";

// index.html has already stamped the palette before the stylesheet resolved;
// this repeats it because that inline copy cannot run the migration's storage
// rewrite, and because a browser build without the inline script must still be
// correct before the first React paint.
applySkin(resolveSkin(readPreference()));

// Module scope, not a component: on "auto" the theme must keep tracking the OS
// whether or not Settings is mounted. The handler re-reads the preference, so
// this listener can never override an explicit choice.
watchSystemSkin(applySkin);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
