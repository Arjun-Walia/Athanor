import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PORT is honoured so a launcher that hands out ports can run the dev
// server next to other projects; 5173 stays the default.
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort: false },
  preview: { port, strictPort: false },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the two surfaces in their own chunks so the landing page
        // never downloads the dashboard, and vice versa.
        manualChunks(id) {
          if (id.includes("/src/app/")) return "dashboard";
          if (id.includes("/src/landing/")) return "landing";
          return undefined;
        },
      },
    },
  },
});
