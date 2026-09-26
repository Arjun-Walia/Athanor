import { defineConfig } from "vitest/config";

// Unit tests for the UI. Pure logic (formatting, the demo checklist, event
// grouping, the API helpers, the break-it model) runs in Node; component
// tests opt into jsdom with a `@vitest-environment jsdom` comment.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{js,jsx}"],
  },
});
