import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/chat": "http://localhost:4567",
      "/sessions": "http://localhost:4567",
      "/workspace": "http://localhost:4567",
      "/health": "http://localhost:4567",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
