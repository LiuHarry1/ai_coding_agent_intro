import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ensureAuth } from "./lib/auth.js";
import "./styles/index.css";

// When auth is enabled and there's no valid token, ensureAuth() redirects to
// the SSO login and returns false — we skip rendering to avoid a UI flash.
if (ensureAuth()) {
  createRoot(document.getElementById("root")).render(<App />);
}
