import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';

export default [
	{ ignores: ['dist/', '.astro/', 'node_modules/'] },
	js.configs.recommended,
	...tseslint.configs.strict,
	...astro.configs.recommended,
];
