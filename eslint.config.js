/**
 * ESLint for the server (src/) and its tests (test/), with type information. Unused arguments and rest siblings
 * named with a leading _ are allowed, as TypeScript's noUnused* checks do. The promise rules matter more here than
 * anywhere: a child process or a file write whose promise nobody awaits loses its error, and a lost error in a task
 * supervisor is a task stuck in "running" forever.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", "node_modules", "coverage", ".local", ".relay-bridge", ".claude"]),
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Test doubles keep the async signature of what they stand in for, and Vitest types its asymmetric matchers
    // (expect.any, objectContaining…) as any: the no-unsafe-* rules would flag the framework, not the code under test.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
]);
