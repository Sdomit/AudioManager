/**
 * Opens (or focuses) the always-on-top Quick Panel widget window.
 * Loads the same bundle with `?widget=1`; main.tsx routes to <QuickPanel>.
 */
export async function openQuickPanel(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("widget");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow("widget", {
    url: "index.html?widget=1",
    title: "AudioManager",
    width: 280,
    height: 390,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
  });
  win.once("tauri://error", (e) => {
    console.error("Quick panel error:", e);
  });
}
