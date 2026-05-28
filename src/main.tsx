import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PreviewAudioManager from "./PreviewAudioManager";

const showPreview = new URLSearchParams(window.location.search).has("preview");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {showPreview ? <PreviewAudioManager /> : <App />}
  </React.StrictMode>,
);
