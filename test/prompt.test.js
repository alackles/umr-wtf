'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { agentPrompt, planFacts, ruleText, example, claimsWording, HEADER, SMALL_HEADER } = require('../src/prompt.js');
const { parseTable, addItems, COLUMNS } = require('../src/importer.js');
const { validateConfig, CATEGORIES, clone } = require('../src/plans.js');
const { replay } = require('../src/engine.js');
const { buildFromTable, defaultAnswers } = require('../src/household.js');
const { evaluate } = require('../src/outlook.js');
const { resultsText } = require('../src/report.js');

const config = validateConfig(require('../demo/plans.demo.json'));
const FENCE = '`'.repeat(3);

// The CSV code block that follows `after` in a prompt.
function csvAfter(text, after) {
  const from = text.indexOf(after);
  assert.ok(from >= 0, `prompt has no "${after}"`);
  const open = text.indexOf(FENCE + '\n', from) + 4;
  return text.slice(open, text.indexOf('\n' + FENCE, open)) + '\n';
}

for (const [kind, after] of [['frontier', 'The table for them:'], ['small', 'Reply:']]) {
  test(`${kind} prompt: the worked example reads cleanly through the importer and replays to what its EOBs show`, () => {
    const text = agentPrompt(config, kind);
    const { items, errors } = parseTable(csvAfter(text, after));
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(items.length, 6);
    const ex = example(config, claimsWording(config), kind === 'small');
    const owed = replay(items, ex.plan, { family: true }).total;
    const printed = ex.rows.reduce((s, r) => s + r.owe, 0);
    assert.ok(Math.abs(owed - printed) < 0.005, `replay ${owed} vs example EOBs ${printed}`);
    // The small prompt's table carries the EOB's amounts, which the importer adds up.
    items.forEach((it, i) => assert.ok(Math.abs(it.allowed - ex.rows[i].item.allowed) < 0.005, `row ${i + 1} comes to ${it.allowed}, the example means ${ex.rows[i].item.allowed}`));
    assert.ok(ex.rows.some((r) => r.planPaid > 0 && r.ded > 0 && r.coins > 0), 'one example row is split between the plan, the deductible and coinsurance');
  });
}

test('the header the prompts ask for is one the importer accepts', () => {
  for (const c of HEADER.concat(SMALL_HEADER)) assert.ok(COLUMNS.includes(c), c);
  assert.ok(agentPrompt(config, 'frontier').includes(HEADER.join(',')));
  const small = agentPrompt(config, 'small');
  assert.ok(small.includes(SMALL_HEADER.join(',')));
  assert.ok(!SMALL_HEADER.includes('allowed') && !small.includes(HEADER.join(',')), 'the small prompt never asks for a sum');
});

test('a row can give the EOB\'s amounts in place of the allowed amount, and the importer adds them', () => {
  const head = 'person,month,category,plan_paid,copay,deductible,coinsurance,not_covered\n';
  const { items, errors } = parseTable(head + 'Sam,6,ded_coins,556.58,0.00,245.20,98.22,0.00\nSam,7,not_covered,0.00,0.00,0.00,0.00,310.00\nSam,8,office,"$1,094.60",20,,,\n');
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(items.map((it) => it.allowed), [900, 310, 1114.6]);
  assert.ok(items.every((it) => !('plan_paid' in it) && !('copay' in it)), 'only the sum is kept');
  // Both given: they have to agree.
  assert.deepStrictEqual(parseTable('person,month,category,allowed,plan_paid,copay\nSam,1,office,114.60,94.60,20\n').errors, []);
  const off = parseTable('person,month,category,allowed,plan_paid,copay\nSam,1,office,212,94.60,20\n');
  assert.deepStrictEqual(off.items, []);
  assert.ok(/not the sum of the amounts beside it \(114\.60\)/.test(off.errors[0]));
  // Neither given, or an amount that is not one: reported.
  assert.ok(/needs an "allowed" column/.test(parseTable('person,month,category\nSam,1,office\n').errors.join(' ')));
  assert.ok(/copay "lots" is not an amount/.test(parseTable(head + 'Sam,6,office,90,lots,,,\n').errors.join(' ')));
});

const deductible = (p) => `$${p.in.ded[0].toLocaleString('en-US')} / $${p.in.ded[1].toLocaleString('en-US')}`;

test('table prompt carries every category and only the plans an EOB could come from, with no premiums', () => {
  const text = agentPrompt(config, 'frontier');
  for (const cat of CATEGORIES) assert.ok(text.includes('`' + cat + '`'), cat);
  for (const p of config.plans) {
    assert.strictEqual(text.includes(deductible(p)), !!p.currentYearOption, `${p.name} deductible`);
    for (const v of p.premiums.family) assert.ok(!text.includes(`$${v.toFixed(2)}`), `${p.name} premium`);
  }
  assert.ok(!/compare the plans|Premiums per paycheck/i.test(text));
});

test('advice prompt carries every plan, its premiums, the open plan questions, and the page\'s way of scaling', () => {
  const text = agentPrompt(config, 'advice');
  for (const cat of CATEGORIES) assert.ok(text.includes('`' + cat + '`'), cat);
  for (const p of config.plans) {
    assert.ok(text.includes(p.name), p.name);
    assert.ok(text.includes(deductible(p)), `${p.name} deductible`);
    for (const u of p.unknowns || []) assert.ok(text.includes(u.text), u.id);
    for (const v of p.premiums.family) assert.ok(text.includes(`$${v.toFixed(2)}`), `${p.name} premium`);
  }
  assert.ok(text.includes(HEADER.join(',')));
  assert.ok(/`er_facility` and `er_physician` rows, which stay exactly as they are/.test(text));
  assert.ok(/leaving each row where it is in the order/.test(text));
});

test('results as text: both money views, every plan, and the assumptions', () => {
  const answers = defaultAnswers(config, '2099-01-01');
  answers.people[0].name = 'Sam';
  const table = { items: parseTable('person,month,category,allowed\nSam,1,office,110\nSam,6,ded_coins,300\n').items, groupsOff: [] };
  const hh = buildFromTable(config, answers, table);
  const text = resultsText(config, hh);
  for (const p of config.plans) assert.strictEqual(text.split(p.name).length - 1, 2, `${p.name} appears once in each view`);
  assert.ok(text.indexOf('RAW DOLLARS') < text.indexOf('TAKE-HOME PAY'));
  assert.ok(/through June 30/.test(text));
  const raw = evaluate(config, hh, { view: 'raw' }).plans[0];
  assert.ok(text.includes(`$${Math.round(raw.scenarios.expected.lo).toLocaleString('en-US')} in all`));
});

test('small prompt stops at the table: no plan tables, no premiums, no comparison', () => {
  const text = agentPrompt(config, 'small');
  assert.ok(!text.includes('Premiums per paycheck'));
  assert.ok(!/compare the plans/i.test(text));
  assert.ok(text.length < agentPrompt(config, 'frontier').length / 2);
});

test('rules read in words', () => {
  const side = { coins: 0.15 };
  assert.strictEqual(ruleText({ free: true }, side), 'free');
  assert.strictEqual(ruleText({ copay: 0 }, side), 'free');
  assert.strictEqual(ruleText({ copay: 20 }, side), '$20 copay');
  assert.strictEqual(ruleText({ ded: true, coins: true }, side), 'deductible, then 15%');
  assert.strictEqual(ruleText({ copay: 220, coins: true }, side), '$220 copay, then 15%, no deductible');
  assert.strictEqual(ruleText({ coins: 0.25, min: 60, max: 180 }, side), '25% (at least $60, at most $180), no deductible');
});

test('EOB wording comes from the configuration, with neutral words when it has none', () => {
  const bare = clone(config);
  delete bare.claims;
  assert.ok(agentPrompt(bare, 'frontier').includes('"Services you received"'));
  const own = clone(config);
  own.claims = { table: 'What you had done', columns: { deductible: 'Went to deductible' }, labels: { er: ['A AND E'] } };
  const text = agentPrompt(own, 'small');
  assert.ok(text.includes('"What you had done"'));
  assert.ok(text.includes('"Went to deductible"'));
  assert.ok(text.includes('"A AND E"'));
  assert.ok(text.includes('"Plan paid"'), 'columns not given keep their neutral names');
});

test('a plan whose family deductible is an open question says so in the plan table', () => {
  const c = clone(config);
  c.plans[0].unknowns = [{ id: 'fam', text: 'pooled or not', options: [{ label: 'per person', patch: {} }, { label: 'pooled', patch: { 'in.dedMode': 'aggregate' } }] }];
  assert.ok(planFacts(c).includes('not known, see below'));
});

test('adding a batch: rows join the table, and repeats are counted', () => {
  const a = parseTable('person,month,category,allowed\nSam,1,office,110\nSam,2,office,110\n').items;
  const b = parseTable('person,month,category,allowed\nSam,2,office,110\nSam,3,office,110\n').items;
  const joined = addItems(a, b);
  assert.strictEqual(joined.items.length, 4);
  assert.strictEqual(joined.repeats, 1);
  assert.strictEqual(addItems(a, a).repeats, a.length);
});

test('claims tab: a planned surgery adds to the table', () => {
  const answers = defaultAnswers(config, '2099-01-01');
  answers.people[0].name = 'Sam';
  const table = { items: parseTable('person,month,category,allowed\nSam,1,office,110\n').items, groupsOff: [] };
  const before = buildFromTable(config, answers, table).items.length;
  answers.events.surgery.on = true;
  const hh = buildFromTable(config, answers, table);
  assert.strictEqual(hh.items.length, before + 1);
  assert.ok(hh.items.some((it) => it.planned && it.category === 'ded_coins'));
  assert.ok(hh.assumptions.some((as) => /surgery/.test(as.text)));
});
