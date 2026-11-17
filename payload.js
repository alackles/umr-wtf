'use strict';
// Reads a plan configuration file, and anything it points to, into what the page is given:
// { config, extras }. Used by build.js (the plain page) and seal.js (the public site), so the
// two can never be handed different things.
//
// A configuration may name text files to carry along, as paths relative to itself:
//
//   "extras": { "downloader": "downloader/get-eobs.js" }
//
// Each becomes extras.<name>, holding the file's text. The page shows that text for copying
// and never runs it. The "extras" key itself is taken out of the configuration.

const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./src/plans.js');

function loadPayload(configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const named = raw.extras || {};
  delete raw.extras;
  const extras = {};
  for (const [name, file] of Object.entries(named)) {
    if (typeof file !== 'string') throw new Error(`extras.${name} must be the path of a text file`);
    const at = path.resolve(path.dirname(configPath), file);
    if (!fs.existsSync(at)) throw new Error(`extras.${name}: no file at ${at}`);
    extras[name] = fs.readFileSync(at, 'utf8');
  }
  return { config: validateConfig(raw), extras };
}

module.exports = { loadPayload };
