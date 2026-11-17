#!/usr/bin/env node
'use strict';
// Builds the page: one self-contained HTML file. No dependencies, no bundler.
//
//   node build.js                                   demo plans  -> dist/index.html
//   node build.js --config <plans.json> --out <file.html>
//   node build.js --sealed site/plans.sealed.json --out <file.html>   the public site
//
// The source modules are plain CommonJS so the same files run under Node for tests. Here
// each one is wrapped in a function and given a tiny `require` that resolves between them.
// The plan configuration is embedded as a JSON block, or, with --sealed, as the encrypted
// envelope that seal.js wrote, behind an unlock screen. The build refuses to produce a page
// that could talk to the network.

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = __dirname;
const sealedPath = arg('--sealed', null) && path.resolve(arg('--sealed'));
const configPath = path.resolve(arg('--config', path.join(root, 'demo', 'plans.demo.json')));
const outPath = path.resolve(arg('--out', path.join(root, 'dist', 'index.html')));
const entry = 'ui/app.js';

const { validateConfig } = require('./src/plans.js');
const { checkEnvelope } = require('./src/seal.js');
let config = null;
let envelope = null;
if (sealedPath) {
  if (args.includes('--config')) {
    console.error('--sealed and --config are exclusive: the sealed file already holds the plans.');
    process.exit(1);
  }
  if (!fs.existsSync(sealedPath)) {
    console.error(`No sealed file at ${path.relative(process.cwd(), sealedPath)}. Make one with: node seal.js --config <plans.json>`);
    process.exit(1);
  }
  envelope = JSON.parse(fs.readFileSync(sealedPath, 'utf8'));
  checkEnvelope(envelope);
} else {
  config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
}

// Collect modules reachable from the entry.
const src = path.join(root, 'src');
const modules = new Map();
function collect(id) {
  if (modules.has(id)) return;
  const code = fs.readFileSync(path.join(src, id), 'utf8');
  modules.set(id, code);
  const re = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;
  let m;
  while ((m = re.exec(code))) collect(path.posix.normalize(path.posix.join(path.posix.dirname(id), m[2])));
}
collect(entry);

let bundle = '(function () {\n"use strict";\nvar __defs = {};\nvar __cache = {};\n';
bundle +=
  'function __dir(id) { var i = id.lastIndexOf("/"); return i < 0 ? "" : id.slice(0, i); }\n' +
  'function __join(dir, rel) { var parts = (dir ? dir.split("/") : []); rel.split("/").forEach(function (p) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }); return parts.join("/"); }\n' +
  'function __require(id) { if (__cache[id]) return __cache[id].exports; if (!__defs[id]) throw new Error("module not found: " + id); var module = { exports: {} }; __cache[id] = module; __defs[id](module, module.exports, function (rel) { return __require(__join(__dir(id), rel)); }); return module.exports; }\n';
for (const [id, code] of modules) {
  bundle += `__defs[${JSON.stringify(id)}] = function (module, exports, require) {\n${code}\n};\n`;
}
bundle += `__require(${JSON.stringify(entry)});\n})();\n`;

const safeJson = JSON.stringify(sealedPath ? envelope : config).replace(/</g, '\\u003c');
const dataId = sealedPath ? 'sealed-config' : 'plan-config';
const stamp = arg('--stamp', new Date().toISOString().slice(0, 10));
let html = fs.readFileSync(path.join(src, 'page.html'), 'utf8');
const put = (marker, value) => {
  if (!html.includes(marker)) throw new Error(`page.html is missing ${marker}`);
  html = html.split(marker).join(value);
};
put('/*__STYLE__*/', fs.readFileSync(path.join(src, 'style.css'), 'utf8'));
put('<!--__DATA__-->', `<script type="application/json" id="${dataId}">${safeJson}</script>`);
put('/*__SCRIPT__*/', bundle.replace(/<\/script/gi, '<\\/script'));
put('__BUILD_STAMP__', stamp);

// Nothing leaves the machine: fail the build if the page could reach the network.
const offenders = [];
const urlRe = /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi;
for (const m of html.match(urlRe) || []) {
  if (/^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml)$/.test(m)) continue; // XML namespaces, never fetched
  offenders.push(m);
}
for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts', 'navigator.serviceWorker']) {
  if (html.includes(word)) offenders.push(word);
}
if (!/http-equiv="Content-Security-Policy"/.test(html)) offenders.push('missing Content-Security-Policy');
if (offenders.length) {
  console.error('Build refused: the page must not be able to make network requests.\n  ' + [...new Set(offenders)].join('\n  '));
  process.exit(1);
}

// A sealed page must carry nothing but the envelope.
if (sealedPath && (html.includes('id="plan-config"') || /"plans"\s*:/.test(html))) {
  console.error('Build refused: the sealed page contains plain plan configuration.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
const what = sealedPath ? 'sealed' : `plans: ${config.plans.map((p) => p.short).join(', ')}`;
console.log(`built ${path.relative(process.cwd(), outPath)}  (${(html.length / 1024).toFixed(0)} kB, ${modules.size} modules, ${what})`);
