import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "coverage/**",
      "**/node_modules/**",
      ".runstage-gate-data/**",
      // Compiled-entry stubs are plain Node ESM, not type-checked TS.
      "packages/*/bin/**",
      "apps/*/bin/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Modest defaults: allow the `_unused` convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Don't churn existing catch-and-rethrow sites (another branch hardens some of these files).
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["**/*.test.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["apps/history/src/auth.ts"],
    rules: {
      // safeNext() intentionally rejects control characters in redirect targets.
      "no-control-regex": "off",
    },
  },
);
