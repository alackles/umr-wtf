'use strict';
// The unlock screen for the sealed (public) build. Asks for the passphrase, decrypts the plan
// data in the browser, and hands it to the page. Nothing is sent anywhere.
//
// Once unlocked, the key is kept in this tab's sessionStorage, as the answers are, so a reload
// does not ask again. Closing the tab forgets it. The passphrase itself is never stored.

const { h, clear } = require('./dom.js');
const { unseal, openWithKey, keyToText, keyFromText } = require('../seal.js');

const keyName = (env) => `umr-wtf:key:${env.kdf.salt}`; // a new sealing never meets an old key

function remembered(env) {
  try {
    return sessionStorage.getItem(keyName(env));
  } catch (e) {
    return null;
  }
}
function remember(env, text) {
  try {
    sessionStorage.setItem(keyName(env), text);
  } catch (e) {
    /* storage blocked: it will ask again on reload */
  }
}
function forget(env) {
  try {
    sessionStorage.removeItem(keyName(env));
  } catch (e) {
    /* nothing to do */
  }
}

// start(payload) is called with the decrypted { config, extras }; header() is the page's own.
function show(env, start, header) {
  const app = clear(document.getElementById('app'));
  app.appendChild(header());

  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    // WebCrypto exists only on https and file pages. Say so rather than fail quietly.
    app.appendChild(h('p', { class: 'unlock-msg' }, 'This browser can\'t unlock the page from here. Open it from its https address, or as a file saved on your computer.'));
    return;
  }

  const input = h('input', {
    type: 'password',
    id: 'passphrase',
    autocomplete: 'current-password',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-describedby': 'unlock-help unlock-msg',
  });
  const button = h('button', { type: 'submit', class: 'btn primary' }, 'Unlock');
  const msg = h('p', { class: 'unlock-msg', id: 'unlock-msg', role: 'status' });
  const form = h(
    'form',
    {
      class: 'unlock',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        button.disabled = input.disabled = true;
        button.textContent = 'Unlocking…';
        msg.textContent = '';
        try {
          const { payload, key } = await unseal(env, input.value);
          remember(env, await keyToText(key));
          start(payload);
        } catch (err) {
          button.disabled = input.disabled = false;
          button.textContent = 'Unlock';
          msg.textContent = err.wrongKey ? 'That didn\'t work. Check the spelling. Passphrase is not case-sensitive.' : `This page could not unlock: ${err.message}`;
          input.focus();
          input.select();
        }
      },
    },
    h('label', { class: 'field', for: 'passphrase' }, h('span', null, 'Enter the site passphrase')),
    h('div', { class: 'unlock-row' }, input, button),
    h('p', { class: 'unlock-help', id: 'unlock-help' }, 'If you don\'t know the passphrase, ask the person who sent this to you.'),
    msg
  );
  app.appendChild(form);
  input.focus();
}

// Boot: try a key kept from earlier in this tab, else ask.
async function boot(env, start, header) {
  const kept = remembered(env);
  if (kept) {
    try {
      const payload = await openWithKey(env, await keyFromText(kept));
      return start(payload);
    } catch (e) {
      forget(env);
    }
  }
  show(env, start, header);
}

module.exports = { boot };
