'use strict';
// Path A: questionnaire answers -> the coming year as line items.
//
// The output is the same thing Path B imports: a list of line items with group labels, plus
// the household facts the money views need. The engine never learns which path made them.

const { ruleFor, tierFor, getPlan, RX_TIERS } = require('./plans.js');
const { backOut, splitUsage, monthsElapsed, TOL } = require('./estimator.js');

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
    oon: { visits: null, charge: null, allowed: null }, // visits per year; billed and allowed per visit
    regular: [], // regular care that isn't an office visit: [{ id, name, times (a year), cost (billed each time), since: 'year' | 2..12 | 'next' }]
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
    gates: { rx: null, regular: null, oon: null, hsa: null },
    hsa: { selfMedicare: false, spouseFsa: false },
    events: {
      birth: { on: false, person: null, month: 6, allowed: null },
      surgery: { on: false, person: null, month: 6, allowed: null },
      turning65: { on: false, person: null, month: 6 },
      leaving: { on: false, month: 6 },
    },
    priority: null, // 'normal' | 'protect' | 'paycheck'
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
  const regularOn = answers.gates && answers.gates.regular === true;
  const lowerBound = []; // people whose charges are only a lower bound
  const defaultPricesUsed = new Set();
  const presetsUsed = [];
  let anyRx = false;
  let anyOon = false;
  let oonGuessed = false;

  const leaving = answers.events && answers.events.leaving && answers.events.leaving.on;
  const lastMonth = leaving ? Math.min(12, Math.max(1, num(answers.events.leaving.month) || 12)) : 12;
  const allMonths = [];
  for (let m = 1; m <= lastMonth; m++) allMonths.push(m);

  for (const person of people) {
    const onPlan = !!current && person.thisYear;
    // Regular care that isn't an office visit (infusions, scans, dialysis, lab work billed on its
    // own): through the deductible and coinsurance. Visits, specialists' included, are counted
    // under "how much care". No default price: these range too widely for one to mean anything.
    const regular = [];
    for (const r of regularOn ? person.regular || [] : []) {
      const times = num(r.times) || 0;
      const cost = num(r.cost);
      if (!(times > 0)) continue;
      const name = String(r.name || '').trim();
      if (cost == null) {
        notes.push({ code: 'regular-unpriced', person: person.id, text: `${person.name}: ${name || 'one kind of regular care'} has no price, so it isn't counted.` });
        continue;
      }
      regular.push({ name, times, cost, since: r.since });
    }
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
      // Regular care already under way is part of this year's dollars: list it, so it explains
      // them instead of being scaled up as other care and then added again.
      const regularUsage = regular.map((r) => {
        const from = r.since === 'next' ? null : Number(r.since) >= 2 ? Number(r.since) : 1;
        return { category: 'ded_coins', count: from == null ? 0 : (r.times * Math.max(0, elapsed - (from - 1))) / 12, allowedEach: r.cost };
      });
      usage.push(...regularUsage);

      const atOwnCap = oopMet >= current.in.oop[0] - TOL;
      const censored = atOwnCap || (familyThisYear && familyCapMet);
      const capMonth = num(person.capMonth);
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
      if (regularUsage.some((u) => u.count > 0) && !censored) {
        const listed = splitUsage(current, usage).throughDed * est.usageScale;
        if (listed > est.charges + 100) {
          notes.push({ code: 'regular-large', person: person.id, text: `${person.name}: the care listed would have put about ${money(listed)} through the deductible so far, more than the ${money(est.charges)} these numbers show. Next year uses the regular care as given.` });
        }
      }
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
    for (const r of regular) {
      items.push(...monthly(Object.assign({ category: 'ded_coins', group: label(r.name || 'regular care') }, who), r.times, r.cost, allMonths));
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
        const allowedEach = num(person.oon.allowed);
        if (allowedEach == null) oonGuessed = true;
        const share = allowedEach != null ? Math.min(1, allowedEach / charge) : config.oonAllowedShare || 1;
        const per = visits / 12;
        for (const m of allMonths) {
          items.push({ person: person.id, network: 'out', category: 'office', group: label('out-of-network visits'), month: m, count: per, billed: charge * per, allowed: charge * per * share });
        }
      }
    }
  }

  // ---- planned events -------------------------------------------------------------------
  const nextIds = new Set(nextYear.map((p) => p.id));
  const planned = plannedEvents(config, answers, nextYear, lastMonth);
  items.push(...planned.map((p) => p.item));

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
  else if (oonGuessed) A('oon-share', `the plan allows ${Math.round(config.oonAllowedShare * 100)}% of an out-of-network bill (a guess)`, 'g-oon');
  if (!regularOn) A('regular', 'no regular care beyond office visits', 'g-regular');
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
  assumePlanned(config, planned, A);

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

// A birth or a surgery the person says is coming next year, as line items. Shared by both paths.
function plannedEvents(config, answers, nextYear, lastMonth) {
  const ev = answers.events || {};
  const out = [];
  for (const key of ['birth', 'surgery']) {
    const e = ev[key];
    if (!e || !e.on || !nextYear.length) continue;
    const who = nextYear.find((p) => p.id === e.person) || nextYear[0];
    const allowed = num(e.allowed) != null ? num(e.allowed) : config.events[key].allowed;
    const month = Math.min(lastMonth, Math.max(1, num(e.month) || 6));
    out.push({
      key,
      person: who.id,
      allowed,
      usedDefault: num(e.allowed) == null,
      item: { person: who.id, network: 'in', category: 'ded_coins', month, allowed, group: `${who.name}: ${config.events[key].label}`, planned: true },
    });
  }
  return out;
}

function assumePlanned(config, planned, A) {
  for (const p of planned) {
    if (p.usedDefault) A(`event-${p.key}-${p.person}`, `${config.events[p.key].label} at ${money(p.allowed)}`, `ev-${p.key}`);
  }
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

// ---- Path B: a table of what happened, scaled to a full year ------------------------------
const NOT_SCALED = new Set(['er_facility', 'er_physician']); // carried over as they happened

function endOfMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${String(month).padStart(2, '0')}-${len[month - 1]}`;
}

// Months from January 1 to a line: to the end of its day, or to the middle of its month.
function position(it) {
  const byDate = it.date ? monthsElapsed(it.date) : null;
  if (byDate != null) return byDate;
  const month = Number(it.month);
  return month >= 1 && month < 13 ? Math.floor(month) - 0.5 : 0.5;
}

// How far into the year the table's care runs. By default that is its latest line: the day,
// when the line has a date, or the end of its month. `table.through` (a date) can push it
// later, never earlier, since care after it is plainly in the table.
function tableThrough(config, table) {
  const year = config.planYear - 1;
  let latest = 0;
  let latestIso = null;
  for (const it of (table && table.items) || []) {
    const byDate = it.date ? monthsElapsed(it.date) : null;
    const month = Math.floor(Number(it.month));
    const at = byDate != null ? byDate : month >= 1 && month <= 12 ? month : 0;
    if (at > latest) {
      latest = at;
      latestIso = byDate != null ? it.date : endOfMonth(year, month);
    }
  }
  const set = table && table.through ? monthsElapsed(table.through) : null;
  const chosen = set != null && set > latest;
  const months = Math.min(12, Math.max(0.5, (chosen ? set : latest) || 12));
  return { months, factor: 12 / months, iso: chosen ? table.through : latestIso, chosen, latestIso };
}

// One line of the table, stretched to its place in a full year at the same rate of care.
function scaleToYear(it, factor) {
  if (factor === 1 || NOT_SCALED.has(it.category)) return it;
  const out = Object.assign({}, it, {
    month: Math.min(12.99, 1 + position(it) * factor),
    allowed: it.allowed * factor,
    count: (it.count == null ? 1 : it.count) * factor,
  });
  delete out.date;
  if (it.billed != null) out.billed = it.billed * factor;
  return out;
}

// Path B: an imported (or hand-edited) table of line items. The people list supplies roles
// for the premium tier; the table supplies the care, as it happened this year, and is scaled
// to twelve months the way the questionnaire's numbers are.
//   table: { items: [...], groupsOff: [labels], through: 'YYYY-MM-DD' | null }
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
  const through = tableThrough(config, table);
  const items = all
    .filter((it) => !off.has(it.group))
    .filter((it) => {
      const p = byName.get(String(it.person).trim().toLowerCase());
      return !p || p.nextYear;
    })
    .map((it) => {
      const p = byName.get(String(it.person).trim().toLowerCase());
      return scaleToYear(Object.assign({}, it, { person: p ? p.id : it.person }), through.factor);
    })
    .filter((it) => Math.floor(it.month || 1) <= lastMonth);
  if (all.length && through.months < 3) {
    notes.push({ code: 'early-year', text: 'The table covers only the start of the year, so scaling it to twelve months is rough.' });
  }

  const planned = plannedEvents(config, answers, nextYear, lastMonth);
  items.push(...planned.map((p) => p.item));

  const facts = moneyFacts(config, answers, nextYear, family, lastMonth, notes);
  if (through.factor === 1) A('table', 'the table covers the whole year', 'q-through');
  else {
    const [, , mm, dd] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(through.iso);
    A('table', `the table covers care through ${MONTHS[Number(mm) - 1]} ${Number(dd)}, and the rest of the year goes on at the same rate`, 'q-through');
    if (items.some((it) => NOT_SCALED.has(it.category))) A('table-er', 'ER visits are counted as they happened, not scaled up', null);
  }
  assumePlanned(config, planned, A);
  finishAssumptions(config, facts, A);

  return Object.assign(facts.public, {
    tierId: tier.id,
    tierLabel: tier.label,
    family,
    items,
    allItems: all,
    through,
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

module.exports = { build, buildFromTable, tableThrough, defaultAnswers, newPerson, PRESETS, RX_DEFAULT_PRICE, RX_LABEL, MONTHS, describeCounts, typicalAllowed };
