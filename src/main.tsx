import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    const textEntry = "input:not([type]), input[type='text'], input[type='search'], input[type='number'], textarea, [contenteditable='true']";
    if (!t?.closest(textEntry)) e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
