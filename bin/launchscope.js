#!/usr/bin/env node
import { run } from '../src/cli.js';

process.exitCode = await run(process.argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
});
