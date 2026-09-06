// index.html（label main）?section=notes|trash|team
import { ToastProvider } from "@bianfa/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "../../lib/bootstrap.js";
import { createQueryClient } from "../../lib/query.js";
import "../../styles/main.css";
import { MainApp } from "./MainApp.js";

async function main() {
  await boot();
  const section = new URLSearchParams(window.location.search).get("section");
  const root = createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>
          <MainApp initialSection={section} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void main();
