import { resolve } from "node:path";
import { defineConfig } from "vite";

// GitHub Pages serves the site under /owlbear-trilha/, and Owlbear joins manifest paths to the
// origin only — so every page and the manifest use that base, in dev too.
export default defineConfig({
  base: "/owlbear-trilha/",
  server: { port: 5174, cors: true },
  build: {
    rollupOptions: {
      input: {
        popover: resolve(import.meta.dirname, "index.html"),
        background: resolve(import.meta.dirname, "background.html"),
      },
    },
  },
});
