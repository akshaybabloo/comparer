import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';

export default [
	{ ignores: ['.vite/', 'out/', 'dist/', 'test-results/', 'playwright-report/'] },
	// typescript-eslint's recommended rules. Its base config hands every file to the TypeScript
	// parser, so it comes before Svelte's, which takes `.svelte` files back for the Svelte parser.
	// The plugin's types declare this as one config, though it is an array of them.
	.../** @type {import('eslint').Linter.Config[]} */ (tsPlugin.configs['flat/recommended']),
	// An array of configs: the Svelte parser for `.svelte` files, plus Prettier's rule overrides.
	...svelte.configs.prettier,
	// The scripts inside `.svelte` and `.svelte.ts` files are TypeScript too.
	{ files: ['**/*.svelte', '**/*.svelte.ts'], languageOptions: { parserOptions: { parser: tsParser } } },
	// Last, so no rule it turns off for Prettier's sake is turned back on.
	prettier
];
