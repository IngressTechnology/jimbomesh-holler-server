const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');

module.exports = [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['admin/*.js', 'swagger-brand.js', 'i18n.js', 'test/ui/*.spec.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        history: 'readonly',
        location: 'readonly',
        confirm: 'readonly',
        performance: 'readonly',
        FormData: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/',
      'admin/assets/',
      'docs/',
      'scripts/',
      '*.sh',
      '*.ps1',
    ],
  },
];
