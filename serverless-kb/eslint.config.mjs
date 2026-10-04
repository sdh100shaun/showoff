import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'cdk.out/**', '**/*.js', '**/*.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // CDK constructs are instantiated for their side effects.
    files: ['lib/**/*.ts', 'bin/**/*.ts', 'test/**/*.ts'],
    rules: { 'no-new': 'off' },
  },
);
