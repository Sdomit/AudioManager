/**
 * Detached EQ window launcher.
 *
 * Opens (or focuses) a separate OS window that renders just the EQ editor for
 * one input or bus. The window loads the same bundle with `?eqTarget=<kind>:<id>`;
 * `main.tsx` branches to `<EqPopout>` when that param is present. The Tauri API
 * is imported dynamically so this module stays out of the test/web bundle graph.
 */

/** `target` is `"input:<deviceId>"` or `"bus:<busId>"`. */
export async function openEqPopout(target: string, title: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = "eq-" + target.replace(/[^a-zA-Z0-9_-]/g, "_");

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const win = new WebviewWindow(label, {
    url: `index.html?eqTarget=${encodeURIComponent(target)}`,
    title,
    width: 760,
    height: 440,
    minWidth: 480,
    minHeight: 300,
    resizable: true,
  });
  win.once("tauri://error", (e) => {
    console.error("EQ pop-out window error:", e);
  });
}
