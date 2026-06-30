import { AudioManager } from "./components/audio-manager";
import { MiniWindow } from "./components/audio-manager/MiniWindow";
import "./App.css";

/** The mini-controller pop-out loads the same bundle at the `#mini` route. */
const isMiniRoute =
  typeof window !== "undefined" &&
  window.location.hash.replace(/^#\/?/, "") === "mini";

export default function App() {
  if (isMiniRoute) return <MiniWindow />;
  return (
    <div className="app-root">
      <AudioManager />
    </div>
  );
}
