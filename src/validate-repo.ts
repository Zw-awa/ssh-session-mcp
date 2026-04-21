#!/usr/bin/env node

import { basename } from 'node:path';

import { validateRepository } from './repo-validation.js';

function main() {
  const failures = validateRepository(process.cwd());

  if (failures.length === 0) {
    console.log('Repository validation passed.');
    return;
  }

  console.error('Repository validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`${basename(process.argv[1] || 'validate-repo')}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
