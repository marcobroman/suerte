import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // Underscore-prefixed names mark intentionally unused params, which interface
    // implementations are forced to declare.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['electron.vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } }
  }
)
