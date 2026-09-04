import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles.css";
import "./features/auth/owner-recovery.css";
import "./features/navigation/product-shell.css";
import "./visual-system.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
