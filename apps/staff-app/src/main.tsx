// Self-hosted Inter variable font (ADR 0021): Vite bundles the woff2 files same-origin.
import "@fontsource-variable/inter/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("staff-app: missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
