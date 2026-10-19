import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createRunDirectory,
  formatRunTimestamp,
  slugifyHost,
  writeJsonFile,
} from './report-dir.js';

describe('formatRunTimestamp', () => {
  it('formats in UTC without characters that are unsafe in file names', () => {
    assert.equal(formatRunTimestamp(new Date('2026-10-19T03:29:04.123Z')), '2026-10-19_03-29-04Z');
  });
});

describe('slugifyHost', () => {
  it('includes the port when present', () => {
    assert.equal(slugifyHost(new URL('http://localhost:4200/dashboard')), 'localhost-4200');
  });

  it('omits the default port', () => {
    assert.equal(slugifyHost(new URL('https://App.Example.com/')), 'app.example.com');
  });

  it('makes IPv6 hosts filesystem safe', () => {
    assert.equal(slugifyHost(new URL('http://[::1]:3000/')), '1-3000');
  });
});

describe('createRunDirectory', () => {
  /** @type {string} */
  let cwd;

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'launchscope-runs-'));
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates <outputDir>/<host>_<timestamp> under cwd', async () => {
    const path = await createRunDirectory({
      outputDir: 'reports',
      cwd,
      targetUrl: new URL('http://localhost:4200'),
      now: new Date('2026-10-19T03:29:04Z'),
    });
    assert.equal(dirname(path), join(cwd, 'reports'));
    assert.equal(basename(path), 'localhost-4200_2026-10-19_03-29-04Z');
  });

  it('never reuses an existing run directory', async () => {
    const options = {
      outputDir: 'collide',
      cwd,
      targetUrl: new URL('https://example.com'),
      now: new Date('2026-10-19T03:29:04Z'),
    };
    const first = await createRunDirectory(options);
    const second = await createRunDirectory(options);
    assert.notEqual(first, second);
    assert.equal(basename(second), 'example.com_2026-10-19_03-29-04Z-2');
  });
});

describe('writeJsonFile', () => {
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launchscope-json-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes pretty JSON and leaves no temp file behind', async () => {
    const path = join(dir, 'summary.json');
    await writeJsonFile(path, { routes: 2 });
    assert.equal(await readFile(path, 'utf8'), '{\n  "routes": 2\n}\n');
    assert.deepEqual(await readdir(dir), ['summary.json']);
  });
});
