import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules are kept few and load-bearing. The ones enabled here catch the
 * mistakes that would actually matter in a system that deletes data: silently
 * discarded promises, unchecked errors, and unused code left behind.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.trueforge/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Node services, scripts and tests.
    files: ['packages/{erasure-mcp,server,shared}/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The console is a browser app.
    files: ['packages/console/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/console/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Scripts and tests are operator-facing or throwaway; console output is
    // the point in one and assertions carry the meaning in the other.
    files: ['scripts/**/*.mjs', 'packages/*/test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
