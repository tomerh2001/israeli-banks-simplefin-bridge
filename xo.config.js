/** @type {import('xo').FlatXoConfig} */
const xoConfig = [
	{
		ignores: ['.yarn/**', 'dist/**', 'docs/**', '**/*.md', 'coverage/**', 'data/**'],
	},
	{
		space: false,
		rules: {
			'no-console': 'off',
			'capitalized-comments': 'off',
			complexity: 'off',
			'max-params': 'off',
			'require-unicode-regexp': 'off',
			'preserve-caught-error': 'off',
			'jsdoc/require-asterisk-prefix': 'off',
			'jsdoc/check-indentation': 'off',
			'regexp/no-super-linear-move': 'off',
			'@typescript-eslint/naming-convention': 'off',
			'@typescript-eslint/strict-boolean-expressions': 'off',
			'@typescript-eslint/no-confusing-void-expression': 'off',
			'@typescript-eslint/no-unnecessary-condition': 'off',
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
			'unicorn/prevent-abbreviations': 'off',
			'unicorn/filename-case': 'off',
			'unicorn/prefer-iterator-to-array': 'off',
			'unicorn/prefer-iterator-helpers': 'off',
			'unicorn/no-array-sort': 'off',
			'unicorn/max-nested-calls': 'off',
			'unicorn/consistent-boolean-name': 'off',
			'unicorn/no-array-reduce': 'off',
			'unicorn/no-null': 'off',
			'n/prefer-global/process': 'off',
			'import-x/extensions': 'off',
		},
	},
];

export default xoConfig;
