import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// Test fixtures only. src/styles.css starts with `@import "tailwindcss";`, which makes Tailwind scan the whole
// checkout for class names (about 300 MB of docs, skills library and server code) in every fixture's own Vite
// server; glibc keeps that native memory and a human-spec worker climbed to several GB. The fixtures only render
// the UI, so the scan is scoped to src and index.html. The app build (vite.config.ts) is untouched.
export const FIRST_LINE = '@import "tailwindcss";';
const SCOPED_FIRST_LINE = '@import "tailwindcss" source(none); @source "."; @source "../index.html";';

export function scopeStylesCss(code: string): string {
  return code.startsWith(FIRST_LINE) ? SCOPED_FIRST_LINE + code.slice(FIRST_LINE.length) : code;
}

const scopePlugin: Plugin = {
  name: "murage-e2e-scoped-tailwind-scan",
  enforce: "pre",
  transform(code, id) {
    const path = id.split("?")[0].replaceAll("\\", "/");
    if (!path.endsWith("/src/styles.css")) return null;
    return { code: scopeStylesCss(code), map: null };
  },
};

export default function scopedTailwind(): ReturnType<typeof tailwindcss> {
  return [scopePlugin, ...tailwindcss()] as ReturnType<typeof tailwindcss>;
}
