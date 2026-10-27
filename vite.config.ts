import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Static hosts return 404 when you refresh or go back to a deep link like /evaluations,
 * because no such file exists. Most of them (GitHub Pages, http-server, Netlify, …) serve
 * 404.html in that case, so ship a copy of index.html under that name and let the
 * client-side router pick the right page.
 */
function spaFallback(): Plugin {
  let outDir = "dist";
  return {
    name: "spa-fallback-404",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
    },
  };
}

export default defineConfig({
  // Changes on every build, so the app can tell when a new version is deployed.
  define: { __APP_BUILD__: JSON.stringify(String(Date.now())) },
  plugins: [react(), spaFallback()],
  server: {
    port: 5173,
  },
});
