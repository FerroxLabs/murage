import { defineConfig } from "vite";

// base "./": Capacitor serves the launcher from capacitor://localhost (iOS)
// and https://localhost (Android), never from a path of our choosing.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
