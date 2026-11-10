import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import "../wm/wm.css";
import "./tray.css";
import { TrayPanel } from "./TrayPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TrayPanel />
  </StrictMode>,
);
