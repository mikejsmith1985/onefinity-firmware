import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "../resources/next", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/websocket": { target: "ws://localhost:8080", ws: true },
    },
  },
});
