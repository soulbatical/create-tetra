#!/usr/bin/env node

import { main } from '../src/cli.js';

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Tetra bootstrap failed.';
  process.stderr.write(`\nTetra bootstrap stopped: ${message}\n`);
  process.exitCode = 1;
});
