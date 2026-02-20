import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      // stdout is JSON-RPC in MCP servers — no console except console.error
      'no-console': ['error', { allow: ['error'] }],

      // MCP handlers must be async even if body is synchronous
      '@typescript-eslint/require-await': 'off',

      // Useful but too noisy for initial adoption — warn only
      '@typescript-eslint/explicit-function-return-type': 'warn',

      // Allow numbers and booleans in template literals
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],

      // Already enforced by tsconfig strict
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'eslint.config.mjs'],
  },
);
