#!/usr/bin/env node

import { execSync } from 'node:child_process';

/**
 * Pre-commit hook that formats staged files
 */
function preCommitHook() {
  try {
    // Get staged files
    const stagedFiles = execSync(
      'git diff --cached --name-only --diff-filter=ACM',
      { encoding: 'utf8' },
    ).trim();

    if (!stagedFiles) {
      console.log('No staged files to format.');
      return;
    }

    const allFiles = stagedFiles.split('\n').filter((file) => file.trim());

    console.log(`Formatting ${allFiles.length} staged file(s)...`);

    // Run oxfmt on staged files (oxfmt handles ignore patterns and supported extensions)
    execSync(`pnpm oxfmt ${allFiles.map((f) => `"${f}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Re-stage the formatted files
    execSync(`git add ${allFiles.map((f) => `"${f}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    console.log('Files formatted and re-staged successfully.');
  } catch (error) {
    console.error('Error in pre-commit hook:', error);
  }
}

preCommitHook();
