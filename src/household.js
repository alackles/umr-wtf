'use strict';
// Path A: questionnaire answers -> the coming year as line items.
//
// The output is the same thing Path B imports: a list of line items with group labels, plus
// the household facts the money views need. The engine never learns which path made them.

const { ruleFor, tierFor, getPlan, RX_TIERS } = require('./plans.js');
const { backOut, monthsElapsed, TOL } = require('./estimator.js');

// Usage presets, as visits in a full year. `other` is a rough yearly figure for labs,
// imaging and the like, used only for people with no accumulators to read.
const PRESETS = {
  checkups: { label: 'Mostly yearly checkups', counts: { office: 0, therapy: 0, urgent: 0, er: 0 }, other: 0 },
  few: { label: 'A few visits', counts: { office: 4, therapy: 0, urgent: 1, er: 0 }, other: 400 },
  regular: { label: 'Regular appointments', counts: { office: 10, therapy: 12, urgent: 1, er: 0 }, other: 1600 },
};

// Rough cash prices per fill, used when none is given. Listed under the chart when in play.
const RX_DEFAULT_PRICE = { rx_generic: 15, rx_preferred: 300, rx_nonpreferred: 450, rx_specialty: 2500 };
const RX_LABEL = { rx_generic: 'generic', rx_preferred: 'preferred brand', rx_nonpreferred: 'non-preferred brand', rx_specialty: 'specialty' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

function newPerson(id, role, name) {
  return {
    id,
    role, // 'self' | 'spouse' | 'child'
    name: name || (role === 'self' ? 'You' : role === 'spouse' ? 'Spouse or partner' : 'Child'),
    thisYear: true,
    nextYear: true,
    dedMet: null,
    oopMet: null,
    usage: null, // 'checkups' | 'few' | 'regular' | 'counts'
    counts: { office: null, therapy: null, urgent: null, er: null },
    other: null,
    capMonth: null,
    rx: {}, // { rx_generic: { fills, price }, ... }  fills per month
    oon: { visits: null, charge: null }, // visits per year, charge per visit
    treatment: { on: false, startMonth: 1, months: 12, allowedPerMonth: null }, // new next year
    dme: null, // medical equipment next year, total charges
    trust: null, // 'dollars' | 'counts' when the inputs disagree
  };
}

function defaultAnswers(config, todayIso) {
  return {
    asOf: todayIso,
    currentPlan: undefined, // undefined: not answered yet. null: no plan this year.
    people: [newPerson('p1', 'self')],
    familyMet: { ded: null, oop: null },
    gates: { rx: null, oon: null, hsa: null, cap: null },
    hsa: { selfMedicare: false, spouseFsa: false },
    events: {
      birth: { on: false, person: null, month: 6, allowed: null },
      surgery: { on: false, person: null, month: 6, allowed: null },
      turning65: { on: false, person: null, month: 6 },
      leaving: { on: false, month: 6 },
    },
    priority: null, // 'normal' | 'protect' | 'paycheck'
    canAbsorb: null,
    adv: {
      taxRate: 30, // percent
      fsa: null,
      hsa: null,
      creditSelf: true,
      creditSpouse: true,
      surcharge: false,
      typical: {}, // overrides of config.typicalAllowed
    },
    view: 'takehome',
  };
}

function typicalAllowed(config, answers) {
  const t = Object.assign({}, config.typicalAllowed);
  for (const [k, v] of Object.entries((answers.adv && answers.adv.typical) || {})) if (num(v) != null) t[k] = num(v);
  return t;
}

function describeCounts(c) {
  const bits = [];
  if (c.office) bits.push(plural(c.office, 'office visit'));
  if (c.therapy) bits.push(plural(c.therapy, 'therapy session'));
  if (c.urgent) bits.push(plural(c.urgent, 'urgent care trip'));
  if (c.er) bits.push(plural(c.er, 'ER visit'));
  return bits.length ? bits.join(', ') : 'no visits beyond checkups';
}

// Spread a yearly quantity over the months it applies to, as one item per month.
function monthly(base, yearlyCount, allowedEach, months) {
  const out = [];
  if (!(yearlyCount > 0) || !months.length) return out;
  const per = yearlyCount / months.length;
  for (const m of months) out.push(Object.assign({}, base, { month: m, count: per, allowed: allowedEach * per }));
  return out;
}

function build(config, answers) {
  const problems = [];
  const notes = [];
  const assumptions = [];
  const working = [];
  const items = [];
  const typical = typicalAllowed(config, answers);
  const planned = []; // things the person told us are coming next year, for the "assuming" line

  const people = answers.people || [];
  const current = answers.currentPlan ? getPlan(config, answers.currentPlan) : null;
  const thisYear = current ? people.filter((p) => p.thisYear) : [];
  const nextYear = people.filter((p) => p.nextYear);
  const familyThisYear = thisYear.length > 1;

  const tier = tierFor(config, {
    spouse: nextYear.filter((p) => p.role === 'spouse').length,
    children: nextYear.filter((p) => p.role === 'child').length,
  });
  const family = nextYear.length > 1;

  if (answers.currentPlan === undefined) {
    problems.push({ code: 'current-missing', blocking: true, anchor: 'q-current', text: 'Pick the plan you are on this year, or "None".' });
  }

  const M = monthsElapsed(answers.asOf);
  if (current && thisYear.length && M == null) {
    problems.push({ code: 'as-of', blocking: true, anchor: 'q-asof', text: 'The as-of date for the deductible and out-of-pocket numbers is missing or unreadable.' });
  }
  const elapsed = Math.min(12, Math.max(0.5, M || 12));
  if (current && thisYear.length && M != null && M < 3) {
    notes.push({ code: 'early-year', text: 'The numbers are from early in the year, so scaling them to twelve months is rough.' });
  }

  // ---- family accumulators -------------------------------------------------------------
  let familyDedMet = false;
  let familyCapMet = false;
  if (current && familyThisYear) {
    const sumDed = thisYear.reduce((s, p) => s + (num(p.dedMet) || 0), 0);
    const sumOop = thisYear.reduce((s, p) => s + (num(p.oopMet) || 0), 0);
    const famDed = num(answers.familyMet && answers.familyMet.ded);
    const famOop = num(answers.familyMet && answers.familyMet.oop);
    familyDedMet = Math.max(sumDed, famDed || 0) >= current.in.ded[1] - TOL;
    familyCapMet = Math.max(sumOop, famOop || 0) >= current.in.oop[1] - TOL;
    if (famDed != null && Math.abs(famDed - sumDed) > 50) {
      notes.push({ code: 'family-ded-mismatch', anchor: 'q-family-met', text: `The family deductible figure (${money(famDed)}) and the people listed (${money(sumDed)} together) differ. EOBs from different dates can do that; so can a missing person.` });
    }
    if (famOop != null && Math.abs(famOop - sumOop) > 50) {
      notes.push({ code: 'family-oop-mismatch', anchor: 'q-family-met', text: `The family out-of-pocket figure (${money(famOop)}) and the people listed (${money(sumOop)} together) differ. EOBs from different dates can do that; so can a missing person.` });
    }
  }

  const rxOn = answers.gates && answers.gates.rx === true;
  const oonOn = answers.gates && answers.gates.oon === true;
  const capOn = answers.gates && answers.gates.cap === true;
  const lowerBound = []; // people whose charges are only a lower bound
  const defaultPricesUsed = new Set();
  const presetsUsed = [];
  let anyRx = false;
  let anyOon = false;

  const leaving = answers.events && answers.events.leaving && answers.events.leaving.on;
  const lastMonth = leaving ? Math.min(12, Math.max(1, num(answers.events.leaving.month) || 12)) : 12;
  const allMonths = [];
  for (let m = 1; m <= lastMonth; m++) allMonths.push(m);

  for (const person of people) {
    const onPlan = !!current && person.thisYear;
    const preset = PRESETS[person.usage] || null;
    const counted = person.usage === 'counts';
    if (!preset && !counted) {
      if (person.nextYear || onPlan) {
        problems.push({ code: 'usage-missing', blocking: true, person: person.id, anchor: `q-usage-${person.id}`, text: person.role === 'self' && person.name === 'You' ? 'Pick how much care you use.' : `Pick how much care ${person.name} uses.` });
      }
      continue;
    }
    const c = person.counts || {};
    const rawCounts = { office: num(c.office) || 0, therapy: num(c.therapy) || 0, urgent: num(c.urgent) || 0, er: num(c.er) || 0 };

    // Prescriptions: fills per month by tier.
    const rx = [];
    if (rxOn) {
      for (const tierId of RX_TIERS) {
        const r = person.rx && person.rx[tierId];
        const fills = r ? num(r.fills) || 0 : 0;
        if (!(fills > 0)) continue;
        let price = num(r.price);
        if (price == null) {
          price = RX_DEFAULT_PRICE[tierId];
          defaultPricesUsed.add(tierId);
        }
        rx.push({ tier: tierId, fills, price });
      }
    }

    let annual; // visits in a full year
    let erVisits; // carried over as they happened, not scaled
    let recurring = 0; // yearly charges through deductible and coinsurance

    if (onPlan) {
      const dedMet = num(person.dedMet);
      const oopMet = num(person.oopMet);
      if (dedMet == null || oopMet == null) {
        problems.push({ code: 'met-missing', blocking: true, person: person.id, anchor: `q-met-${person.id}`, text: `Fill in deductible met and out-of-pocket met for ${person.role === 'self' && person.name === 'You' ? 'yourself' : person.name} (zero is a fine answer).` });
        continue;
      }
      // Year-to-date counts: typed directly, or the preset's yearly rate so far.
      const ytd = counted
        ? rawCounts
        : { office: (preset.counts.office * elapsed) / 12, therapy: (preset.counts.therapy * elapsed) / 12, urgent: (preset.counts.urgent * elapsed) / 12, er: 0 };
      if (preset) presetsUsed.push({ person, preset });

      const usage = [
        { category: 'office', count: ytd.office, allowedEach: typical.office },
        { category: 'office', count: ytd.therapy, allowedEach: typical.therapy },
        { category: 'urgent', count: ytd.urgent, allowedEach: typical.urgent },
        { category: 'er_facility', count: ytd.er, allowedEach: typical.er_facility },
        { category: 'er_physician', count: ytd.er, allowedEach: typical.er_physician },
      ];
      for (const r of rx) usage.push({ category: r.tier, count: r.fills * elapsed, allowedEach: r.price });

      const atOwnCap = oopMet >= current.in.oop[0] - TOL;
      const censored = atOwnCap || (familyThisYear && familyCapMet);
      const capMonth = capOn ? num(person.capMonth) : null;
      const paidShare = censored ? (capMonth ? Math.min(1, capMonth / elapsed) : null) : 1;

      const est = backOut({
        plan: current,
        family: familyThisYear,
        dedMet,
        oopMet,
        usage,
        familyDedMet,
        censored,
        paidShare,
        // A preset is a rough answer by nature, so the dollars win without asking. Typed
        // counts are a claim: if they disagree with the dollars by more than a visit or
        // two, the person is asked which to trust.
        trust: person.trust || (counted ? null : 'dollars'),
        slack: counted ? 40 : 0,
      });
      for (const p of est.problems) problems.push(Object.assign({ person: person.id, anchor: `q-met-${person.id}` }, p, { text: `${person.name}: ${p.text}` }));
      for (const n of est.notes) notes.push(Object.assign({ person: person.id }, n, { text: `${person.name}: ${n.text}` }));
      if (est.problems.some((p) => p.blocking)) continue;

      // Scaling to a full year, as if care so far was spread evenly.
      const endCharges = censored && capMonth ? Math.min(elapsed, capMonth) : elapsed;
      const fVisits = 12 / Math.max(0.5, elapsed);
      const fCharges = 12 / Math.max(0.5, endCharges);

      let extraVisits = 0;
      if (est.extraCopays > 0) {
        const office = ruleFor(current, 'office', 'in');
        if (office.copay > 0) extraVisits = est.extraCopays / office.copay;
      }
      annual = {
        office: (ytd.office * est.usageScale + extraVisits) * fVisits,
        therapy: ytd.therapy * est.usageScale * fVisits,
        urgent: ytd.urgent * est.usageScale * fVisits,
      };
      erVisits = ytd.er * est.usageScale;

      recurring = Math.max(0, est.residual) * fCharges;
      if (censored && !capMonth) lowerBound.push(person.id);

      working.push({
        person: person.id,
        name: person.name,
        dedMet,
        oopMet,
        copays: est.copays,
        knownCoins: est.knownCoins || 0,
        coinsurance: est.coinsurance,
        share: current.in.coins,
        charges: est.charges,
        residual: est.residual,
        factor: fCharges,
        recurring,
        censored,
        capMonth,
      });
    } else {
      // No accumulators to read: presets or yearly counts alone.
      const yearly = counted ? rawCounts : preset.counts;
      if (preset) presetsUsed.push({ person, preset });
      annual = { office: yearly.office, therapy: yearly.therapy, urgent: yearly.urgent };
      erVisits = yearly.er;
      const other = num(person.other);
      recurring = other != null ? other : preset ? preset.other : 0;
    }

    if (!person.nextYear) continue;

    // ---- line items for the coming year ------------------------------------------------
    const who = { person: person.id, network: 'in' };
    const label = (what) => `${person.name}: ${what}`;
    items.push(...monthly(Object.assign({ category: 'office', group: label('office visits') }, who), annual.office, typical.office, allMonths));
    items.push(...monthly(Object.assign({ category: 'office', group: label('therapy sessions') }, who), annual.therapy, typical.therapy, allMonths));
    items.push(...monthly(Object.assign({ category: 'urgent', group: label('urgent care') }, who), annual.urgent, typical.urgent, allMonths));
    if (erVisits > 0) {
      const m = Math.min(lastMonth, 6);
      const base = Object.assign({ group: label(erVisits === 1 ? 'ER visit' : 'ER visits'), month: m }, who);
      items.push(Object.assign({}, base, { category: 'er_facility', count: erVisits, allowed: typical.er_facility * erVisits }));
      items.push(Object.assign({}, base, { category: 'er_physician', count: erVisits, allowed: typical.er_physician * erVisits }));
    }
    if (recurring > 0) {
      const base = Object.assign({ category: 'ded_coins', group: label('labs, imaging, hospital and other care') }, who);
      for (const m of allMonths) items.push(Object.assign({}, base, { month: m, allowed: recurring / 12 }));
    }
    const tx = person.treatment;
    if (tx && tx.on) {
      const per = num(tx.allowedPerMonth) != null ? num(tx.allowedPerMonth) : config.events.recurring.allowedPerMonth;
      const start = Math.max(1, num(tx.startMonth) || 1);
      const count = Math.max(1, num(tx.months) || 12);
      for (let m = start; m < start + count && m <= lastMonth; m++) {
        items.push(Object.assign({ category: 'ded_coins', group: label(config.events.recurring.label), month: m, allowed: per, planned: true }, who));
      }
      planned.push({ key: 'recurring', person: person.id, allowed: per, usedDefault: num(tx.allowedPerMonth) == null, anchor: `tx-${person.id}` });
    }
    if (num(person.dme) > 0) {
      items.push(Object.assign({ category: 'ded_coins', group: label(config.events.dme.label), month: 1, allowed: num(person.dme), planned: true }, who));
    }
    for (const r of rx) {
      anyRx = true;
      items.push(...monthly(Object.assign({ category: r.tier, group: label(`${RX_LABEL[r.tier]} prescriptions`) }, who), r.fills * 12, r.price, allMonths).map((it) => it));
    }
    if (oonOn) {
      const visits = num(person.oon && person.oon.visits) || 0;
      const charge = num(person.oon && person.oon.charge) || 0;
      if (visits > 0 && charge > 0) {
        anyOon = true;
        const share = config.oonAllowedShare || 1;
        const per = visits / 12;
        for (const m of allMonths) {
          items.push({ person: person.id, network: 'out', category: 'office', group: label('out-of-network visits'), month: m, count: per, billed: charge * per, allowed: charge * per * share });
        }
      }
    }
  }

  // ---- planned events -------------------------------------------------------------------
  const ev = answers.events || {};
  const nextIds = new Set(nextYear.map((p) => p.id));
  const nameOf = (id) => (people.find((p) => p.id === id) || {}).name;
  const pick = (id) => (nextIds.has(id) ? id : nextYear.length ? nextYear[0].id : null);
  const one = (key, monthDefault) => {
    const e = ev[key];
    if (!e || !e.on) return;
    const who = pick(e.person);
    if (!who) return;
    const allowed = num(e.allowed) != null ? num(e.allowed) : config.events[key].allowed;
    const month = Math.min(lastMonth, Math.max(1, num(e.month) || monthDefault));
    items.push({ person: who, network: 'in', category: 'ded_coins', month, allowed, group: `${nameOf(who)}: ${config.events[key].label}`, planned: true });
    planned.push({ key, person: who, allowed, usedDefault: num(e.allowed) == null });
  };
  one('birth', 6);
  one('surgery', 6);

  // ---- money facts ---------------------------------------------------------------------
  const facts = moneyFacts(config, answers, nextYear, family, lastMonth, notes);
  const { spouseCovered, credit, surcharge, hsaAsked } = facts;

  // ---- the "assuming..." line ----------------------------------------------------------
  const A = (id, text, anchor) => assumptions.push({ id, text, anchor });
  for (const { person, preset } of presetsUsed) {
    const perYear = Object.assign({}, preset.counts);
    let text = `${person.name === 'You' ? 'you have' : person.name + ' has'} about ${describeCounts(perYear)} a year`;
    if (!(current && person.thisYear) && preset.other) text += ` and ${money(preset.other)} of labs or imaging`;
    A(`preset-${person.id}`, text, `q-usage-${person.id}`);
  }
  if (!oonOn) A('oon', 'no out-of-network care', 'g-oon');
  else if (anyOon) A('oon-share', `the plan recognises ${Math.round(config.oonAllowedShare * 100)}% of an out-of-network charge (a guess)`, null);
  if (!rxOn) A('rx', 'no regular prescriptions', 'g-rx');
  else if (defaultPricesUsed.size) {
    A('rx-price', `cash prices of ${[...defaultPricesUsed].map((t) => `${money(RX_DEFAULT_PRICE[t])} per ${RX_LABEL[t]} fill`).join(', ')}`, 'g-rx');
  }
  if (current && thisYear.length) A('shape', 'this year\'s care so far was spread evenly across the months', null);
  const inPlay = new Set(items.map((it) => it.group && it.group.split(': ')[1]));
  const typ = [];
  if (inPlay.has('office visits')) typ.push(`${money(typical.office)} for an office visit`);
  if (inPlay.has('therapy sessions')) typ.push(`${money(typical.therapy)} for a therapy session`);
  if (inPlay.has('urgent care')) typ.push(`${money(typical.urgent)} for urgent care`);
  if (inPlay.has('ER visit') || inPlay.has('ER visits')) typ.push(`${money(typical.er_facility + typical.er_physician)} for an ER visit`);
  if (typ.length) A('typical', `full prices of ${typ.join(', ')}`, 'adv-typical');
  for (const p of planned) {
    if (!p.usedDefault) continue;
    const label = config.events[p.key].label;
    A(`event-${p.key}-${p.person}`, p.key === 'recurring' ? `${label} at ${money(p.allowed)} a month` : `${label} at ${money(p.allowed)}`, p.anchor || `ev-${p.key}`);
  }

  finishAssumptions(config, facts, A);

  return Object.assign(facts.public, {
    tierId: tier.id,
    tierLabel: tier.label,
    family,
    items: items.filter((it) => !(answers.groupsOff || []).includes(it.group)),
    allItems: items,
    people: nextYear.map((p) => ({ id: p.id, name: p.name })),
    lowerBound: lowerBound.filter((id) => nextIds.has(id)),
    anyRx,
    anyOon,
    problems,
    notes,
    assumptions,
    working,
  });
}

// Tax, premium modifiers and account eligibility: shared by both paths.
function moneyFacts(config, answers, nextYear, family, lastMonth, notes) {
  const adv = answers.adv || {};
  const ev = answers.events || {};
  const people = answers.people || [];
  const leaving = ev.leaving && ev.leaving.on;
  const spouseCovered = nextYear.some((p) => p.role === 'spouse');
  const credit = adv.creditSelf ? (spouseCovered && adv.creditSpouse ? 2 : 1) : 0;
  const surcharge = spouseCovered && !!adv.surcharge;
  const taxRate = Math.min(60, Math.max(0, num(adv.taxRate) != null ? num(adv.taxRate) : 30)) / 100;

  const hsaAsked = answers.gates && answers.gates.hsa === true;
  const hsaEligible = !(hsaAsked && answers.hsa && (answers.hsa.selfMedicare || answers.hsa.spouseFsa));
  let hsaFactor = 1;
  if (ev.turning65 && ev.turning65.on) {
    const who = people.find((p) => p.id === ev.turning65.person) || people[0];
    const month = Math.min(12, Math.max(1, num(ev.turning65.month) || 6));
    if (who && who.role === 'self') {
      hsaFactor = (month - 1) / 12;
      notes.push({ code: 'turning-65', text: `HSA contributions have to stop once Medicare starts. If you enrol in Medicare when you turn 65 in ${MONTHS[month - 1]}, the HSA limit is pro-rated to ${month - 1} of 12 months. You can stay on the employer plan either way.` });
    } else if (who) {
      notes.push({ code: 'turning-65', text: `${who.name} can move to Medicare at 65. If they leave this plan mid-year the premium tier changes; that is not modelled here.` });
    }
  }
  const hsaLimit = config.hsa ? (family ? config.hsa.family : config.hsa.single) * hsaFactor : 0;
  if (leaving) {
    notes.push({ code: 'leaving', text: `Leaving after ${MONTHS[lastMonth - 1]}: premiums and care are counted for ${plural(lastMonth, 'month')}. Deductibles and caps do not shrink for a part year.` });
  }
  return {
    spouseCovered,
    credit,
    surcharge,
    hsaAsked,
    public: { credit, surcharge, monthsCovered: lastMonth, taxRate, fsa: num(adv.fsa) || 0, hsa: num(adv.hsa) || 0, hsaEligible, hsaLimit },
  };
}

function finishAssumptions(config, facts, A) {
  if (config.plans.some((p) => p.account === 'hsa') && !facts.hsaAsked) A('hsa-eligible', 'you are allowed to use an HSA', 'g-hsa');
  if (config.credits) A('credit', config.credits.labels[facts.credit], 'adv-premium');
  if (facts.spouseCovered && config.spousalSurcharge && !facts.surcharge) A('surcharge', 'no spousal surcharge', 'adv-premium');
  const f = facts.public;
  const hasFsa = config.plans.some((p) => p.account === 'fsa');
  const hasHsa = config.plans.some((p) => p.account === 'hsa');
  if (!(f.fsa > 0) && !(f.hsa > 0) && (hasFsa || hasHsa)) A('accounts', `no ${[hasFsa && 'FSA', hasHsa && 'HSA'].filter(Boolean).join(' or ')} contributions`, 'q-accounts');
  A('tax', `a ${Math.round(f.taxRate * 100)}% combined tax rate`, 'adv-tax');
  if (config.seriousEvent) A('bad-year', `a catastrophic year means ${config.seriousEvent.label}`, null);
}

// Path B: an imported (or hand-edited) table of line items. The people list supplies roles
// for the premium tier; the table supplies the care.
//   table: { items: [...], groupsOff: [labels] }
function buildFromTable(config, answers, table) {
  const problems = [];
  const notes = [];
  const assumptions = [];
  const A = (id, text, anchor) => assumptions.push({ id, text, anchor });
  const people = answers.people || [];
  const nextYear = people.filter((p) => p.nextYear);
  const tier = tierFor(config, {
    spouse: nextYear.filter((p) => p.role === 'spouse').length,
    children: nextYear.filter((p) => p.role === 'child').length,
  });
  const family = nextYear.length > 1;
  const ev = answers.events || {};
  const leaving = ev.leaving && ev.leaving.on;
  const lastMonth = leaving ? Math.min(12, Math.max(1, num(ev.leaving.month) || 12)) : 12;

  const off = new Set((table && table.groupsOff) || []);
  const UNGROUPED = '(no group)';
  const all = ((table && table.items) || []).map((it) => Object.assign({}, it, { group: it.group || UNGROUPED }));
  if (!all.length) problems.push({ code: 'table-empty', blocking: true, anchor: 'import-box', text: 'Paste or load a table of line items to begin.' });
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p]));
  const unknown = new Set();
  for (const it of all) if (!byName.has(String(it.person).trim().toLowerCase())) unknown.add(it.person);
  if (unknown.size) {
    problems.push({ code: 'table-people', blocking: true, anchor: 'q-people', text: `The table has care for ${[...unknown].join(', ')}, who ${unknown.size === 1 ? 'is' : 'are'} not in the list of people. Names have to match.` });
  }
  const items = all
    .filter((it) => !off.has(it.group) && (it.month || 1) <= lastMonth)
    .filter((it) => {
      const p = byName.get(String(it.person).trim().toLowerCase());
      return !p || p.nextYear;
    })
    .map((it) => {
      const p = byName.get(String(it.person).trim().toLowerCase());
      return Object.assign({}, it, { person: p ? p.id : it.person });
    });

  const facts = moneyFacts(config, answers, nextYear, family, lastMonth, notes);
  A('table', 'the table is the whole coming year, as given', 'import-box');
  finishAssumptions(config, facts, A);

  return Object.assign(facts.public, {
    tierId: tier.id,
    tierLabel: tier.label,
    family,
    items,
    allItems: all,
    people: nextYear.map((p) => ({ id: p.id, name: p.name })),
    lowerBound: [],
    anyRx: items.some((it) => /^rx_/.test(it.category)),
    anyOon: items.some((it) => it.network === 'out'),
    problems,
    notes,
    assumptions,
    working: [],
  });
}

module.exports = { build, buildFromTable, defaultAnswers, newPerson, PRESETS, RX_DEFAULT_PRICE, RX_LABEL, MONTHS, describeCounts, typicalAllowed };
