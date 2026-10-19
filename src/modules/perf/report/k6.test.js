import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { resolvePerfSettings } from '../settings.js';
import { buildK6Script } from './k6.js';

const execFileAsync = promisify(execFile);
/** @type {string[]} */
const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** @type {import('../stress/scenario.js').Scenario[]} */
const scenarios = [
  {
    slug: 'dashboard',
    url: 'http://localhost:3000/dashboard',
    levels: [
      [{ url: 'http://localhost:3000/dashboard', label: 'GET /dashboard', kind: 'document' }],
      [
        { url: 'http://localhost:3000/api/me', label: 'GET /api/me', kind: 'api' },
        {
          url: 'http://localhost:3000/api/search',
          label: 'POST /api/search',
          kind: 'api',
          method: 'POST',
          body: '{"q":"secret-query"}',
          contentType: 'application/json',
        },
      ],
    ],
  },
];

/** @param {Record<string, unknown>} cli */
const settingsWith = (cli) =>
  resolvePerfSettings({
    target: 'http://localhost:3000',
    cli: { header: ['Authorization: Bearer top-secret'], ...cli },
    config: undefined,
    cwd: '/',
  });

describe('buildK6Script', () => {
  it('writes a valid script with GET levels, env-based headers, and no secrets', async () => {
    const script = buildK6Script({
      scenarios,
      settings: settingsWith({ stressStages: '1,10', stressDuration: '20s' }),
      now: new Date('2026-10-19T00:00:00Z'),
    });
    assert.doesNotMatch(script, /top-secret|secret-query/);
    assert.match(script, /"authorization": __ENV\.LAUNCHSCOPE_HEADER_AUTHORIZATION \|\| ''/);
    assert.match(script, /\/\/ {3}POST \/api\/search/, 'skipped write is listed');
    assert.match(script, /"executor": "ramping-vus"/);
    assert.match(script, /"duration": "20s",\s+"target": 10/);
    assert.match(script, /"p\(95\)<1000"/);
    assert.match(script, /"path": "\/api\/me"/);
    assert.doesNotMatch(script, /"path": "\/api\/search"/);

    const dir = await mkdtemp(join(tmpdir(), 'launchscope-k6-'));
    dirs.push(dir);
    const file = join(dir, 'k6-script.mjs');
    await writeFile(file, script);
    await execFileAsync(process.execPath, ['--check', file]);
  });

  it('uses an arrival-rate executor in open mode', () => {
    const script = buildK6Script({
      scenarios,
      settings: settingsWith({ stressMode: 'open', stressRates: '2,8' }),
    });
    assert.match(script, /"executor": "ramping-arrival-rate"/);
    assert.match(script, /"preAllocatedVUs": 16/);
    assert.match(script, /"target": 8/);
  });
});
