import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import EqPopout from "./components/audio-manager/EqPopout";
import QuickPanel from "./components/audio-manager/QuickPanel";

const params = new URLSearchParams(window.location.search);
const eqTarget = params.get("eqTarget");
const isWidget = params.has("widget");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {eqTarget ? (
      <EqPopout target={eqTarget} />
    ) : isWidget ? (
      <QuickPanel />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
