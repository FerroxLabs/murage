import { createRequire } from "node:module";

/** The pinned axe-core devDependency's browser bundle. MURAGE_AXE_SCRIPT may
 * name another readable copy for a one-off audit, never a required host path. */
export const axeScriptPath = process.env.MURAGE_AXE_SCRIPT ?? createRequire(import.meta.url).resolve("axe-core/axe.min.js");
