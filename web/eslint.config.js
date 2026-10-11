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
			globals: { Buffer: 'readonly', console: 'readonly', fetch: 'readonly', performance: 'readonly', process: 'readonly' },
		},
	},
	{
		files: ['src/globe/**/*.{ts,astro}'],
		ignores: ['src/globe/clock.ts', 'src/globe/**/*.test.ts'],
		rules: {
			'no-restricted-properties': [
				'error',
				{ object: 'Date', property: 'now', message: 'Read time from SceneClock.' },
			],
			'no-restricted-syntax': [
				'error',
				{
					selector: "NewExpression[callee.name='Date'][arguments.length=0]",
					message: 'Read time from SceneClock.',
				},
			],
		},
	},
];
