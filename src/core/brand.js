import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const BRAND = Object.freeze({
  name: 'LaunchScope',
  command: 'launchscope',
  tagline: 'Launch-readiness checks for web apps',
  version: /** @type {string} */ (packageJson.version),
  repositoryUrl: 'https://github.com/himan-patel/launchscope',
  issuesUrl: 'https://github.com/himan-patel/launchscope/issues',
});
