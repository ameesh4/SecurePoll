import { defineConfig } from "vitest/config";

// The LRS library is pure cryptography — no DOM, no React. A plain Node environment is
// all it needs, and keeping it out of jsdom keeps the suite fast and dependency-light.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The §5.5 round-trip test signs+verifies at every index of a 50-member ring; each
    // call runs O(n) RFC-9380 hash-to-curve operations, so the largest case needs headroom
    // beyond the 5s default. The real voting path signs once — this cost is test-only.
    testTimeout: 30000,
  },
});
