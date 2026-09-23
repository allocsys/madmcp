import { defineConfig, configDefaults } from "vitest/config";

// worker/ is a separate Node project (its own package.json, its own
// dependencies like web-tree-sitter/simple-git, its own test runner --
// `node --test`, see worker/package.json's "test" script) that is NOT
// installed by the root `npm install`. Without this exclude, vitest's
// default test-file glob picks up worker/test/*.test.js anyway (they match
// **/*.test.js) and tries to run them under vitest with none of their
// actual dependencies present, and using node:test's describe/test instead
// of vitest's -- producing confusing "No test suite found" / "Cannot find
// package" failures that have nothing to do with the tests actually being
// broken. CI runs the worker's own test suite as a separate step
// (.github/workflows/ci.yml) after installing worker/'s own dependencies.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "worker/**"],
  },
});
