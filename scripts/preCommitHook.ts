#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

/**
 * Pre-commit hook that formats staged files
 */
function preCommitHook() {
  try {
    const allFiles = gitDiffFiles(['--cached', '--diff-filter=ACMR']);

    if (allFiles.length === 0) {
      console.log('No staged files to format.');
      return;
    }

    // Get files with unstaged changes (to detect partial staging)
    const unstagedFiles = new Set(gitDiffFiles([]));

    const partiallyStaged: string[] = [];

    // Skip files with partial staging (both staged and unstaged changes)
    const files = allFiles.filter((file) => {
      if (unstagedFiles.has(file)) {
        partiallyStaged.push(file);
        return false;
      }

      return true;
    });

    if (partiallyStaged.length > 0) {
      console.log(
        `Skipping ${partiallyStaged.length} partially staged file(s): ${partiallyStaged.join(', ')}`,
      );
    }

    if (files.length === 0) {
      console.log('No files to format.');
      return;
    }

    console.log(`Formatting ${files.length} staged file(s)...`);

    // oxfmt skips ignored and unsupported files, and
    // `--no-error-on-unmatched-pattern` avoids failing when all of them are
    // skipped
    execFileSync(
      'pnpm',
      ['exec', 'oxfmt', '--no-error-on-unmatched-pattern', '--', ...files],
      { stdio: 'inherit' },
    );

    // Re-stage the formatted files
    execFileSync('git', ['add', '--', ...files], { stdio: 'inherit' });

    console.log('Files formatted and re-staged successfully.');
  } catch (error) {
    console.error('Error in pre-commit hook:', error);
  }
}

// `-z` lists paths NUL-separated and unquoted, and running git without a shell
// keeps paths from being interpreted as shell syntax
function gitDiffFiles(args: string[]): string[] {
  return execFileSync('git', ['diff', '--name-only', '-z', ...args], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file.length > 0);
}

preCommitHook();
