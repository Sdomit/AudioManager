import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Suppress the native WebView right-click menu (Back / Refresh / Save as /
// Print / Inspect). The app draws its own context menus; the browser one is
// never wanted. React onContextMenu handlers still fire — preventDefault only
// stops the native menu, not propagation.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
