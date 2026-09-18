// Vite's `?raw` suffix hands back a module's bytes as a string instead of
// evaluating it. `vite/client` declares this for the app program, but
// tsconfig.server.json compiles with `types: ["node"]` only — and it DOES see
// this module, because server/provider-picker.test.ts imports
// provider-model-picker.ts, which imports model-metadata.ts. A triple-slash
// reference from that file pulls this declaration into whichever program is
// compiling it, so both agree.
declare module "*?raw" {
  const content: string;
  export default content;
}
