'use strict';
// Sealing: the plan data is encrypted with a passphrase so the public site holds no plan facts
// in plain text. Runs unchanged in the browser and under Node, using WebCrypto in both.
//
// AES-GCM with a 256-bit key derived from the passphrase by PBKDF2-SHA256. The salt, the
// round count and the IV are not secret and travel in the envelope beside the ciphertext, so
// the round count can be raised later without touching this file. GCM is authenticated: a
// wrong passphrase does not produce garbage, it fails to decrypt.
//
// The passphrase is normalised before use (Unicode NFC, lower case, outer spaces trimmed,
// runs of spaces collapsed), because it is shared by word of mouth and people will type it
// with different capitals and spacing.

const FORMAT = 'umr-wtf/sealed';
const VERSION = 1;
const ITERATIONS = 600000; // OWASP's 2023 figure for PBKDF2-HMAC-SHA256

function subtle() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  // Node 18 without the global. The bundler only follows relative requires, so the page never
  // sees this line run.
  return require('node:crypto').webcrypto;
}

function normalisePassphrase(s) {
  return String(s).normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHUNK = 1 << 15; // fromCharCode.apply has an argument limit
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const c = subtle();
  const base = await c.subtle.importKey('raw', enc.encode(normalisePassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
  // Extractable so the page can keep it for the rest of the tab's life (see keyToText).
  return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function checkEnvelope(env) {
  if (!env || env.format !== FORMAT) throw new Error('not a sealed umr-wtf file');
  if (env.v !== VERSION) throw new Error(`sealed file version ${env.v} is not one this page reads`);
  if (!env.kdf || !env.kdf.salt || !(env.kdf.iterations > 0) || !env.iv || !env.data) throw new Error('sealed file is incomplete');
}

// payload: any JSON value. Returns the envelope, a plain object ready for JSON.stringify.
async function seal(payload, passphrase, opts = {}) {
  if (normalisePassphrase(passphrase).length < 8) throw new Error('passphrase is too short (8 characters at least)');
  const c = subtle();
  const iterations = opts.iterations || ITERATIONS;
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
  return { format: FORMAT, v: VERSION, kdf: { name: 'PBKDF2-SHA-256', iterations, salt: toB64(salt) }, cipher: 'AES-GCM-256', iv: toB64(iv), data: toB64(data) };
}

// Wrong key or tampered data: throws an Error with .wrongKey set.
async function openWithKey(env, key) {
  checkEnvelope(env);
  let plain;
  try {
    plain = await subtle().subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.data));
  } catch (e) {
    const err = new Error('wrong passphrase');
    err.wrongKey = true;
    throw err;
  }
  return JSON.parse(dec.decode(plain));
}

// Returns { payload, key }. The key can be kept with keyToText and reused with keyFromText.
async function unseal(env, passphrase) {
  checkEnvelope(env);
  const key = await deriveKey(passphrase, fromB64(env.kdf.salt), env.kdf.iterations);
  return { payload: await openWithKey(env, key), key };
}

async function keyToText(key) {
  return toB64(new Uint8Array(await subtle().subtle.exportKey('raw', key)));
}
async function keyFromText(text) {
  return subtle().subtle.importKey('raw', fromB64(text), { name: 'AES-GCM' }, true, ['decrypt']);
}

module.exports = { seal, unseal, openWithKey, keyToText, keyFromText, normalisePassphrase, checkEnvelope, FORMAT, ITERATIONS };
