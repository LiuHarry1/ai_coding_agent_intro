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
      "/slash-commands": "http://localhost:4567",
      "/plan": "http://localhost:4567",
      "/session": "http://localhost:4567",
      "/settings": "http://localhost:4567",
      "/mcp": "http://localhost:4567",
      "/ask_user_question": "http://localhost:4567",
      "/skills": "http://localhost:4567",
      "/agents": "http://localhost:4567",
      // SSO mode (dev): forward auth-service routes to localhost:8010.
      // Override the target with DEV_AUTH_BACKEND_URL if it runs elsewhere.
      "/sso": process.env.DEV_AUTH_BACKEND_URL || "http://localhost:8010",
      "/api/auth": process.env.DEV_AUTH_BACKEND_URL || "http://localhost:8010",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Push heavy markdown / syntax-highlight deps into their own vendor
    // chunk so MessageBubble itself stays small. highlight.js (pulled in
    // by rehype-highlight) is what bloated the bundle past 500 kB.
    rollupOptions: {
      output: {
        manualChunks: {
          "markdown-vendor": [
            "react-markdown",
            "remark-gfm",
            "rehype-highlight",
          ],
        },
      },
    },
  },
});
