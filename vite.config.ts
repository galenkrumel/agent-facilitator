import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// `agents()` also supplies the TC39 decorator transform that `@callable()`
// needs (Oxc does not support decorators yet), so no babel wiring here.
export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()]
});
