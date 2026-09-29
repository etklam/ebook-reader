// Lightweight L1 lint (dev-plan §22A): correctness-oriented typescript-eslint
// recommended only — no formatter opinions, no type-aware slow mode.
// NOTE: repo typechecks with TS 7 (tsgo) which typescript-eslint cannot use;
// the root devDep pins typescript 6 solely for eslint's parser (side-by-side
// install per TS 7 announcement). Packages keep their own typescript 7.0.2.
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'm0/**'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // dev scripts and tests import node builtins liberally
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // E2E tests and the placeholder admin UI assert loosely-typed JSON
    files: ['server/test/**/*.test.ts', 'apps/web/src/**/*.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
