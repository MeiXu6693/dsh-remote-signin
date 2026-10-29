import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Chinese and English READMEs retain matching sections and settings', async () => {
  const [zh, en, legacy, manifest] = await Promise.all([
    read('README.md'), read('README.en.md'), read('README.zh-CN.md'), read('package.json'),
  ]);
  assert.match(zh, /\[English\]\(README\.en\.md\)/);
  assert.match(en, /\[中文\]\(README\.md\)/);
  assert.match(legacy, /\]\(README\.md\)/);
  const sections = (text) => [...text.matchAll(/^## /gm)].length;
  const settings = (text) => [...new Set([...text.matchAll(/`(REMOTE_SIGNIN(?:_ORIGIN)?)`/g)].map((m) => m[1]))].sort();
  assert.equal(sections(zh), sections(en));
  assert.deepEqual(settings(zh), settings(en));
  const files = JSON.parse(manifest).files;
  assert.ok(files.includes('README.en.md') && files.includes('README.zh-CN.md'));
});
