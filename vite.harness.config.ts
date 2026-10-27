import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

// Same app, with the Owlbear SDK swapped for test/fake-obr.ts: open test/harness.html?role=GM and ?role=PLAYER.
export default mergeConfig(base, defineConfig({
  server: { port: 5175 },
  resolve: { alias: { "@owlbear-rodeo/sdk": resolve(import.meta.dirname, "test/fake-obr.ts") } },
}));
