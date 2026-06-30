import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Label of the always-on-top Mini Controller window. */
export const MINI_LABEL = "mini";

const MINI_OPTIONS = {
  url: "index.html#mini",
  title: "Mini Controller",
  width: 312,
  height: 384,
  resizable: false,
  decorations: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  center: true,
} as const;

/** Open (or re-focus) the mini-controller window. Idempotent. */
export async function openMiniWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(MINI_LABEL);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const w = new WebviewWindow(MINI_LABEL, MINI_OPTIONS);
  w.once("tauri://error", (e) => {
    console.error("mini window failed to open:", e);
  });
}

/** Show if hidden/absent, hide if visible — for the global hotkey (MC-4). */
export async function toggleMiniWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(MINI_LABEL);
  if (!existing) {
    await openMiniWindow();
    return;
  }
  if (await existing.isVisible()) {
    await existing.hide();
  } else {
    await existing.show();
    await existing.setFocus();
  }
}
