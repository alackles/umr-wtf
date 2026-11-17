#!/usr/bin/env node
'use strict';
// Writes a made-up household's year of EOBs, with the right answer beside them, so the agent
// prompts can be tried on any agent without handing it anyone's medical records.
//
//   node demo/make-eobs.js                          text EOBs + answer  -> dist/eobs/
//   node demo/make-eobs.js --pdf                    also PDFs (needs Chrome on the PATH)
//   node demo/make-eobs.js --config <plans.json> --out <folder>
//
// The household, the providers and every amount are invented. What each claim was charged
// comes from replaying the year under the first plan the configuration offers this year, so
// the EOBs, their running deductible and out-of-pocket figures, and the answer all agree.
//
// The year is built to contain the cases that are easy to get wrong: a lab that rides on an
// office visit, a lab at a checkup, an ER visit billed as two claims with several rows, a
// row that was not covered, an out-of-network visit, a claim that was reprocessed, and one
// person who reaches their out-of-pocket limit partway through.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateConfig } = require('../src/plans.js');
const { replay } = require('../src/engine.js');
const { claimsWording, eobTable, HEADER } = require('../src/prompt.js');

const PEOPLE = { jo: 'JO OKAFOR', mika: 'MIKA OKAFOR', tess: 'TESS OKAFOR' };
const first = (who) => PEOPLE[who].split(' ')[0].replace(/^(.)(.*)$/, (m, a, b) => a + b.toLowerCase());

// One claim: [month, day, who, provider, group, rows]. A row: [service, billed, allowed, category, extra]
function claims() {
  const list = [];
  const add = (m, d, who, provider, group, rows, extra) => list.push(Object.assign({ m, d, who, provider, group, rows: rows.map(([service, billed, allowed, category, more]) => Object.assign({ service, billed, allowed, category }, more)) }, extra));
  // Mika: therapy every three weeks, an infusion each month from March, an ER visit in May.
  for (const [m, d] of [[1, 8], [1, 29], [2, 19], [3, 12], [4, 2], [4, 23], [5, 14], [6, 4], [6, 25], [7, 16], [8, 6], [8, 27], [9, 17], [10, 8]]) {
    add(m, d, 'mika', 'HARBOR COUNSELING LLC', 'therapy', [['PHYSICIAN MEDICAL', 180, 112.4, 'office']]);
  }
  for (const m of [3, 4, 5, 6, 7, 8, 9, 10]) {
    add(m, 20, 'mika', 'LAKESHORE HOSPITAL', 'monthly infusion', [['DRUGS', 1480, 610.25, 'ded_coins'], ['MEDICAL SERVICE', 505, 204.75, 'ded_coins']]);
  }
  add(5, 3, 'mika', 'LAKESHORE HOSPITAL', 'ER visit in May', [['EMERGENCY CARE', 2890, 1210, 'er_facility'], ['DIAGNOSTIC X-RAY', 960, 402.5, 'er_facility'], ['DRUGS', 610, 287.5, 'er_facility']], { single: true });
  add(5, 3, 'mika', 'NORTH SHORE EMERGENCY PHYSICIANS', 'ER visit in May', [['EMERGENCY CARE', 780, 340, 'er_physician']]);
  // Jo: a checkup with labs, a sick visit with a lab (reprocessed), imaging, urgent care,
  // something not covered, and one out-of-network visit.
  add(2, 11, 'jo', 'NORTHSIDE FAMILY CLINIC', 'checkups and vaccines', [['MEDICAL EXAMINATION', 395, 236.8, 'preventive'], ['LABORATORY SERVICE', 142, 88.15, 'preventive', { guess: true }]]);
  add(4, 9, 'jo', 'NORTHSIDE FAMILY CLINIC', 'office visits', [['PHYSICIAN MEDICAL', 228, 131.3, 'office'], ['DIAGNOSTIC LAB', 77, 42.6, 'office', { count: 0, guess: true }]], { reprocessed: 1 });
  add(6, 17, 'jo', 'VALLEY IMAGING CENTER', 'knee imaging in June', [['DIAGNOSTIC X-RAY', 540, 268.4, 'ded_coins']]);
  add(7, 22, 'jo', 'NORTHSIDE FAMILY CLINIC', 'not covered', [['INJECTIONS / PROCEDURE', 310, 310, 'not_covered']]);
  add(8, 15, 'jo', 'QUICKCARE URGENT CARE', 'urgent care', [['MEDICAL SERVICE', 365, 187.9, 'urgent']]);
  add(9, 24, 'jo', 'RIVERBEND PHYSICAL THERAPY', 'out-of-network physical therapy', [['PHYSICAL THERAPY', 240, 156, 'office', { network: 'out' }]]);
  // Tess: a well-child visit with two vaccines, urgent care, two office visits.
  add(1, 15, 'tess', 'NORTHSIDE FAMILY CLINIC', 'checkups and vaccines', [['MEDICAL EXAMINATION', 330, 198.2, 'preventive'], ['IMMUNIZATION', 96, 64.1, 'preventive'], ['IMMUNIZATION', 108, 71.35, 'preventive']]);
  add(3, 6, 'tess', 'QUICKCARE URGENT CARE', 'urgent care', [['MEDICAL SERVICE', 298, 162.75, 'urgent']]);
  add(6, 10, 'tess', 'NORTHSIDE FAMILY CLINIC', 'office visits', [['PHYSICIAN MEDICAL', 205, 118.9, 'office']]);
  add(10, 1, 'tess', 'NORTHSIDE FAMILY CLINIC', 'office visits', [['PHYSICIAN MEDICAL', 205, 118.9, 'office']]);
  return list.sort((a, b) => a.m * 100 + a.d - (b.m * 100 + b.d));
}

const r2 = (n) => Math.round(n * 100) / 100;
const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p2 = (n) => String(n).padStart(2, '0');

function makeSet(config) {
  const plan = config.plans.find((p) => p.currentYearOption) || config.plans[0];
  const c = claimsWording(config);
  const col = c.columns;
  const year = config.planYear - 1;
  const all = claims();
  const iso = (cl) => `${year}-${p2(cl.m)}-${p2(cl.d)}`;
  const notice = (cl, plusDays) => {
    const dt = new Date(Date.UTC(year, cl.m - 1, cl.d + plusDays));
    return `${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}-${String(dt.getUTCFullYear()).slice(2)}`;
  };

  // Engine items: one per row, except an ER facility claim, which is one item for the claim
  // (the copay is charged once per visit).
  const items = [];
  all.forEach((cl, ci) => {
    cl.number = String(98000000101 + ci * 37);
    const base = { person: first(cl.who), date: iso(cl), group: cl.group };
    if (cl.single) {
      cl.itemIndex = [items.length];
      items.push(Object.assign({}, base, { category: cl.rows[0].category, allowed: r2(cl.rows.reduce((s, r) => s + r.allowed, 0)) }));
    } else {
      cl.itemIndex = cl.rows.map((r) => {
        const it = Object.assign({}, base, { category: r.category, allowed: r.allowed });
        if (r.network === 'out') Object.assign(it, { network: 'out', billed: r.billed });
        if (r.count === 0) it.count = 0;
        if (r.guess) it.guess = true;
        items.push(it);
        return items.length - 1;
      });
    }
  });

  const whole = replay(items, plan, { family: true });
  const lineOf = (i) => whole.lines.find((l) => l.index === i);
  const eobs = [];
  const owed = {};
  const notCovered = {};
  const eobCount = {};

  all.forEach((cl) => {
    // What each printed row was charged.
    let rows;
    if (cl.single) {
      const l = lineOf(cl.itemIndex[0]);
      let copayLeft = r2(l.copay);
      let dedLeft = r2(l.ded);
      const coinsTotal = r2(l.coins);
      const base = cl.rows.reduce((s, r) => s + r.allowed, 0) - copayLeft - dedLeft;
      let coinsLeft = coinsTotal;
      rows = cl.rows.map((r, i) => {
        const copay = Math.min(copayLeft, r.allowed);
        copayLeft = r2(copayLeft - copay);
        const ded = Math.min(dedLeft, r2(r.allowed - copay));
        dedLeft = r2(dedLeft - ded);
        const coins = i === cl.rows.length - 1 ? coinsLeft : r2((coinsTotal * (r.allowed - copay - ded)) / (base || 1));
        coinsLeft = r2(coinsLeft - coins);
        return Object.assign({}, r, { copay, ded, coins, nc: 0, notAllowed: 0 });
      });
    } else {
      rows = cl.rows.map((r, i) => {
        const l = lineOf(cl.itemIndex[i]);
        if (r.category === 'not_covered') return Object.assign({}, r, { copay: 0, ded: 0, coins: 0, nc: r.allowed, notAllowed: 0 });
        return Object.assign({}, r, { copay: r2(l.copay), ded: r2(l.ded), coins: r2(l.coins), nc: 0, notAllowed: r.network === 'out' ? r2(r.billed - r.allowed) : 0 });
      });
    }
    for (const r of rows) {
      const covered = r.category !== 'not_covered';
      r.planPaid = covered ? r2(r.allowed - r.copay - r.ded - r.coins) : 0;
      r.discount = covered ? r2(r.billed - r.allowed - r.notAllowed) : 0;
      r.owe = r2(r.copay + r.ded + r.coins + r.nc);
      const share = covered && r.planPaid > 0 ? Math.round((r.planPaid / (r.allowed - r.copay - r.ded)) * 100) : null;
      r.pct = share == null ? '' : String(share);
    }

    // The running figures as of this claim: replay everything up to and including it.
    const upTo = Math.max(...cl.itemIndex);
    const acc = replay(items.slice(0, upTo + 1), plan, { family: true }).acc;
    const me = first(cl.who);
    const bar = (label, used, limit) => `${label.padEnd(34)}${usd(r2(used))} out of ${usd(limit)}`;
    const side = (name, key) => [
      name,
      bar('INDIVIDUAL CAL YR DEDUCTIBLE', acc[key].ded[me] || 0, plan[key].ded[0]),
      bar('FAMILY CAL YR DEDUCTIBLE', acc[key].fded, plan[key].ded[1]),
      bar('INDIVIDUAL OUT-OF-POCKET', acc[key].oop[me] || 0, plan[key].oop[0]),
      bar('FAMILY OUT-OF-POCKET', acc[key].foop, plan[key].oop[1]),
    ];

    const versions = cl.reprocessed ? [true, false] : [false];
    for (const early of versions) {
      // The first version of a reprocessed claim wrongly refused its last row.
      const shown = rows.map((r, i) => (early && i === rows.length - 1 ? Object.assign({}, r, { planPaid: 0, discount: 0, nc: r.billed, owe: r.billed, pct: '', denied: true }) : r));
      const out = isOut(shown);
      const total = (k) => r2(shown.reduce((s, r) => s + r[k], 0));
      const text = [];
      text.push('Explanation of benefits (EOB)', '');
      text.push('This is not a bill. This is an overview of a claim we have processed for you.', '');
      text.push(`   ${(col.billed + ':').padEnd(30)}${usd(total('billed'))}`);
      text.push(`   ${(col.discount + ':').padEnd(30)}${usd(total('discount'))}`);
      text.push(`   ${(col.planPaid + ':').padEnd(30)}${usd(total('planPaid'))}`);
      text.push(`   ${(col.owe.toUpperCase() + ':').padEnd(30)}${usd(total('owe'))}`, '');
      text.push(`Your benefits summary for plan year starting: January ${year}`, '');
      text.push(...side('In-network', 'in'), '', ...side('Out-of-network', 'out'), '');
      text.push(`Employee: ${PEOPLE.jo}        Employer Name: ${config.employer}        Notice Date: ${notice(cl, early ? 9 : cl.reprocessed ? 34 : 9)}`, '');
      text.push(`${'Patient:'.padEnd(28)}${'Claim Number:'.padEnd(20)}Provider Name:`);
      text.push(`${PEOPLE[cl.who].padEnd(28)}${cl.number.padEnd(20)}${cl.provider}`, '');
      const stamp = `${p2(cl.m)}/${p2(cl.d)}/${String(year).slice(2)}`;
      text.push(eobTable(c, shown.map((r) => Object.assign({}, r, { date: stamp, code: r.denied || r.category === 'not_covered' ? 'B7' : out ? 'A2' : 'A1' }))), '');
      text.push('Reason code explanations:');
      if (shown.some((r) => !r.denied && r.category !== 'not_covered')) {
        text.push(out ? ' A2   Your claim was processed at the out-of-network level of benefits. The provider may bill you for the amount not allowed.' : ' A1   Provider negotiated discount. You are not responsible for this amount.', out ? '' : '      Your claim was processed at the in-network level of benefits.');
      }
      if (shown.some((r) => r.denied || r.category === 'not_covered')) text.push(' B7   This service is not covered by your plan.');
      if (!early && cl.reprocessed) text.push('', 'This claim has been reprocessed. This notice replaces the earlier one for the same claim.');
      const name = `${iso(cl)}_${PEOPLE[cl.who].replace(/ /g, '-')}_${cl.provider.replace(/[^A-Za-z]+/g, '-').replace(/-$/, '')}_claim${cl.number}${cl.reprocessed ? (early ? '_a' : '_b') : ''}`;
      eobs.push({ name, text: text.filter((l) => l != null).join('\n') + '\n' });
    }
    eobCount[me] = (eobCount[me] || 0) + versions.length;
    owed[me] = r2((owed[me] || 0) + rows.reduce((s, r) => s + r.copay + r.ded + r.coins, 0));
    notCovered[me] = r2((notCovered[me] || 0) + rows.reduce((s, r) => s + r.nc, 0));
  });

  const csv = [HEADER.join(',')];
  for (const it of items) csv.push([it.person, it.date, it.category, it.allowed.toFixed(2), it.network === 'out' ? 'out' : 'in', it.count === 0 ? '0' : '', it.billed != null ? it.billed.toFixed(2) : '', it.group].join(','));
  return {
    plan,
    eobs,
    items,
    answerCsv: csv.join('\n') + '\n',
    summary: { plan: plan.name, year, eobs: eobCount, owed, notCovered, guesses: items.filter((it) => it.guess).map((it) => `${it.person} ${it.date} ${it.allowed.toFixed(2)} is ${it.category}${it.count === 0 ? ' with count 0' : ''}`) },
  };
}

function isOut(rows) {
  return rows.some((r) => r.network === 'out');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const root = path.join(__dirname, '..');
  const config = validateConfig(JSON.parse(fs.readFileSync(path.resolve(arg('--config', path.join(root, 'demo', 'plans.demo.json'))), 'utf8')));
  const out = path.resolve(arg('--out', path.join(root, 'dist', 'eobs')));
  const set = makeSet(config);
  fs.mkdirSync(path.join(out, 'txt'), { recursive: true });
  for (const e of set.eobs) fs.writeFileSync(path.join(out, 'txt', e.name + '.txt'), e.text);
  fs.writeFileSync(path.join(out, 'answer.csv'), set.answerCsv);
  fs.writeFileSync(path.join(out, 'answer.json'), JSON.stringify(set.summary, null, 2) + '\n');
  if (args.includes('--pdf')) {
    fs.mkdirSync(path.join(out, 'pdf'), { recursive: true });
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    for (const e of set.eobs) {
      const html = path.join(out, 'pdf', e.name + '.html');
      fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>@page { size: 17in 11in; margin: 0.5in; } pre { font: 9pt monospace; }</style><pre>${esc(e.text)}</pre>`);
      execFileSync('google-chrome', ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${path.join(out, 'pdf', e.name + '.pdf')}`, 'file://' + html], { stdio: 'ignore' });
      fs.unlinkSync(html);
    }
  }
  console.log(`${set.eobs.length} EOBs for a household on ${set.plan.name} -> ${path.relative(process.cwd(), out)}`);
  console.log(JSON.stringify(set.summary, null, 2));
}

module.exports = { makeSet };
