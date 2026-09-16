// FRACTAL: implements F6 | component C0
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'data/**',
      'test-results/**',
      'playwright-report/**',
      'e2e/perf/timeseries/**',
      'e2e/reachability/**',
      'next-env.d.ts',
      // fractal workspace tooling, not project source
      '.fractal/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // WHY: Playwright fixtures take a parameter named `use`, which the
    // react-hooks rule reads as a hook call. These files contain no React.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
  {
    rules: {
      // WHY: the codebase is deliberately explicit about unused-but-declared
      // interface parameters in transport implementations; they are prefixed `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
];

export default config;
