// Separation rule (16b §5.3): the API must never import tester code, which holds the seal key and test content.
const noTester = {
  patterns: [
    {
      group: ['**/tester', '**/tester/**', '**/tester.ts'],
      message: 'The API must not import tester code (src/tester/**). See 16b §5.3.',
    },
  ],
};

module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  extends: 'eslint:recommended',
  ignorePatterns: ['node_modules/', 'prisma/generated/', 'dist/'],
  rules: {
    'no-unused-vars': 'off', // tsc --noEmit covers this for TS
    'no-undef': 'off',
  },
  overrides: [
    {
      // everything the API process can load: index.ts, routes, and the shared lib/utils/config they import
      files: ['**/*.ts'],
      excludedFiles: ['tester.ts', 'src/tester/**', 'test/**'],
      rules: { 'no-restricted-imports': ['error', noTester] },
    },
  ],
};
