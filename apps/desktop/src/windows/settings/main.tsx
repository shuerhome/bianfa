// settings.html（label settings）?section=general|appearance|account|sync|data|about
import { ToastProvider } from "@bianfa/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "../../lib/bootstrap.js";
import { createQueryClient } from "../../lib/query.js";
import "../../styles/settings.css";
import { SettingsApp } from "./SettingsApp.js";

async function main() {
  await boot();
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section") ?? (window.location.hash ? window.location.hash.slice(1) : null);
  const root = createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>
          <SettingsApp initialSection={section} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void main();
