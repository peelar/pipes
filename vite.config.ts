import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true },
  lint: {
    extends: [nkzw],
    overrides: [
      {
        files: ['src/**/*.tsx', 'packages/**/*.tsx'],
        rules: {
          // OpenTUI uses terminal elements, not React DOM properties.
          'react/no-unknown-property': 'off',
        },
      },
      {
        // Ratchet for the server refactor: every file this plan touches
        // is red until it is split. Green files must stay green.
        files: ['src/server/**/*.ts'],
        rules: {
          'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
        },
      },
    ],
    rules: {
      complexity: 'error',
      // Files over 1000 lines are a smell anywhere in the codebase.
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
});
