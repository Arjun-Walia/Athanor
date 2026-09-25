import { defineConfig } from "vitest/config";

// Unit tests for the pure parts of the UI: formatting, the demo checklist
// and event grouping, the API helpers, and the break-it model. Nothing
// here needs a DOM, so the tests run in Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
