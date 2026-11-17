'use strict';
// Scenarios, money views, and the comparisons shown on the front.
//
// Input is a household: the coming year's line items plus the facts the money views need
// (tier, credits, tax rate, elections). Both paths produce one. Output is, per plan, a cost
// for each scenario. Where the guide is silent a plan has variants, so every cost is a
// range { lo, hi }; when nothing is unknown the two ends are equal.

const { replay, ceiling } = require('./engine.js');
const { expandVariants, premiumPerPeriod, getTier } = require('./plans.js');

const SCENARIOS = ['floor', 'expected', 'bad', 'ceiling'];
const SCENARIO_LABELS = {
  floor: 'Floor: premiums only',
  expected: 'Typical year',
  bad: 'Catastrophic year',
  ceiling: 'Ceiling',
};
// The label "never the cheapest" is decided on these. The floor is left out on purpose: it is
// the paycheck dimension, which the label reports separately.
const JUDGED = ['expected', 'bad', 'ceiling'];

function premiumYear(config, plan, hh) {
  const months = hh.monthsCovered || 12;
  const base = premiumPerPeriod(plan, hh.tierId, hh.credit) * config.payPeriods.premium;
  const sur = hh.surcharge && config.spousalSurcharge ? config.spousalSurcharge.monthly * 12 : 0;
  return ((base + sur) * months) / 12;
}

function election(config, plan, hh) {
  if (plan.account === 'fsa' && config.fsa) return { kind: 'fsa', amount: Math.min(hh.fsa || 0, config.fsa.limit), periods: config.payPeriods.fsa };
  if (plan.account === 'hsa' && config.hsa && hh.hsaEligible) {
    return { kind: 'hsa', amount: Math.min(hh.hsa || 0, hh.hsaLimit != null ? hh.hsaLimit : Infinity), periods: config.payPeriods.hsa };
  }
  return { kind: null, amount: 0, periods: config.payPeriods.premium };
}

// What a year costs, split into the pieces the chart stacks.
//   care: { ded, cc, extra }  deductible; copays and coinsurance; charges no cap covers
//   raw view:       every dollar at face value
//   take-home view: premiums are pre-tax, so they cost (1 - t) each. Care is paid from taxed
//                   money unless it goes through an FSA or HSA, in which case those dollars
//                   cost (1 - t) too.
// Care is paid from the account first. Money set aside beyond the year's care is not a cost
// of the plan: HSA money stays yours, and FSA money goes to other eligible things. It is
// reported separately (`aside`) so the chart can show it without counting it.
function breakdown(config, plan, hh, care, view) {
  const k = view === 'raw' ? 1 : 1 - (hh.taxRate || 0);
  const premium = premiumYear(config, plan, hh) * k;
  const C = care.ded + care.cc + care.extra;
  const el = election(config, plan, hh);
  const employer = plan.account === 'hsa' && config.hsa && hh.hsaEligible ? config.hsa.employerContribution || 0 : 0;
  const free = Math.min(employer, C); // an employer's contribution pays first, at no cost to you
  const used = Math.min(el.amount, C - free); // your own account dollars spent on care
  const careCost = used * k + (C - free - used);
  const leftover = el.amount - used;
  const f = C > 0 ? careCost / C : 0;
  return {
    premium,
    ded: care.ded * f,
    cc: care.cc * f,
    extra: care.extra * f,
    total: premium + careCost,
    aside: leftover * k,
    account: el.amount > 0 ? { kind: el.kind, set: el.amount * k, gross: el.amount, used, leftover } : null,
  };
}

function yearCost(config, plan, hh, care, view) {
  return breakdown(config, plan, hh, { ded: 0, cc: care, extra: 0 }, view).total;
}

function perPaycheck(config, plan, hh, view) {
  const periods = config.payPeriods.premium;
  const el = election(config, plan, hh);
  const sur = hh.surcharge && config.spousalSurcharge ? (config.spousalSurcharge.monthly * 12) / periods : 0;
  const premium = premiumPerPeriod(plan, hh.tierId, hh.credit) + sur;
  const elect = el.amount > 0 ? el.amount / el.periods : 0;
  const k = view === 'raw' ? 1 : 1 - (hh.taxRate || 0);
  return { premium: premium * k, election: elect * k, total: (premium + elect) * k, gross: premium + elect, grossElection: elect, electionKind: el.kind };
}

function seriousItems(config, person, month) {
  return config.seriousEvent.items.map((it) => ({
    person,
    month,
    network: 'in',
    category: it.category,
    allowed: it.allowed,
    group: 'Catastrophic year: ' + it.label,
  }));
}

function range(values) {
  return { lo: Math.min(...values), hi: Math.max(...values) };
}

function evaluate(config, hh, opts = {}) {
  const view = opts.view || 'takehome';
  const tier = getTier(config, hh.tierId);
  const family = hh.family != null ? hh.family : tier.family;
  const expectedItems = hh.items;
  const anyRx = expectedItems.some((it) => /^rx_/.test(it.category));
  const anyOut = expectedItems.some((it) => it.network === 'out');
  const eventMonth = Math.min(hh.monthsCovered || 12, 7);
  const candidates = hh.people && hh.people.length ? hh.people.map((p) => p.id) : ['someone'];

  const plans = config.plans.map((plan) => {
    const { variants, open } = expandVariants(plan, { family, rx: anyRx });
    const per = variants.map((v) => {
      const expected = replay(expectedItems, v.plan, { family });
      // The serious event lands on whoever it would cost the household most.
      let bad = null;
      let badPerson = null;
      for (const id of candidates) {
        const r = replay(expectedItems.concat(seriousItems(config, id, eventMonth)), v.plan, { family });
        if (!bad || r.memberTotal > bad.memberTotal) {
          bad = r;
          badPerson = id;
        }
      }
      // Ceiling: the in-network cap. If the household uses out-of-network care, that has its
      // own cap, and whatever sits above the allowed amount (or is not covered) has none, so
      // the figure counts both caps plus those extras as described. It is still not a true
      // ceiling, and the page says so.
      const cap = ceiling(v.plan, family) + (anyOut ? (family ? v.plan.out.oop[1] : v.plan.out.oop[0]) : 0) + bad.uncapped;
      const care = { floor: 0, expected: expected.memberTotal, bad: bad.memberTotal, ceiling: cap };
      const split = (r) => ({ ded: r.parts.ded, cc: r.parts.copay + r.parts.coins, extra: r.uncapped });
      const parts = {
        floor: breakdown(config, v.plan, hh, { ded: 0, cc: 0, extra: 0 }, view),
        expected: breakdown(config, v.plan, hh, split(expected), view),
        bad: breakdown(config, v.plan, hh, split(bad), view),
        ceiling: breakdown(config, v.plan, hh, { ded: 0, cc: cap, extra: 0 }, view),
      };
      const cost = {};
      for (const s of SCENARIOS) cost[s] = parts[s].total;
      const atLeast = (hh.lowerBound || []).some((id) => !expected.capped[id]);
      return { assumptions: v.assumptions, plan: v.plan, care, cost, parts, expected, bad, badPerson, atLeast };
    });

    const scenarios = {};
    for (const s of SCENARIOS) {
      scenarios[s] = range(per.map((v) => v.cost[s]));
      scenarios[s].care = range(per.map((v) => v.care[s]));
      // The stack drawn for this scenario is the cheapest variant's; anything above it, up
      // to the dearest variant, depends on a plan fact the guide leaves open.
      scenarios[s].parts = per.reduce((a, v) => (v.cost[s] < a.cost[s] ? v : a)).parts[s];
    }
    return {
      id: plan.id,
      name: plan.name,
      short: plan.short,
      account: plan.account,
      premiumYear: premiumYear(config, plan, hh),
      paycheck: perPaycheck(config, plan, hh, view),
      deductible: family ? plan.in.ded[1] : plan.in.ded[0],
      deductibleOne: family && plan.in.dedMode === 'aggregate' ? plan.in.ded[1] : plan.in.ded[0],
      cap: ceiling(plan, family),
      scenarios,
      variants: per,
      open, // unknown plan facts in play: [{ id, text, options }]
      atLeast: per.some((v) => v.atLeast),
      noCeiling: anyOut || per.some((v) => v.expected.uncapped > 0),
      hsaBlocked: plan.account === 'hsa' && !hh.hsaEligible,
    };
  });

  // "Never the cheapest": in every judged scenario some other plan certainly costs less.
  const EPS = 1;
  const minPay = Math.min(...plans.map((p) => p.paycheck.total));
  for (const p of plans) {
    p.neverCheapest =
      plans.length > 1 &&
      JUDGED.every((s) => plans.some((q) => q !== p && q.scenarios[s].hi < p.scenarios[s].lo - EPS));
    p.smallestPaycheck = p.paycheck.total <= minPay + 0.005;
  }

  // The trade in words, for each pair of plans still standing.
  const standing = plans.filter((p) => !p.neverCheapest);
  const trades = [];
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) {
      let a = standing[i];
      let b = standing[j];
      if (a.paycheck.total < b.paycheck.total) [a, b] = [b, a]; // a takes more per paycheck
      const mid = (r) => (r.lo + r.hi) / 2;
      trades.push({
        more: a.id,
        less: b.id,
        perPaycheck: a.paycheck.total - b.paycheck.total,
        worstCase: mid(b.scenarios.ceiling) - mid(a.scenarios.ceiling), // positive: a's worst case is lower
        expected: mid(b.scenarios.expected) - mid(a.scenarios.expected), // positive: a is cheaper in the expected year
        expectedOverlap: !(a.scenarios.expected.hi < b.scenarios.expected.lo || b.scenarios.expected.hi < a.scenarios.expected.lo),
      });
    }
  }

  return { view, family, tierId: hh.tierId, plans, trades };
}

// How far would the estimate have to be off before a different plan came out cheapest?
// Scales the whole year's care from none to three times the estimate and notes where the
// cheapest plan (by the middle of its range) changes.
function sensitivity(config, hh, opts = {}) {
  const view = opts.view || 'takehome';
  const maxK = 3;
  const step = 0.05;
  const tier = getTier(config, hh.tierId);
  const family = hh.family != null ? hh.family : tier.family;
  const anyRx = hh.items.some((it) => /^rx_/.test(it.category));
  const plans = config.plans.map((plan) => ({ id: plan.id, variants: expandVariants(plan, { family, rx: anyRx }).variants }));
  const cheapestAt = (k) => {
    const items = hh.items.map((it) =>
      Object.assign({}, it, { allowed: it.allowed * k, count: (it.count == null ? 1 : it.count) * k, billed: it.billed == null ? undefined : it.billed * k })
    );
    let best = null;
    for (const p of plans) {
      const costs = p.variants.map((v) => yearCost(config, v.plan, hh, replay(items, v.plan, { family }).memberTotal, view));
      const mid = (Math.min(...costs) + Math.max(...costs)) / 2;
      if (!best || mid < best.mid - 1e-9) best = { id: p.id, mid };
    }
    return best.id;
  };
  const crossings = [];
  let prev = null;
  let atEstimate = null;
  const n = Math.round(maxK / step);
  for (let i = 0; i <= n; i++) {
    const k = i * step;
    const id = cheapestAt(k);
    if (prev && id !== prev) crossings.push({ k: k - step / 2, from: prev, to: id }); // somewhere inside the step
    if (i === Math.round(1 / step)) atEstimate = id;
    prev = id;
  }
  const nothingToScale = !hh.items.some((it) => it.allowed > 0 && it.category !== 'preventive');
  return { maxK, cheapestAtZero: crossings.length ? crossings[0].from : atEstimate, cheapestAtEstimate: atEstimate, crossings, nothingToScale };
}

// The same thing in a sentence. `short` maps a plan id to its short name.
function sensitivitySentence(sens, short) {
  const best = short(sens.cheapestAtEstimate);
  if (sens.nothingToScale) return `Your estimate has no care in it beyond free checkups, so ${best} costs least. The catastrophic year and the worst case show what happens if that changes.`;
  if (!sens.crossings.length) return `${best} costs least however much care you end up using, from none to ${sens.maxK} times your estimate.`;
  const below = sens.crossings.filter((c) => c.k <= 1).pop();
  const above = sens.crossings.find((c) => c.k > 1);
  const pct = (k) => Math.max(5, Math.round((Math.abs(k - 1) * 100) / 5) * 5);
  const bits = [];
  if (below) {
    bits.push(below.k < 0.06 ? `${short(below.from)} would only cost less with almost no care at all` : `with about ${pct(below.k)}% less care than you estimated, ${short(below.from)} would cost less`);
  }
  if (above) {
    bits.push(above.k >= 2 ? `with about ${above.k.toFixed(1).replace(/\.0$/, '')} times the care, ${short(above.to)} would` : `with about ${pct(above.k)}% more care, ${short(above.to)} would`);
  }
  const rest = bits.join('; ');
  return `At your estimate ${best} costs least. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`;
}

module.exports = { evaluate, sensitivity, sensitivitySentence, yearCost, breakdown, perPaycheck, premiumYear, election, SCENARIOS, SCENARIO_LABELS, JUDGED };
