// ESLint flat config. Scope matches `npm run format`: server, protocol,
// sdks/typescript, web client, electron shell, build scripts.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const sharedRules = {
  // `catch {}` is the idiom for "best effort, ignore failure" here.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Flags the `let x = fallback; try { x = … } catch {}` initialisation
  // pattern used throughout; the assignments are intentional defaults.
  'no-useless-assignment': 'off',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'dist-desktop/**',
      'coverage/**',
      // Vendored / generated.
      '.ai-agent/**',
      'deploy/**',
    ],
  },

  // --- TypeScript (server, protocol, sdks/typescript, vitest config) -----------
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      // The codebase uses `any` deliberately at tool/LLM boundaries; tighten
      // per-directory later rather than blanket-disable everywhere.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // --- Web client (React 19, automatic JSX runtime) ------------------------
  {
    files: ['web/src/**/*.{js,jsx}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Deliberate "run once" effects are common; keep visible, not blocking.
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler–oriented rules. The web client does not use the
      // compiler yet; enable these when it does.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
    },
  },

  // --- Node-side plain JS (electron shell, build scripts, entry point) ----
  {
    files: ['desktop/**/*.{cjs,mjs}', 'scripts/**/*.{cjs,mjs}', 'start.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node },
    },
    rules: { ...sharedRules },
  },
  {
    files: ['desktop/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
)
