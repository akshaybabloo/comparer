import { defineConfig } from 'vite';

/**
 * The diff service builds as ESM, unlike the main process.
 *
 * comparer-ts instantiates its WebAssembly module with a top-level await,
 * which is illegal in CommonJS — Forge's default for a `main` target — and
 * fails the build outright. Forge only imposes that default when the user
 * config declares no `build.lib`, so declaring one here is what opts out.
 * The `.mjs` extension is what makes Node treat the result as a module.
 *
 * comparer-ts is bundled rather than externalised so the wasm travels inside
 * the built file and needs no node_modules beside it once packaged.
 */
export default defineConfig({
	build: {
		lib: {
			entry: 'src/services/diff-service.ts',
			formats: ['es'],
			fileName: () => 'diff-service.mjs'
		}
	}
});
