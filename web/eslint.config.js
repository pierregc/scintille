import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';

export default [
	{ ignores: ['dist/', '.astro/', 'node_modules/'] },
	js.configs.recommended,
	...tseslint.configs.strict,
	...astro.configs.recommended,
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: { Buffer: 'readonly', console: 'readonly', fetch: 'readonly', process: 'readonly' },
		},
	},
];
