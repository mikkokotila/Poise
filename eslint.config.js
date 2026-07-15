import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      '.playwright-mcp/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
  },
  {
    files: [
      'server/**/*.ts',
      'tests/**/*.ts',
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
  },
  {
    rules: {
      // Strict TypeScript already enforces unused declarations. Keeping this
      // single source of truth avoids duplicate diagnostics from two tools.
      '@typescript-eslint/no-unused-vars': 'off',
      // Boundary code narrows untyped CLI/API payloads at runtime; converting
      // every such value to unknown is a separate hardening change.
      '@typescript-eslint/no-explicit-any': 'off',
      // Keep this gate defect-oriented; declaration style is not a release risk.
      'prefer-const': 'off',
    },
  },
)
