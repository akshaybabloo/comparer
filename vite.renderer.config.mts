import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig(({ command }) => ({
  // A packaged build is loaded with `loadFile`, i.e. over file://, where the
  // default absolute `/assets/...` would resolve against the filesystem root
  // and the window would come up blank. The dev server keeps the default,
  // where relative paths would break HMR's module URLs.
  base: command === 'build' ? './' : '/',
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
  optimizeDeps: {
    // comparer-ts is imported only from the worker, so the dev server's initial
    // dependency scan misses it, then discovers it on first compare and forces
    // a full page reload mid-use. Declaring it up front pre-bundles it instead.
    include: ['comparer-ts'],
  },
  build: {
    // comparer-ts inlines its WebAssembly module as a data URI, so the chunk is
    // legitimately ~640 kB. Raise the warning bar rather than see it every build.
    chunkSizeWarningLimit: 1024,
  },
}));
