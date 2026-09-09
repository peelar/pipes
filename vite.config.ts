import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true },
  lint: {
    extends: [nkzw],
    overrides: [
      {
        files: ['src/**/*.tsx'],
        rules: {
          // OpenTUI uses terminal elements, not React DOM properties.
          'react/no-unknown-property': 'off',
        },
      },
    ],
    rules: { complexity: 'error' },
  },
});
