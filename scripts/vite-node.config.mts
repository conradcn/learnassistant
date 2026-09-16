// Minimal config so `vite-node` can run the one-off scripts in this folder: the app's
// `@/` alias lives inside vitest's per-project `resolve`, which vite-node does not read.
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
});
