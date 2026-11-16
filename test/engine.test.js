'use strict';
// Constructed cases for the replay engine, on the invented demo plans.
const test = require('node:test');
const assert = require('node:assert');
const { replay, ItemError } = require('../src/engine.js');
const { validateConfig, getPlan, expandVariants, premiumPerPeriod, tierFor } = require('../src/plans.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const fern = getPlan(config, 'fern'); // copays; deductible 400/800 embedded; 15%; cap 1800/3600
const moss = getPlan(config, 'moss');
const lichen = getPlan(config, 'lichen'); // everything to a pooled deductible 2800/5600; 25%; cap 5500/11000

const near = (got, want, msg) => assert.ok(Math.abs(got - want) < 0.005, `${msg || ''} got ${got}, want ${want}`);
const item = (person, month, category, allowed, extra) => ({ person, month, category, allowed, ...extra });

test('healthy single person: copays only, preventive free', () => {
  const items = [item('a', 3, 'preventive', 350), item('a', 5, 'office', 180), item('a', 9, 'urgent', 230)];
  near(replay(items, fern, { family: false }).total, 20 + 45);
  // On the high-deductible plan the same care is paid in full: nowhere near the deductible.
  near(replay(items, lichen, { family: false }).total, 180 + 230);
});

test('copay is never more than the allowed amount, and is charged per count', () => {
  near(replay([item('a', 1, 'office', 12)], fern, { family: false }).total, 12);
  near(replay([item('a', 1, 'office', 900, { count: 5 })], fern, { family: false }).total, 100);
  // count 0: rides on another visit. Free on a copay plan, deductible on the other.
  near(replay([item('a', 1, 'office', 90, { count: 0 })], fern, { family: false }).total, 0);
  near(replay([item('a', 1, 'office', 90, { count: 0 })], lichen, { family: false }).total, 90);
});

test('deductible then coinsurance', () => {
  const r = replay([item('a', 2, 'ded_coins', 1600)], fern, { family: false });
  near(r.parts.ded, 400);
  near(r.parts.coins, 180);
  near(r.total, 580);
});

test('one member at the cap: later care costs nothing, including copays', () => {
  const items = [item('a', 2, 'ded_coins', 20000), item('a', 6, 'office', 180), item('a', 7, 'ded_coins', 5000)];
  const r = replay(items, fern, { family: false });
  near(r.total, 1800);
  assert.strictEqual(r.capped.a, true);
});

test('emergency room rule: copay, then coinsurance, deductible skipped', () => {
  const r = replay([item('a', 4, 'er_facility', 1700), item('a', 4, 'er_physician', 320)], fern, { family: false });
  near(r.parts.copay, 220);
  near(r.parts.ded, 0);
  near(r.parts.coins, (1700 - 220) * 0.15 + 320 * 0.15);
});

test('family deductible binding: third person owes coinsurance only', () => {
  const items = [
    item('a', 1, 'ded_coins', 600),
    item('b', 2, 'ded_coins', 600),
    item('c', 3, 'ded_coins', 1300),
  ];
  const r = replay(items, fern, { family: true });
  near(r.acc.in.fded, 800);
  near(r.acc.in.ded.c || 0, 0);
  near(r.byPerson.c.in, 195); // 15%, no deductible left to pay
  near(r.total, 400 + 30 + 400 + 30 + 195);
});

test('family cap binding stops a person short of their own cap', () => {
  const items = ['a', 'b', 'c'].map((p, i) => item(p, i + 1, 'ded_coins', 30000));
  const r = replay(items, fern, { family: true });
  near(r.total, 3600);
  near(r.byPerson.c.in, 0);
  assert.strictEqual(r.capped.c, true);
});

test('pooled deductible: no per-person limit inside the family deductible', () => {
  const r = replay([item('a', 1, 'ded_coins', 3300), item('b', 2, 'ded_coins', 3300)], lichen, { family: true });
  near(r.acc.in.ded.a, 3300); // past the individual figure: it does not apply when pooled
  near(r.acc.in.ded.b, 2300);
  near(r.parts.coins, 0.25 * 1000);
  // Alone on the plan, the individual deductible applies instead.
  near(replay([item('a', 1, 'ded_coins', 3300)], lichen, { family: false }).parts.ded, 2800);
});

test('out-of-network: separate accumulators, and the excess over allowed has no cap', () => {
  const items = [
    item('a', 1, 'ded_coins', 400), // fills the in-network deductible
    item('a', 2, 'office', 140, { network: 'out', billed: 200 }),
  ];
  const r = replay(items, fern, { family: false });
  near(r.byPerson.a.in, 400);
  near(r.byPerson.a.out, 140); // out-of-network deductible starts from zero
  near(r.uncapped, 60);
  near(r.memberTotal, 400 + 140 + 60);
  // A year of weekly out-of-network visits: the counted part stops at the out-of-network cap,
  // the excess keeps going.
  const year = [];
  for (let m = 1; m <= 12; m++) year.push(item('a', m, 'office', 2200, { network: 'out', billed: 2800, count: 4 }));
  const y = replay(year, fern, { family: false });
  near(y.total, 3900);
  near(y.uncapped, 600 * 12);
});

test('brand-name prescriptions: flat copays on a copay plan, full price to the deductible on the other', () => {
  const fills = [];
  for (let m = 1; m <= 12; m++) fills.push(item('a', m, 'rx_preferred', 450));
  near(replay(fills, fern, { family: false }).total, 12 * 40);
  // 2800 of deductible, then 25% of the rest
  near(replay(fills, lichen, { family: false }).total, 2800 + 0.25 * 2600);
});

test('specialty prescription: coinsurance with a floor and a ceiling per fill', () => {
  near(replay([item('a', 1, 'rx_specialty', 100)], fern, { family: false }).total, 60); // floor
  near(replay([item('a', 1, 'rx_specialty', 400)], fern, { family: false }).total, 100); // 25%
  near(replay([item('a', 1, 'rx_specialty', 5000)], fern, { family: false }).total, 180); // ceiling
  near(replay([item('a', 1, 'rx_specialty', 10000, { count: 2 })], fern, { family: false }).total, 360);
});

test('not covered: paid in full, counts toward nothing', () => {
  const r = replay([item('a', 1, 'not_covered', 500), item('a', 2, 'ded_coins', 400)], fern, { family: false });
  near(r.uncapped, 500);
  near(r.parts.ded, 400);
});

test('items are walked in date order, whatever order they arrive in', () => {
  const a = [item('a', 9, 'ded_coins', 1000), { person: 'a', date: '2099-02-10', category: 'er_facility', allowed: 1700 }];
  const b = a.slice().reverse();
  near(replay(a, fern, { family: false }).total, replay(b, fern, { family: false }).total);
});

test('fails loudly on unreadable items', () => {
  assert.throws(() => replay([item('a', 14, 'office', 100)], fern), ItemError);
  assert.throws(() => replay([item('a', 1, 'office', 'lots')], fern), ItemError);
  assert.throws(() => replay([item('', 1, 'office', 10)], fern), ItemError);
  assert.throws(() => replay([item('a', 1, 'massage', 10)], fern));
});

test('unknowns expand into variants only where they matter', () => {
  assert.strictEqual(expandVariants(lichen, { family: true, rx: false }).variants.length, 1);
  const { variants, open } = expandVariants(lichen, { family: true, rx: true });
  assert.strictEqual(variants.length, 2);
  assert.strictEqual(open.length, 1);
  const fills = [];
  for (let m = 1; m <= 12; m++) fills.push(item('a', m, 'rx_generic', 90));
  const totals = variants.map((v) => replay(fills, v.plan, { family: false }).total);
  near(totals[0], 1080);
  near(totals[1], 270);
});

test('premium lookup and tiers', () => {
  assert.strictEqual(tierFor(config, { spouse: 1, children: 2 }).id, 'family');
  assert.strictEqual(tierFor(config, { spouse: 0, children: 1 }).id, 'children');
  assert.strictEqual(tierFor(config, { spouse: 0, children: 0 }).id, 'employee');
  assert.strictEqual(premiumPerPeriod(moss, 'family', 2), 345);
  assert.strictEqual(premiumPerPeriod(moss, 'employee', 2), 105); // no spouse column: best available
});
