import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Bare `catch {}` blocks hid the embed.ts and kickOffOrchestrator bugs
      // (see bicameral_silent-failure-audit memory) — require at least a
      // comment explaining why silence is intentional, or a log call.
      // no-empty already tolerates comment-only blocks, so existing
      // documented-intentional catches (e.g. lattice-enrich.ts's best-effort
      // enrichment) don't need to change.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**'],
  }
);
