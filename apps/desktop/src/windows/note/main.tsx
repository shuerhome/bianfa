// note.html?id=<uuid>&fresh=1&color=citron
import { isNoteColor, isUuid, type NoteColor } from "@bianfa/shared";
import { ToastProvider } from "@bianfa/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "../../lib/bootstrap.js";
import { createQueryClient } from "../../lib/query.js";
import "../../styles/note.css";
import { NoteApp } from "./NoteApp.js";

const params = new URLSearchParams(window.location.search);
const noteId = params.get("id") ?? "";
const fresh = params.get("fresh") === "1";
const colorParam = params.get("color");
const initialColor: NoteColor | undefined = colorParam && isNoteColor(colorParam) ? colorParam : undefined;

async function main() {
  const { settings } = await boot();
  if (settings.desktopPinReadonly) document.documentElement.dataset.desktopPinReadonly = "1";
  const root = createRoot(document.getElementById("root") as HTMLElement);
  const client = createQueryClient();
  root.render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ToastProvider>
          {isUuid(noteId) ? (
            <NoteApp noteId={noteId} fresh={fresh} initialColor={initialColor} />
          ) : (
            <div className="note-error" role="alert">
              missing ?id=&lt;uuid&gt;
            </div>
          )}
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void main();
