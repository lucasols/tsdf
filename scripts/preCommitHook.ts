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

    const unstagedFiles = execSync('git diff --name-only', {
      encoding: 'utf8',
    }).trim();

    if (!stagedFiles) {
      console.log('No staged files to format.');
      return;
    }

    const allFiles = stagedFiles.split('\n').filter((file) => file.trim());
    const workingTreeFiles = new Set(
      unstagedFiles ?
        unstagedFiles.split('\n').filter((file) => file.trim())
      : [],
    );

    const filesToFormat = allFiles.filter(
      (file) => !workingTreeFiles.has(file),
    );
    const skippedFiles = allFiles.filter((file) => workingTreeFiles.has(file));

    if (filesToFormat.length === 0) {
      console.log('No fully staged files to format.');
      if (skippedFiles.length > 0) {
        console.log(`Skipped ${skippedFiles.length} partially staged file(s).`);
      }
      return;
    }

    console.log(`Formatting ${filesToFormat.length} staged file(s)...`);
    if (skippedFiles.length > 0) {
      console.log(`Skipped ${skippedFiles.length} partially staged file(s).`);
    }

    // Run oxfmt on staged files (oxfmt handles ignore patterns and supported extensions)
    execSync(`pnpm oxfmt ${filesToFormat.map((f) => `"${f}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Re-stage the formatted files
    execSync(`git add ${filesToFormat.map((f) => `"${f}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    console.log('Files formatted and re-staged successfully.');
  } catch (error) {
    console.error('Error in pre-commit hook:', error);
  }
}

preCommitHook();
