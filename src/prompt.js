'use strict';
// The agent prompts for the real-claims path. Three of them:
//   frontier  for large hosted models: read the EOBs, build the table, check it, ask
//   small     for small local models: copy EOB rows into the table and nothing else
//   advice    for large hosted models: work out each plan's cost from a finished table, and
//             talk the choice through. Kept apart from the first so that making the table
//             carries nothing it does not need, and so the agent's sums stay independent of
//             the page's.
//
// Plan facts and the administrator's EOB wording come from the configuration, so nothing in
// this file knows any particular plan. The worked example is priced by the engine under one
// of the configured plans, so what the example shows always agrees with the plan facts
// printed above it.
//
// Written for more than one vendor's models: plain Markdown headings, the reason beside each
// instruction, one worked example, an ordered list for choosing a category, no capitals for
// emphasis, and a single place that says when to stop.

const { CATEGORIES, CATEGORY_LABELS } = require('./plans.js');
const { replay } = require('./engine.js');

const HEADER = ['person', 'date', 'category', 'allowed', 'network', 'count', 'billed', 'group'];

// How the administrator's EOBs are laid out. A configuration can replace any of this under
// "claims"; these are neutral stand-ins.
const DEFAULT_CLAIMS = {
  where: 'Download your EOBs as PDF files from your plan administrator\'s member site.',
  table: 'Services you received',
  totals: 'Totals',
  columns: {
    billed: 'Amount billed',
    discount: 'Discount',
    planPaid: 'Plan paid',
    copay: 'Copay',
    deductible: 'Deductible',
    coinsurance: 'Coinsurance',
    notCovered: 'Not covered',
    owe: 'You may owe',
  },
  accumulators: 'Each EOB also shows how much of each deductible and out-of-pocket limit had been used when it was issued.',
  labels: { er: [], preventive: [] },
  quirks: [], // things about this administrator's EOB layout that trip a reader up
  thisYear: 'Unless the EOBs show otherwise, assume this year\'s version of each plan had the same rules as next year\'s.',
};

function claimsWording(config) {
  const given = (config && config.claims) || {};
  return Object.assign({}, DEFAULT_CLAIMS, given, {
    columns: Object.assign({}, DEFAULT_CLAIMS.columns, given.columns),
    labels: Object.assign({}, DEFAULT_CLAIMS.labels, given.labels),
  });
}

const usd = (n) => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cents = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const pair = (p) => `${usd(p[0])} / ${usd(p[1])}`;
const quoted = (list) => list.map((s) => `"${s}"`).join(', ');
const row = (cells) => `| ${cells.join(' | ')} |`;

// One cost-sharing rule in words. `side` is the plan's in- or out-of-network block.
function ruleText(rule, side) {
  if (!rule) return '';
  if (rule.free) return 'free';
  if (rule.uncovered) return 'you pay all of it, and it counts toward nothing';
  const bits = [];
  if (rule.copay > 0) bits.push(`${usd(rule.copay)} copay`);
  if (rule.ded) bits.push('deductible');
  if (rule.coins) {
    let t = pct(rule.coins === true ? side.coins : rule.coins);
    const lim = [rule.min != null ? `at least ${usd(rule.min)}` : null, rule.max != null ? `at most ${usd(rule.max)}` : null].filter(Boolean);
    if (lim.length) t += ` (${lim.join(', ')})`;
    bits.push(t);
  }
  if (!bits.length) return 'free';
  let text = bits.join(', then ');
  if (rule.coins && !rule.ded) text += ', no deductible';
  return text;
}

const patches = (plan, key) => (plan.unknowns || []).some((u) => u.options.some((o) => o.patch && key in o.patch));

function dedModeText(plan, side) {
  if (patches(plan, `${side}.dedMode`)) return 'not known, see below';
  return plan[side].dedMode === 'aggregate' ? 'one pooled deductible for the whole family' : 'each person has their own, and the family figure caps the total';
}

// Plans as Markdown: all of them, or `opts.plans`. `opts.premiums` adds what a comparison
// needs beyond cost-sharing.
function planFacts(config, opts = {}) {
  const plans = opts.plans || config.plans;
  const names = plans.map((p) => p.name);
  const out = [];
  const head = (first) => [row([first].concat(names)), row(['---'].concat(names.map(() => '---')))];

  out.push(...head(''));
  if (!opts.plans) out.push(row(['Offered this year'].concat(plans.map((p) => (p.currentYearOption ? 'yes' : 'no')))));
  out.push(row(['Deductible, in-network (one person / family)'].concat(plans.map((p) => pair(p.in.ded)))));
  out.push(row(['How the family deductible works'].concat(plans.map((p) => dedModeText(p, 'in')))));
  out.push(row(['Your share after the deductible, in-network'].concat(plans.map((p) => pct(p.in.coins)))));
  out.push(row(['Out-of-pocket limit, in-network (one person / family)'].concat(plans.map((p) => pair(p.in.oop)))));
  out.push(row(['Deductible, out-of-network'].concat(plans.map((p) => pair(p.out.ded)))));
  out.push(row(['Your share after the deductible, out-of-network'].concat(plans.map((p) => pct(p.out.coins)))));
  out.push(row(['Out-of-pocket limit, out-of-network'].concat(plans.map((p) => pair(p.out.oop)))));
  out.push('');
  out.push('Copays, deductible payments and coinsurance all count toward the out-of-pocket limit. In-network and out-of-network amounts are tracked separately.');
  out.push('');
  out.push('What you pay for each kind of care, in-network. The first column is the category name the table uses.');
  out.push('');
  out.push(row(['Category', 'Kind of care'].concat(names)), row(['---', '---'].concat(names.map(() => '---'))));
  for (const cat of CATEGORIES) {
    out.push(row(['`' + cat + '`', CATEGORY_LABELS[cat]].concat(plans.map((p) => ruleText(p.rules[cat], p.in)))));
  }
  out.push('');
  out.push('Out-of-network care:');
  out.push('');
  for (const p of plans) {
    const exceptions = Object.entries(p.outRules)
      .filter(([cat]) => cat !== 'default' && cat !== 'not_covered')
      .map(([cat, r]) => `\`${cat}\` ${ruleText(r, p.out)}${r.acc === 'in' ? ' (counts toward the in-network limits)' : ''}`);
    out.push(`- ${p.name}: ${ruleText(p.outRules.default, p.out)}${exceptions.length ? `. Exceptions: ${exceptions.join('; ')}` : ''}.`);
  }
  out.push('- On every plan, whatever an out-of-network provider bills above the allowed amount is mine to pay and counts toward nothing.');

  const unknowns = [];
  for (const p of plans) for (const u of p.unknowns || []) unknowns.push(`- ${p.name}: ${u.text}. Work it out each way and show both: ${u.options.map((o) => o.label).join('; or ')}.`);
  if (unknowns.length) out.push('', 'Not known:', '', ...unknowns);
  const absent = config.plans.filter((p) => !plans.includes(p));
  const notes = (config.ruleNotes || []).filter((n) => !absent.some((p) => n.includes(p.name) || n.includes(p.short)));
  if (notes.length) out.push('', 'Notes on these plans:', '', ...notes.map((n) => `- ${n}`));

  if (opts.premiums) {
    const per = config.payPeriods.premium;
    out.push('');
    out.push(`Premiums per paycheck, ${per} paychecks a year.${config.credits ? ` Where a cell has more than one figure they are, in order: ${config.credits.labels.join(' / ')}.` : ''}`);
    out.push('');
    out.push(...head('Who is covered'));
    for (const tier of config.tiers) out.push(row([tier.label].concat(plans.map((p) => p.premiums[tier.id].map(cents).join(' / ')))));
    const extra = [];
    if (config.spousalSurcharge) extra.push(`- Spousal surcharge: ${usd(config.spousalSurcharge.monthly)} a month. ${config.spousalSurcharge.text}`);
    const fsa = plans.filter((p) => p.account === 'fsa').map((p) => p.name);
    const hsa = plans.filter((p) => p.account === 'hsa').map((p) => p.name);
    if (config.fsa && fsa.length) extra.push(`- FSA (${fsa.join(', ')}): up to ${usd(config.fsa.limit)} a year, before tax.`);
    if (config.hsa && hsa.length) extra.push(`- HSA (${hsa.join(', ')}): up to ${usd(config.hsa.single)} a year for one person, ${usd(config.hsa.family)} for a family, before tax.`);
    if (extra.length) out.push('', ...extra);
  }
  return out.join('\n');
}

const VISIT = { office: 'an office, specialist or therapy visit', urgent: 'urgent care', teladoc: 'a telehealth visit' };

// How to choose a category, as an ordered list keyed on how this year's plan treated the row.
function categoryGuide(config, c) {
  const current = config.plans.filter((p) => p.currentYearOption);
  const plans = current.length ? current : config.plans;
  const col = c.columns;
  const byAmount = new Map();
  for (const p of plans) {
    for (const cat of Object.keys(VISIT)) {
      const r = p.rules[cat];
      if (!r || !(r.copay > 0) || r.ded || r.coins) continue;
      if (!byAmount.has(r.copay)) byAmount.set(r.copay, new Set());
      byAmount.get(r.copay).add(cat);
    }
  }
  const erSkipsDeductible = plans.every((p) => !p.rules.er_facility.ded);
  const such = (list) => (list && list.length ? ` (labels such as ${quoted(list)})` : '');

  const out = [];
  out.push(`1. The row has an amount under "${col.notCovered}": \`not_covered\`. Use that amount as \`allowed\`, and say in the \`group\` label what the care was ("ER visit in March, refused").`);
  out.push(
    `2. The claim is an emergency-room visit: at least one of its rows is labelled as emergency care${such(c.labels.er)}${erSkipsDeductible ? `, and nothing on the claim went to "${col.deductible}"` : ''}. ` +
      'Put the whole claim in as a single row: `er_facility` if the provider is a hospital or other facility, `er_physician` if it is a doctor or a physician group. ' +
      `Work out \`allowed\` from the "${c.totals}" row. The claim's other rows (drugs, labs, imaging) are part of the visit, and the copay is charged once per visit and can be spread over several rows, which is why the claim goes in whole.`
  );
  if (byAmount.size) {
    out.push(`3. A copay was charged. Go by the amount under "${col.copay}":`);
    for (const [amount, cats] of [...byAmount].sort((a, b) => b[0] - a[0])) {
      const list = [...cats];
      out.push(`   - ${usd(amount)}: ${list.map((cat) => `\`${cat}\` (${VISIT[cat]})`).join(' or ')}${list.length > 1 ? ', whichever the visit was' : ''}`);
    }
    out.push('   - any other amount: go by what the visit was.');
  } else {
    out.push('3. The row is a visit to a doctor, therapist or clinic: `office`. Urgent care is `urgent`, and a telehealth visit is `teladoc`.');
  }
  out.push(`4. Something went to "${col.deductible}", or there is an amount under "${col.coinsurance}": \`ded_coins\`. This covers hospital, outpatient, lab and imaging charges, and anything else billed on its own.`);
  out.push(`5. The plan paid the whole allowed amount and nothing was charged:`);
  out.push(`   - \`preventive\` if it is preventive care: a checkup, a vaccine, a screening${such(c.labels.preventive)}. A lab or other extra on the same claim as a checkup, or on the same day at the same provider, is preventive too.`);
  out.push('   - otherwise `office` with `count` 0. That means the row rode along with a visit or a treatment of some other kind, such as a lab drawn during an office visit. This one is a guess, so list every row you put here.');
  return out.join('\n');
}

// The worked example: three invented EOBs and the rows they become. The amounts each row was
// charged come from replaying the rows under a configured plan.
function example(config, c, small) {
  const plan = config.plans.find((p) => p.currentYearOption) || config.plans[0];
  const year = config.planYear - 1;
  const prev = (c.labels.preventive && c.labels.preventive[0]) || 'IMMUNIZATION';
  const src = [
    { eob: 1, patient: 'SAM RIVERA', provider: 'NORTHSIDE FAMILY CLINIC', service: 'PHYSICIAN VISIT', billed: 212, item: { person: 'Sam', date: `${year}-03-11`, category: 'office', allowed: 114.6, group: small ? 'Northside Family Clinic' : 'office visits' } },
    { eob: 1, patient: 'SAM RIVERA', provider: 'NORTHSIDE FAMILY CLINIC', service: 'DIAGNOSTIC LAB', billed: 58, item: { person: 'Sam', date: `${year}-03-11`, category: 'office', allowed: 36.25, count: 0, group: small ? 'Northside Family Clinic' : 'office visits' } },
    { eob: 2, patient: 'SAM RIVERA', provider: 'LAKESHORE HOSPITAL', service: 'DIAGNOSTIC X-RAY', billed: 340, item: { person: 'Sam', date: `${year}-04-02`, category: 'ded_coins', allowed: 154.8, group: small ? 'Lakeshore Hospital' : 'knee X-ray in April' } },
    { eob: 3, patient: 'ADA RIVERA', provider: 'NORTHSIDE FAMILY CLINIC', service: prev, billed: 96, item: { person: 'Ada', date: `${year}-04-20`, category: 'preventive', allowed: 65.9, group: small ? 'Northside Family Clinic' : 'checkups and vaccines' } },
  ];
  const res = replay(src.map((s) => s.item), plan, { family: true });
  const rows = src.map((s, i) => {
    const l = res.lines.find((x) => x.index === i);
    const r2 = (n) => Math.round(n * 100) / 100;
    const copay = r2(l.copay);
    const ded = r2(l.ded);
    const coins = r2(l.coins);
    return Object.assign({}, s, { copay, ded, coins, owe: r2(copay + ded + coins), planPaid: r2(s.item.allowed - copay - ded - coins), discount: r2(s.billed - s.item.allowed) });
  });

  const col = c.columns;
  const mdy = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}`;
  const eobText = [];
  for (const n of [1, 2, 3]) {
    const mine = rows.filter((r) => r.eob === n);
    const sum = (k) => cents(mine.reduce((s, r) => s + r[k], 0));
    eobText.push(`EOB ${n}. Patient: ${mine[0].patient}. Provider: ${mine[0].provider}.`);
    eobText.push([c.table, 'Service date', col.billed, col.discount, col.planPaid, col.copay, col.deductible, col.coinsurance, col.notCovered, col.owe].join(' | '));
    for (const r of mine) eobText.push([r.service, mdy(r.item.date), cents(r.billed), cents(r.discount), cents(r.planPaid), cents(r.copay), cents(r.ded), cents(r.coins), cents(0), cents(r.owe)].join(' | '));
    eobText.push([c.totals, '', sum('billed'), sum('discount'), sum('planPaid'), sum('copay'), sum('ded'), sum('coins'), cents(0), sum('owe')].join(' | '));
    eobText.push('');
  }
  eobText.pop();

  const csv = [HEADER.join(',')];
  for (const r of rows) {
    const it = r.item;
    csv.push([it.person, it.date, it.category, it.allowed.toFixed(2), 'in', it.count === 0 ? '0' : '', '', it.group].join(','));
  }

  const [visit, lab, xray, shot] = rows;
  const why = [];
  why.push(visit.copay > 0 ? `- The visit was charged a ${usd(visit.copay)} copay, so it is \`office\`.` : '- The first row is a visit to a doctor, so it is `office`.');
  why.push(`- The lab on the same day was paid in full (the plan paid all ${cents(lab.item.allowed)} of it) and is not preventive care, so it is \`office\` with \`count\` 0. That is a guess, so it is listed.`);
  why.push(xray.ded > 0 || xray.coins > 0 ? `- The X-ray went to the deductible or coinsurance (${cents(xray.owe)} owed), so it is \`ded_coins\`.` : '- The X-ray was billed on its own by a hospital, so it is `ded_coins`.');
  why.push(`- The ${prev.toLowerCase()} was paid in full and is preventive care, so it is \`preventive\`.`);
  why.push(`- In every row, \`allowed\` is "${col.planPaid}" plus "${col.copay}" plus "${col.deductible}" plus "${col.coinsurance}". For the visit that is ${cents(visit.planPaid)} + ${cents(visit.copay)} + ${cents(visit.ded)} + ${cents(visit.coins)} = ${cents(visit.item.allowed)}.`);

  return {
    plan,
    rows,
    owed: res.total,
    eobText: eobText.join('\n'),
    csv: csv.join('\n'),
    why: why.join('\n'),
    guesses: `Guesses:\n- Sam, ${lab.item.date}, ${lab.service.toLowerCase()}, ${cents(lab.item.allowed)}: read as part of the office visit that day. It could be preventive.`,
  };
}

// How one row is charged under a plan, in words. The engine's rules, for an agent replaying a
// year by itself.
function replayRules() {
  return [
    'To replay a row, find the plan\'s rule for its category and network in the tables above. Then, in this order:',
    '',
    '- Copay, if the rule has one: the copay times `count`, and never more than the row\'s allowed amount. An empty count is 1. A count of 0 means no copay; the rest of the rule still applies to the row.',
    '- Deductible, if the rule names it: what is left of the allowed amount goes to the deductible, until that person\'s deductible or the family\'s is met. Where the family deductible is one pooled figure, there is no separate deductible for each person.',
    '- Coinsurance, if the rule has a percentage: my share of what is still left.',
    '- Nothing more is charged once that person\'s out-of-pocket limit, or the family\'s, is reached; a row that crosses a limit is charged only up to it. The limit for one person applies on every plan. Copays, deductible payments and coinsurance all count toward it.',
    '',
    'Take rows on the same date in the table\'s order, and do not round until the end. Keep separate running totals for in-network and out-of-network rows, except where the plan table says a row counts toward the in-network limits. `preventive` rows cost nothing. `not_covered` rows are mine in full and count toward nothing. On an out-of-network row, whatever was billed above the allowed amount is also mine and counts toward nothing.',
  ].join('\n');
}

const fence = (text) => '```\n' + text + '\n```';

function columnsGuide(c, small) {
  const col = c.columns;
  const out = [
    '- `person`: the patient\'s first name, spelled the same way every time. The patient is the person named on the claim, who is often not the person the EOB is addressed to.',
    '- `date`: the service date, as YYYY-MM-DD.',
    '- `category`: chosen with the list below.',
    `- \`allowed\`: the plan's allowed amount for the row, which is "${col.planPaid}" + "${col.copay}" + "${col.deductible}" + "${col.coinsurance}". Dollars and cents, no dollar sign. Use this and not "${col.billed}", because every plan works from the allowed amount.`,
    '- `network`: `out` if the EOB says the claim was processed at the out-of-network level. Otherwise `in`, including when it says nothing.',
    small ? '- `count`: leave empty, except for the 0 that line 5 of the category list asks for.' : '- `count`: leave empty, except for the 0 that line 5 of the category list asks for, and the number of fills on a prescription row.',
    `- \`billed\`: leave empty, except on out-of-network rows, where it is "${col.billed}".`,
  ];
  out.push(
    small
      ? '- `group`: the provider\'s name as the EOB prints it.'
      : '- `group`: a short label, so that I can switch related rows off together in the tool. Give a one-off event its own label ("ER visit in March"), give recurring care a shared one ("therapy", "monthly hospital treatment"), and put ordinary visits under something plain ("office visits"). Name groups from what you can see, such as the provider and the month; I can rename them. Put the person\'s name in the label when two people have the same kind of care.'
  );
  return out.join('\n');
}

// For large hosted models, part one: EOBs in, a checked table out. It carries only the plans
// an EOB could have come from, and no premiums: nothing here compares plans.
function tablePrompt(config) {
  const c = claimsWording(config);
  const col = c.columns;
  const ex = example(config, c, false);
  const offered = config.plans.filter((p) => p.currentYearOption);
  const plans = offered.length ? offered : config.plans;
  const owedCols = `"${col.copay}" + "${col.deductible}" + "${col.coinsurance}"`;
  const p = [];

  p.push('# Turn my medical claims into a table');
  p.push(
    `My household's medical plan is run by ${config.administrator}. With this message I am giving you our Explanation of Benefits documents (EOBs) for this year. ` +
      'Please turn them into a table of the care we actually received, and check that table against the EOBs. I will use the table to compare plans for next year.'
  );
  p.push('Three things to know before you start:');
  p.push(
    [
      '- A separate tool will take your table, scale a part year up to twelve months, and do the sums. So the table should hold only what happened. Please do not add rows for months that have not happened yet.',
      '- I may send the EOBs in several batches. Keep one running table. After each batch, tell me how many EOBs you have read so far and ask whether there are more before you go on.',
      '- If you can run code, use it for the arithmetic. Adding long columns of dollars without it is where this job usually goes wrong.',
    ].join('\n')
  );

  p.push('## The plan we are on');
  p.push(plans.length > 1 ? `Our EOBs come from one of these ${plans.length} plans. You will work out which in the checks below.` : 'Our EOBs come from this plan.');
  p.push(planFacts(config, { plans }));
  p.push(c.thisYear);

  p.push('## Reading an EOB');
  p.push(
    `Each EOB is one claim for one patient. Its table, "${c.table}", has one row per service and a "${c.totals}" row at the bottom. ` +
      `From each service row I need the patient, the service date, and the amounts under "${col.planPaid}", "${col.copay}", "${col.deductible}", "${col.coinsurance}" and "${col.notCovered}".`
  );
  p.push(
    [
      '- Leave out a row only when all five of those amounts are zero. The EOB\'s other columns are not needed.',
      '- The service labels are coarse: one label can cover a visit with a copay, a checkup and urgent care. The copay amount, the provider\'s name and credentials, and what else was billed that day tell you more.',
      '- A claim can be processed more than once. Treat two EOBs as the same claim when the patient, the provider and the service date match, even if the claim number differs, and use the later one. Leave out an EOB that only refuses a duplicate of a claim. If the original of a refused duplicate is not among the EOBs I gave you, an EOB is probably missing. Tell me about every claim you handled in one of these ways.',
      `- ${c.accumulators} You will use these in the checks below.`,
      '- Prescriptions filled at a pharmacy are not in these EOBs. You will ask me about them later.',
    ]
      .concat(c.quirks.map((q) => `- ${q}`))
      .join('\n')
  );

  p.push('## The table');
  p.push('The table is CSV with this header row, and one row for each service row on an EOB:');
  p.push(fence(HEADER.join(',')));
  p.push(columnsGuide(c, false));

  p.push('## Choosing the category');
  p.push('The EOB\'s service label alone will not tell you the category. How the plan treated the row will. Use the first line that fits:');
  p.push(categoryGuide(config, c));
  p.push(
    [
      'Three more things about categories:',
      '',
      '- The reason line 5 is a guess: both answers cost nothing on a plan with copays, but on a plan that sends office visits to the deductible, a preventive row is free and the other kind is not. I may be comparing against a plan like that, so pick the likelier one and list it.',
      '- Once someone has reached their out-of-pocket limit, the plan pays everything in full, so lines 3 to 5 stop telling you anything about that person. From then on, go by what the service was and match their earlier rows of the same kind.',
      '- The `rx_` categories are for prescriptions and come from my answers, not from the EOBs.',
    ].join('\n')
  );

  p.push('## An example');
  p.push(`Three invented EOBs, shown in simplified form. The household is on this plan: ${ex.plan.name}.`);
  p.push(fence(ex.eobText));
  p.push('The table for them:');
  p.push(fence(ex.csv));
  p.push(ex.why);
  p.push(ex.guesses);

  p.push('## Check your reading before going on');
  p.push(
    [
      `1. For every EOB, the rows you copied add up to its "${c.totals}" row, column by column. If one does not, read it again.`,
      `2. ${plans.length > 1 ? `Work out which plan we are on from the in-network deductible limit for one person that the EOBs print (it will be one of: ${plans.map((x) => x.name).join(', ')}). Then replay` : 'Replay'} the year under that plan: walk your rows in date order, keeping a running deductible and out-of-pocket total for each person and for the family. What your replay says each person owed should match what the EOBs say they owed, which is the sum of ${owedCols} across their EOBs, to the dollar. Leave \`not_covered\` rows out of both sides. Where the two differ, look for rows whose category gives a different charge from the one the EOB shows, and fix them.`,
      '3. Compare each person\'s total with the in-network out-of-pocket figure for that person on their latest EOB (the latest notice date; if several share it, the highest figure). A gap usually means a missing EOB or pharmacy copays, which count toward that figure and are not in these documents. Tell me the gap and what you think explains it.',
    ].join('\n')
  );
  p.push(replayRules());
  p.push(
    'If, after a second look, check 1 or check 2 is still off by more than a dollar for anyone, stop there. Show me the difference for each person and the rows you suspect, and wait for my answer. A table that does not reproduce this year is not worth comparing plans with.'
  );

  p.push('## Then ask me');
  p.push('In one message, please ask about:');
  p.push(
    [
      '1. Prescriptions. For each regular prescription: who takes it, whether it is generic, preferred brand, non-preferred brand or specialty, how many fills a month, and the full price before insurance if I can find it (a pharmacy receipt shows it). Add one row for each prescription for each month it was filled this year, with `allowed` the full price of that month\'s fills and `count` the number of fills. If I do not know the full price, use your best estimate and list it as a guess.',
      '2. Your guesses. Every row where you chose a category without being sure, with the choice you made.',
      '3. Rows marked `not_covered`. These are often claims the plan refused while it waited for information, not care it will never pay for. Ask whether each has since been paid, and whether I expect that kind of care to be covered next year. If so, enter it again as the care it was: an emergency-room claim as line 2 says, a visit as `office`, anything else as `ded_coins`. Use the amount shown as `allowed`, and tell me that the true allowed amount is probably lower, because a refused claim shows no discount.',
      '4. Care that is ending, or that happened only once. Give each of these its own `group` label, so that I can switch it off in the tool.',
    ].join('\n')
  );

  p.push('## What I need back at the end');
  p.push(
    [
      '1. The whole table as CSV in one code block, header row included, ready to paste into the tool.',
      `2. For each person, how many EOBs you read and what those EOBs say we owed in total (${owedCols}), with "${col.notCovered}" amounts given separately. I am the one who has to check your table against my real claims, and these are the numbers I will check first.`,
      '3. The list of guesses.',
      '4. Anything you could not read or could not reconcile.',
    ].join('\n')
  );
  p.push('If the conversation is getting long before you reach the end, give me the table so far as CSV so nothing is lost.');
  return p.join('\n\n') + '\n';
}

// For large hosted models, part two: the table in, a second opinion out. The agent works out
// each plan's cost for itself, by the same method the page uses, so the two can be compared.
function advicePrompt(config) {
  const p = [];
  p.push('# Help me choose a medical plan from this year\'s claims');
  p.push(
    `I am choosing a medical plan for ${config.planYear} from the ${config.plans.length} my employer offers through ${config.administrator}. ` +
      'I have a table of the care my household received this year, one row per service, made from our Explanation of Benefits documents. ' +
      'If the table is not already in this conversation, I will paste it below. Please work out what the same care would cost on each plan, and help me think the choice through.'
  );
  p.push('If you can run code, use it for the arithmetic.');

  p.push('## The plans');
  p.push(planFacts(config, { premiums: true }));

  p.push('## The table');
  p.push('It is CSV with this header row:');
  p.push(fence(HEADER.join(',')));
  p.push(
    [
      '- `person`: who the care was for.',
      '- `date`: the service date.',
      '- `category`: one of the category names in the plan table above.',
      '- `allowed`: the plan\'s allowed amount for the row, which is what the plan paid plus what we owed. Every plan works from this amount.',
      '- `network`: `in` or `out`. Empty means `in`.',
      '- `count`: how many visits or fills the row stands for. Empty means 1. A count of 0 means the row rode along with a visit that is already counted, so it is charged no copay of its own.',
      '- `billed`: on out-of-network rows, what the provider billed.',
      '- `group`: a label for rows that belong together.',
    ].join('\n')
  );

  p.push('## First, ask me');
  p.push('In one message, please ask:');
  p.push(
    [
      '1. Who will be covered next year, and which premium figure applies to us.',
      '2. What will be different next year: care that is ending or starting, anything planned such as a surgery or a birth, someone joining or leaving the plan.',
      '3. Whether I plan to put money into an FSA or an HSA.',
      '4. Roughly what my combined tax rate is. If I do not know, use 30% and say that you did.',
    ].join('\n')
  );

  p.push('## Then work out a full year on each plan');
  p.push(
    [
      '1. Scale the table to twelve months. It holds only what happened this year. Find the latest date in it and work out how many months of the year that covers (the day of the year, divided by 365, times 12). Multiply `allowed`, `count` and `billed` on every row by 12 divided by that number, leaving each row where it is in the order. An empty count is 1 and is scaled like any other, so counts become fractions: 1.2 visits is 1.2 copays. The exception is `er_facility` and `er_physician` rows, which stay exactly as they are. The tool I am using scales the table this way, and doing the same lets your numbers be compared with its numbers.',
      '2. Apply what I told you about next year. Care that is ending comes out. Anything new is added as it will be, and is not scaled.',
      '3. Replay the rows in date order under the plan\'s rules, as set out below.',
      '4. Add the year\'s premiums for my household.',
    ].join('\n')
  );
  p.push(replayRules());

  p.push('## What to show me');
  p.push(
    'For each plan: the premiums, what we would pay for care, and the total. Where the plan facts say something is not known, show the result each way, for every combination that changes it. ' +
      'Then the worst case for each plan: the premiums, plus the in-network out-of-pocket limit (the family limit when more than one person is covered), plus whatever in the table counts toward nothing, such as `not_covered` rows. ' +
      'Premiums come out of pay before tax and care does not, unless it is paid through an FSA or HSA. Say so where it would change the order of the plans, using the tax rate I gave you; I do not need a full tax calculation.'
  );
  p.push('Then tell me in plain words what the extra premium on the dearer plans buys, and how different next year would have to be for the cheapest plan to change. Lead with that trade. I will ask if I want your pick.');

  p.push('## If I paste the tool\'s results');
  p.push(
    'The tool I am using works out the same thing from the same table. If I paste its results, compare them with yours plan by plan, using its raw-dollar figures. Where the two differ by more than about ten dollars, tell me which plan, by how much, and what you think explains it: a rule read differently, the scaling, the premiums, or something I told you about next year. Do not assume either one is right.'
  );
  return p.join('\n\n') + '\n';
}

function smallPrompt(config) {
  const c = claimsWording(config);
  const ex = example(config, c, true);
  const p = [];
  p.push(
    'You are a careful data-entry assistant. Your task is to copy the service rows from medical Explanation of Benefits documents (EOBs) into a CSV table. ' +
      'Another tool does all the sums afterwards, so copy what each EOB says and do not estimate anything.'
  );
  p.push('I will give you a few EOBs at a time. Treat each message on its own.');

  p.push('# Reply format');
  p.push('Reply with the CSV first. Start with this header line every time:');
  p.push(fence(HEADER.join(',')));
  p.push('After the CSV, write "Guesses:" and list any rows where you were not sure of the category. If there are none, write "Guesses: none". Write nothing else.');

  p.push('# The columns');
  p.push(`Each EOB has a table called "${c.table}". Write one CSV row for each service row in it. Skip the "${c.totals}" row, and skip a row whose amounts are all zero.`);
  p.push(columnsGuide(c, true));
  if (c.quirks.length) p.push(c.quirks.map((q) => `- ${q}`).join('\n'));

  p.push('# Choosing the category');
  p.push('Use the first line that fits:');
  p.push(categoryGuide(config, c));

  p.push('# Example');
  p.push('EOBs:');
  p.push(fence(ex.eobText));
  p.push('Reply:');
  p.push(fence(ex.csv));
  p.push(ex.guesses);
  p.push('Why the example reads that way:');
  p.push(ex.why);

  p.push('# The EOBs to copy');
  p.push('The EOBs are below. Reply in the format above.');
  return p.join('\n\n') + '\n';
}

// frontier: the table, for a large hosted model.  small: the table, for a small local model.
// advice: a second opinion on the plans from a table that already exists.
const KINDS = ['frontier', 'small', 'advice'];

function agentPrompt(config, kind) {
  if (kind === 'small') return smallPrompt(config);
  if (kind === 'advice') return advicePrompt(config);
  if (kind === 'frontier' || kind == null) return tablePrompt(config);
  throw new Error(`no prompt of kind "${kind}"`);
}

module.exports = { agentPrompt, planFacts, ruleText, example, claimsWording, KINDS, HEADER };
