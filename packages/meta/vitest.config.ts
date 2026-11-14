import { defineConfig } from 'vitest/config';

// Isolated config: prevents Vite from walking up the tree and loading
// unrelated PostCSS/Tailwind configs from parent directories.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
