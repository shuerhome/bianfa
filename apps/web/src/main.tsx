import { ensureIconSprite, ToastProvider } from "@bianfa/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initI18n } from "./i18n.js";
import "./styles/web.css";

ensureIconSprite();
initI18n();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
