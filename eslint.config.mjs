import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Type-unaware linting on purpose: `npm run typecheck` already runs `tsc` over
 * both projects, so duplicating that here would only make `npm run lint` slower
 * without catching anything new.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Strapi's own runtime types are loose in places (`strapi.getModel`,
      // middleware contexts), and a hard ban would only push the same looseness
      // into casts that read worse. The plugin's own surfaces are fully typed.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: { jest: 'readonly', describe: 'readonly', it: 'readonly', expect: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
);
