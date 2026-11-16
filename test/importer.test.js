'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTable, toCsv } = require('../src/importer.js');
const { validateConfig } = require('../src/plans.js');
const { buildFromTable, defaultAnswers, newPerson } = require('../src/household.js');
const { evaluate } = require('../src/outlook.js');

const config = validateConfig(require('../demo/plans.demo.json'));

const CSV = `person,date,category,allowed,network,count,billed,group,oneoff
Sam,2099-03-14,er_facility,"$1,900.00",in,,,ER visit in March,yes
Sam,03/14/2099,er_physician,340,in,,,ER visit in March,yes
Sam,2099-01-06,office,110,,,,weekly therapy,
Sam,2099-01-06,office,45,in,0,,weekly therapy,
Ada,2099-02-02,office,190,out,,260,,
`;

test('reads CSV: money formats, both date styles, blanks as defaults', () => {
  const { items, errors } = parseTable(CSV);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(items.length, 5);
  assert.deepStrictEqual(items[0], { person: 'Sam', date: '2099-03-14', month: 3, category: 'er_facility', allowed: 1900, network: 'in', group: 'ER visit in March', oneoff: true });
  assert.strictEqual(items[1].date, '2099-03-14');
  assert.strictEqual(items[2].network, 'in');
  assert.strictEqual(items[3].count, 0);
  assert.strictEqual(items[4].billed, 260);
});

test('reads JSON, as a list or under "items"', () => {
  const list = [{ person: 'Sam', month: 4, category: 'ded_coins', allowed: 812.5 }];
  assert.strictEqual(parseTable(JSON.stringify(list)).items.length, 1);
  assert.strictEqual(parseTable(JSON.stringify({ items: list })).items[0].allowed, 812.5);
});

test('unreadable input is reported row by row, and nothing is imported', () => {
  const bad = 'person,month,category,allowed\nSam,13,massage,lots\n,2,office,100\n';
  const { items, errors } = parseTable(bad);
  assert.deepStrictEqual(items, []);
  assert.strictEqual(errors.length, 4);
  assert.match(errors[0], /row 2: month/);
  assert.match(errors[1], /row 2: category "massage"/);
  assert.match(errors[2], /row 2: allowed/);
  assert.match(errors[3], /row 3: person is missing/);
  assert.match(parseTable('person,month,category,allowed,colour\nSam,1,office,10,red').errors[0], /unknown column "colour"/);
  assert.match(parseTable('person,category,allowed\nSam,office,10').errors[0], /date.*month/);
  assert.match(parseTable('{"items": 3}').errors[0], /list of line items/);
  assert.match(parseTable('[{"person":"Sam","month":1,"category":"office","allowed":5,"mood":"fine"}]').errors[0], /unknown field "mood"/);
  assert.match(parseTable('   ').errors[0], /empty/);
});

test('round trip through CSV keeps the table', () => {
  const first = parseTable(CSV).items;
  const again = parseTable(toCsv(first)).items;
  assert.deepStrictEqual(again.map((it) => [it.person, it.month, it.category, it.allowed, it.network, it.count, it.billed, it.group, it.oneoff]), first.map((it) => [it.person, it.month, it.category, it.allowed, it.network, it.count, it.billed, it.group, it.oneoff]));
});

test('an imported table drives the same engine: group switches build scenarios', () => {
  const a = defaultAnswers(config, '2099-12-31');
  a.people = [Object.assign(newPerson('p1', 'self'), { name: 'Sam' }), Object.assign(newPerson('p2', 'spouse'), { name: 'Ada' })];
  const table = { items: parseTable(CSV).items, groupsOff: [], oneoffGroups: {} };
  const hh = buildFromTable(config, a, table);
  assert.deepStrictEqual(hh.problems, []);
  assert.strictEqual(hh.tierId, 'spouse');
  const full = evaluate(config, hh, { view: 'raw' }).plans[0].scenarios;
  assert.ok(full.quiet.lo < full.expected.lo, 'the ER visit is a one-off, so the quiet year leaves it out');
  // Switch the ER group off: the expected year falls to the quiet year.
  table.groupsOff.push('ER visit in March');
  const without = evaluate(config, buildFromTable(config, a, table), { view: 'raw' }).plans[0].scenarios;
  assert.ok(Math.abs(without.expected.lo - full.quiet.lo) < 0.01);
  // A name in the table that is not in the people list blocks, loudly.
  a.people.pop();
  assert.ok(buildFromTable(config, a, table).problems.some((p) => p.blocking && /Ada/.test(p.text)));
});
