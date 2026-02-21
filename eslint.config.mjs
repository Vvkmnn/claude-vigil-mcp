// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // MCP servers use stdout for JSON-RPC — console.log corrupts the stream
      "no-console": ["error", { allow: ["error"] }],
      // Allow underscore-prefixed unused args (common in callbacks)
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Warn on missing return types — helps readability
      "@typescript-eslint/explicit-function-return-type": "warn",
      // Numbers and booleans are safe in template literals
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      // MCP SDK request handlers must be async per interface contract
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.js", "*.mjs"],
  },
);
