'use strict';
// Sealing the plan data for the public site, on the invented demo plans.
const test = require('node:test');
const assert = require('node:assert');
const { seal, unseal, openWithKey, keyToText, keyFromText } = require('../src/seal.js');

const payload = { config: require('../demo/plans.demo.json'), extras: {} };
const phrase = 'a walk by the river';

test('sealing then unsealing gives back the same data, and the envelope holds none of it in plain text', async () => {
  const env = await seal(payload, phrase);
  assert.doesNotMatch(JSON.stringify(env), new RegExp(payload.config.plans[0].name));
  const { payload: back, key } = await unseal(env, phrase);
  assert.deepStrictEqual(back, payload);
  // The key kept for the tab opens it again without the passphrase.
  assert.deepStrictEqual(await openWithKey(env, await keyFromText(await keyToText(key))), payload);
});

test('capitals and spacing do not matter; a different phrase is rejected as a wrong key', async () => {
  const env = await seal(payload, phrase);
  assert.deepStrictEqual((await unseal(env, '  A Walk  by the RIVER ')).payload, payload);
  await assert.rejects(unseal(env, 'a walk by the rivers'), (e) => e.wrongKey === true);
});

test('a tampered envelope is rejected, not decrypted to garbage', async () => {
  const env = await seal(payload, phrase);
  const flipped = (env.data[5] === 'A' ? 'B' : 'A');
  await assert.rejects(unseal({ ...env, data: env.data.slice(0, 5) + flipped + env.data.slice(6) }, phrase), (e) => e.wrongKey === true);
});
