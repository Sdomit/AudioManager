import { defineConfig } from "vite";

// Phone client build (#39-#45). Separate from the main Tauri frontend on
// purpose: outputs to dist-phone/, which src-tauri embeds via rust-embed and
// serves over the LAN HTTPS server. Debug desktop builds read dist-phone from
// disk, so `pnpm build:phone --watch` is the phone-client dev loop.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-phone",
    emptyOutDir: true,
    rollupOptions: {
      input: "phone.html",
    },
  },
});
