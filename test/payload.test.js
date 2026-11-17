'use strict';
// Text carried along with a plan configuration (payload.js), and what the build's network
// check makes of it. On the invented demo plans.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadPayload } = require('../payload.js');

const root = path.join(__dirname, '..');
const demo = JSON.parse(fs.readFileSync(path.join(root, 'demo', 'plans.demo.json'), 'utf8'));
// A script that would talk to a network if it were ever run here.
const SCRIPT = '// a script for some other site\nfetch("https://example.org/eob").then(save);\n';

function scratch(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(path.join(dir, 'plans.json'), JSON.stringify(config));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [path.join(root, 'build.js'), '--config', path.join(dir, 'plans.json'), '--out', path.join(dir, 'page.html')], { encoding: 'utf8' });

test('a configuration names text files to carry; they are read beside it and leave the configuration', () => {
  const dir = scratch({ ...demo, extras: { downloader: 'scripts/get.js' } }, { 'scripts/get.js': SCRIPT });
  const { config, extras } = loadPayload(path.join(dir, 'plans.json'));
  assert.deepStrictEqual(extras, { downloader: SCRIPT });
  assert.strictEqual(config.extras, undefined);
  assert.deepStrictEqual(loadPayload(path.join(root, 'demo', 'plans.demo.json')).extras, {});
  assert.throws(() => loadPayload(path.join(scratch({ ...demo, extras: { downloader: 'nowhere.js' } }), 'plans.json')), /no file at/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the build carries that text as data the page shows, and still refuses a network call anywhere else', () => {
  const carried = scratch({ ...demo, extras: { downloader: 'get.js' } }, { 'get.js': SCRIPT });
  const ok = build(carried);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const html = fs.readFileSync(path.join(carried, 'page.html'), 'utf8');
  assert.match(html, /<script type="application\/json" id="plan-extras">/);
  assert.ok(html.includes('example.org/eob'), 'the text is in the page, for showing');
  assert.match(html, /default-src 'none'/, 'and the page still may not connect to anything');

  // The same words in the configuration proper are part of the page, and stop the build.
  const loose = scratch({ ...demo, audience: SCRIPT });
  const refused = build(loose);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /must not be able to make network requests/);
  for (const dir of [carried, loose]) fs.rmSync(dir, { recursive: true, force: true });
});
