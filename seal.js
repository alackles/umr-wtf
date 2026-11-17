#!/usr/bin/env node
'use strict';
// Seals a plan configuration for the public site. Run it yourself, in a terminal, whenever
// the plan configuration changes:
//
//   node seal.js --config <plans.json> [--out site/plans.sealed.json]
//
// It asks for the passphrase twice, without echoing it. The passphrase is never taken from
// the command line (it would land in shell history) and never written anywhere. Capitals and
// extra spaces do not matter (see src/seal.js). After writing, it opens the file again with
// the same passphrase and checks that what comes out is what went in.

const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./src/plans.js');
const { seal, unseal, normalisePassphrase } = require('./src/seal.js');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const configArg = arg('--config', null);
const outPath = path.resolve(arg('--out', path.join(__dirname, 'site', 'plans.sealed.json')));
if (!configArg) {
  console.error('usage: node seal.js --config <plans.json> [--out site/plans.sealed.json]');
  process.exit(1);
}

// Read a line from the terminal without echoing it.
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('seal.js needs a terminal to ask for the passphrase'));
    stdin.setRawMode(true); // before the prompt, so nothing typed early is echoed
    stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding('utf8');
    let text = '';
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(text));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const configPath = path.resolve(configArg);
  const config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const payload = { config, extras: {} };

  const first = await ask('Passphrase: ');
  const second = await ask('Again: ');
  if (normalisePassphrase(first) !== normalisePassphrase(second)) throw new Error('the two passphrases differ; nothing written');

  const envelope = await seal(payload, first);
  const back = await unseal(envelope, second);
  if (JSON.stringify(back.payload) !== JSON.stringify(payload)) throw new Error('round trip did not match; nothing written');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 1) + '\n');
  console.log(`sealed ${path.basename(configPath)} -> ${path.relative(process.cwd(), outPath)} (${envelope.kdf.iterations} PBKDF2 rounds)`);
})().catch((e) => {
  console.error(`seal.js: ${e.message}`);
  process.exit(1);
});
