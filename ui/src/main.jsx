import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "./theme.css";
import { DesktopChrome } from "./shell.jsx";

// Two surfaces, one bundle. "/" is the landing page; "/app" is the control
// plane. A node that serves the built UI answers both paths with index.html.
const Landing = lazy(() => import("./landing/Landing.jsx"));
const Dashboard = lazy(() => import("./app/Dashboard.jsx"));

function isDashboardPath(pathname) {
  const path = pathname.replace(/\/+$/, "");
  return path === "/app" || path.startsWith("/app/");
}

const Surface = isDashboardPath(window.location.pathname) ? Dashboard : Landing;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DesktopChrome />
    <Suspense fallback={null}>
      <Surface />
    </Suspense>
  </StrictMode>,
);
