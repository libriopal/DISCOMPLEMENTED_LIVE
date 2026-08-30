export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',     // New feature
        'fix',      // Bug fix
        'docs',     // Documentation
        'style',    // Formatting, no code change
        'refactor', // Code refactoring
        'perf',     // Performance
        'test',     // Adding tests
        'build',    // Build system or deps
        'ci',       // CI config
        'chore',    // Misc
        'revert',   // Revert previous commit
        'security', // Security fix
        'cohere',   // Cohere API changes
        'lattice',  // Memory Lattice changes
        'governance', // Governance changes
      ],
    ],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [0], // Allow longer lines in body
  },
};
