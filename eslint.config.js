const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  // Service Worker — uses SW-specific globals (self, caches, clients, fetch, Response)
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        addEventListener: 'readonly',
        skipWaiting: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: '^CACHE_NAME$|^_' }]
    }
  },
  // Browser + App JS
  {
    files: ['public/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly',
        console: 'readonly', alert: 'readonly', prompt: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        Chart: 'readonly', Intl: 'readonly', MutationObserver: 'readonly',
        IntersectionObserver: 'readonly', history: 'readonly', location: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'warn',
      // Function re-declaration and redeclare are intentional for showPage override pattern
      'no-func-assign': 'off',
      'no-redeclare': 'off'
    }
  },
  // Backend Node.js files
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'public/**', 'coverage/**', 'dist/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'readonly', exports: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly'
      }
    },
    rules: {
      // Errors
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|next', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'warn',
      'no-extra-semi': 'warn',

      // Security-relevant
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-proto': 'error',

      // Best practice
      'eqeqeq': ['warn', 'always'],
      'curly': ['warn', 'multi-line'],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-throw-literal': 'error',
      'handle-callback-err': 'warn'
    }
  }
];
