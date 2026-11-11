import { readClientSession, readLabels } from "../csrf.ts";

interface AvatarLabels {
  readonly invalid: string;
  readonly tooLarge: string;
  readonly blocked: string;
  readonly notAllowed: string;
  readonly failed: string;
}

const labels = readLabels<AvatarLabels>("account-avatar-labels");
const fileInput = document.querySelector<HTMLInputElement>("[data-avatar-file]");
const canvas = document.querySelector<HTMLCanvasElement>("[data-avatar-canvas]");
const zoom = document.querySelector<HTMLInputElement>("[data-avatar-zoom]");
const editor = document.querySelector<HTMLElement>("[data-avatar-editor]");
const save = document.querySelector<HTMLButtonElement>("[data-avatar-save]");
const remove = document.querySelector<HTMLButtonElement>("[data-avatar-remove]");
const error = document.querySelector<HTMLElement>("[data-avatar-error]");

let image: HTMLImageElement | null = null;

function messageFor(code: string | undefined): string {
  switch (code) {
    case "avatar_too_large":
      return labels?.tooLarge ?? "";
    case "avatar_blocked":
      return labels?.blocked ?? "";
    case "avatar_not_allowed":
      return labels?.notAllowed ?? "";
    case "avatar_invalid":
      return labels?.invalid ?? "";
    default:
      return labels?.failed ?? "";
  }
}

function showError(text: string): void {
  if (error !== null) {
    error.textContent = text;
    error.hidden = text === "";
  }
}

/** Draws the centred square crop at the selected zoom: 1 = whole image, 3 = centre third. */
function draw(): void {
  if (image === null || canvas === null) {
    return;
  }

  const context = canvas.getContext("2d");

  if (context === null) {
    return;
  }

  const zoomValue = Math.min(Math.max(Number(zoom?.value ?? "1"), 1), 3);
  const sourceEdge = Math.min(image.naturalWidth, image.naturalHeight) / zoomValue;
  const sourceX = (image.naturalWidth - sourceEdge) / 2;
  const sourceY = (image.naturalHeight - sourceEdge) / 2;
  const maxWidth = Number(editor?.dataset.avatarMaxWidth ?? "256");
  const maxHeight = Number(editor?.dataset.avatarMaxHeight ?? "256");
  const outputEdge = Math.max(
    1,
    Math.min(
      256,
      Number.isFinite(maxWidth) ? maxWidth : 256,
      Number.isFinite(maxHeight) ? maxHeight : 256,
    ),
  );

  canvas.width = outputEdge;
  canvas.height = outputEdge;
  context.clearRect(0, 0, outputEdge, outputEdge);
  context.drawImage(image, sourceX, sourceY, sourceEdge, sourceEdge, 0, 0, outputEdge, outputEdge);
}

function loadFile(file: File): void {
  if (file.size > 10 * 1024 * 1024) {
    showError(labels?.tooLarge ?? "");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const next = new Image();
    next.onload = () => {
      image = next;
      draw();
      if (canvas !== null) {
        canvas.hidden = false;
      }
      if (zoom !== null) {
        zoom.disabled = false;
      }
      if (save !== null) {
        save.disabled = false;
      }
      showError("");
    };
    next.onerror = () => showError(labels?.invalid ?? "");
    next.src = String(reader.result ?? "");
  };
  reader.onerror = () => showError(labels?.invalid ?? "");
  reader.readAsDataURL(file);
}

function loadSelectedFile(): void {
  const file = fileInput?.files?.[0];

  if (file !== undefined) {
    loadFile(file);
  }
}

fileInput?.addEventListener("change", loadSelectedFile);

// The island is a deferred module: a file can be chosen (and `change` fire) before it runs, so
// pick up a selection that arrived early instead of dropping it and leaving Save disabled.
loadSelectedFile();

zoom?.addEventListener("input", draw);

save?.addEventListener("click", () => {
  if (canvas === null || save === null) {
    return;
  }

  save.disabled = true;
  showError("");
  const data = canvas.toDataURL("image/webp", 0.9);

  void readClientSession()
    .then(async (session) => {
      if (!session.authenticated || session.csrfToken === null) {
        window.location.assign(`/auth/login?return_to=${encodeURIComponent("/account")}`);
        return;
      }

      const response = await fetch("/api/me/avatar", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": session.csrfToken,
        },
        body: JSON.stringify({ imageBase64: data.split(",")[1] ?? "" }),
      });

      if (response.ok) {
        window.location.reload();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as { readonly code?: string };
      showError(messageFor(body.code));
      save.disabled = false;
    })
    .catch(() => {
      showError(labels?.failed ?? "");
      save.disabled = false;
    });
});

remove?.addEventListener("click", () => {
  if (remove === null) {
    return;
  }

  remove.disabled = true;
  showError("");

  void readClientSession()
    .then(async (session) => {
      if (!session.authenticated || session.csrfToken === null) {
        window.location.assign(`/auth/login?return_to=${encodeURIComponent("/account")}`);
        return;
      }

      const response = await fetch("/api/me/avatar/remove", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": session.csrfToken,
        },
        body: "{}",
      });

      if (response.ok) {
        window.location.reload();
        return;
      }

      remove.disabled = false;
      showError(labels?.failed ?? "");
    })
    .catch(() => {
      remove.disabled = false;
      showError(labels?.failed ?? "");
    });
});
