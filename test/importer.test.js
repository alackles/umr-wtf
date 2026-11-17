'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTable, toCsv } = require('../src/importer.js');
const { validateConfig } = require('../src/plans.js');
const { buildFromTable, tableThrough, defaultAnswers, newPerson } = require('../src/household.js');
const { evaluate } = require('../src/outlook.js');

const config = validateConfig(require('../demo/plans.demo.json'));

const CSV = `person,date,category,allowed,network,count,billed,group
Sam,2099-03-14,er_facility,"$1,900.00",in,,,ER visit in March
Sam,03/14/2099,er_physician,340,in,,,ER visit in March
Sam,2099-01-06,office,110,,,,weekly therapy
Sam,2099-01-06,office,45,in,0,,weekly therapy
Ada,2099-02-02,office,190,out,,260,
`;

test('reads CSV: money formats, both date styles, blanks as defaults', () => {
  const { items, errors } = parseTable(CSV);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(items.length, 5);
  assert.deepStrictEqual(items[0], { person: 'Sam', date: '2099-03-14', month: 3, category: 'er_facility', allowed: 1900, network: 'in', group: 'ER visit in March' });
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
  assert.deepStrictEqual(again.map((it) => [it.person, it.month, it.category, it.allowed, it.network, it.count, it.billed, it.group]), first.map((it) => [it.person, it.month, it.category, it.allowed, it.network, it.count, it.billed, it.group]));
});

test('an imported table drives the same engine: group switches build scenarios', () => {
  const a = defaultAnswers(config, '2099-12-31');
  a.people = [Object.assign(newPerson('p1', 'self'), { name: 'Sam' }), Object.assign(newPerson('p2', 'spouse'), { name: 'Ada' })];
  const table = { items: parseTable(CSV).items, groupsOff: [] };
  const hh = buildFromTable(config, a, table);
  assert.deepStrictEqual(hh.problems, []);
  assert.strictEqual(hh.tierId, 'spouse');
  const full = evaluate(config, hh, { view: 'raw' }).plans[0].scenarios;
  // Switch the ER group off: it leaves the typical year.
  table.groupsOff.push('ER visit in March');
  const without = evaluate(config, buildFromTable(config, a, table), { view: 'raw' }).plans[0].scenarios;
  assert.ok(without.expected.lo < full.expected.lo - 1);
  // A name in the table that is not in the people list blocks, loudly.
  a.people.pop();
  assert.ok(buildFromTable(config, a, table).problems.some((p) => p.blocking && /Ada/.test(p.text)));
});

// ---- a part year, scaled to twelve months ----------------------------------------------------
function household(csv, through) {
  const a = defaultAnswers(config, '2099-01-01');
  a.people[0].name = 'Sam';
  const table = { items: parseTable(csv).items, groupsOff: [], through: through || null };
  return { a, table, hh: buildFromTable(config, a, table) };
}
const sum = (items, pick) => items.reduce((s, it) => s + pick(it), 0);
const HALF = 'person,month,category,allowed,count\nSam,1,office,110,\nSam,3,er_facility,1900,\nSam,6,ded_coins,300,\nSam,6,office,40,0\n';

test('a table that stops in June is doubled, except its ER visit', () => {
  const { hh } = household(HALF);
  assert.strictEqual(hh.through.factor, 2);
  const by = (cat) => hh.items.filter((it) => it.category === cat);
  assert.strictEqual(sum(by('office'), (it) => it.allowed), 2 * (110 + 40));
  assert.strictEqual(sum(by('office'), (it) => it.count), 2, 'one visit becomes two; the line riding on a visit stays at none');
  assert.strictEqual(by('ded_coins')[0].allowed, 2 * 300);
  assert.strictEqual(by('er_facility')[0].allowed, 1900);
  assert.strictEqual(by('er_facility')[0].count, undefined);
  for (const it of hh.items) assert.ok(it.month >= 1 && it.month <= 12 && /^\d{4}-\d\d-\d\d$/.test(it.date), `month ${it.month}, date ${it.date}`);
  assert.ok(hh.assumptions.some((as) => /through June 30/.test(as.text)));
  assert.ok(hh.assumptions.some((as) => /ER visits are counted as they happened/.test(as.text)));
});

test('a table that runs through December is left exactly as given', () => {
  const { hh, table } = household(HALF + 'Sam,12,office,110,\n');
  assert.strictEqual(hh.through.factor, 1);
  assert.strictEqual(sum(hh.items, (it) => it.allowed), sum(table.items, (it) => it.allowed));
  assert.ok(hh.assumptions.some((as) => /covers the whole year/.test(as.text)));
});

test('dated lines set the scale by the day, and a later date can be chosen but not an earlier one', () => {
  const dated = 'person,date,category,allowed\nSam,2099-02-10,office,110\nSam,2099-07-02,office,110\n';
  const auto = tableThrough(config, { items: parseTable(dated).items });
  assert.strictEqual(auto.iso, '2099-07-02');
  assert.ok(Math.abs(auto.months - (12 * 183) / 365) < 1e-9);
  const later = tableThrough(config, { items: parseTable(dated).items, through: '2099-09-30' });
  assert.ok(later.chosen && later.factor < auto.factor);
  const earlier = tableThrough(config, { items: parseTable(dated).items, through: '2099-03-01' });
  assert.ok(!earlier.chosen);
  assert.strictEqual(earlier.iso, '2099-07-02');
  assert.strictEqual(household(dated, '2099-12-31').hh.through.factor, 1);
});

test('scaling and leaving mid-year together: half the stretched year is about the half that happened', () => {
  const { a, table } = household('person,month,category,allowed\n' + [1, 2, 3, 4, 5, 6].map((m) => `Sam,${m},ded_coins,100`).join('\n') + '\n');
  a.events.leaving = { on: true, month: 6 };
  const hh = buildFromTable(config, a, table);
  assert.strictEqual(sum(hh.items, (it) => it.allowed), 600);
});

test('scaling keeps the year in the order it happened, ER lines included', () => {
  // Order decides who fills a pooled deductible, so the scaled year must cost exactly what
  // the same lines cost when they are scaled where they stand. An agent following the advice
  // prompt does the second; the page does the first; the two have to agree.
  const csv = 'person,date,category,allowed\n' +
    ['Sam,2099-01-20,ded_coins,900', 'Ada,2099-02-03,ded_coins,700', 'Sam,2099-02-27,er_facility,1900', 'Ada,2099-03-02,ded_coins,1200', 'Sam,2099-03-30,ded_coins,2500', 'Ada,2099-04-14,office,180', 'Sam,2099-05-05,ded_coins,3100', 'Ada,2099-06-19,ded_coins,800'].join('\n') + '\n';
  const a = defaultAnswers(config, '2099-01-01');
  a.people = [newPerson('p1', 'self', 'Sam'), newPerson('p2', 'child', 'Ada')];
  const table = { items: parseTable(csv).items, groupsOff: [] };
  const hh = buildFromTable(config, a, table);
  const f = hh.through.factor;
  assert.ok(f > 2 && f < 2.2);
  const inPlace = table.items.map((it) => (/^er_/.test(it.category) ? Object.assign({}, it) : Object.assign({}, it, { allowed: it.allowed * f, count: f })));
  const id = { Sam: 'p1', Ada: 'p2' };
  for (const it of inPlace) it.person = id[it.person];
  const { replay } = require('../src/engine.js');
  for (const plan of config.plans) {
    const page = replay(hh.items, plan, { family: true }).memberTotal;
    const agent = replay(inPlace, plan, { family: true }).memberTotal;
    assert.ok(Math.abs(page - agent) < 1e-6, `${plan.name}: page ${page} vs scaled in place ${agent}`);
  }
});
