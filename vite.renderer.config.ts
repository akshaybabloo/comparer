import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  worker: {
    // The diff worker imports comparer-ts, which is ESM.
    format: 'es',
  },
  build: {
    // comparer-ts inlines its WebAssembly module as a data URI, so the chunk is
    // legitimately ~640 kB. Raise the warning bar rather than see it every build.
    chunkSizeWarningLimit: 1024,
  },
});
