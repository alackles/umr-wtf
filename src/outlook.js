'use strict';
// Scenarios, money views, and the comparisons shown on the front.
//
// Input is a household: the coming year's line items plus the facts the money views need
// (tier, credits, tax rate, elections). Both paths produce one. Output is, per plan, a cost
// for each scenario. Where the guide is silent a plan has variants, so every cost is a
// range { lo, hi }; when nothing is unknown the two ends are equal.

const { replay, ceiling } = require('./engine.js');
const { expandVariants, premiumPerPeriod, getTier } = require('./plans.js');

const SCENARIOS = ['floor', 'quiet', 'expected', 'bad', 'ceiling'];
const SCENARIO_LABELS = {
  floor: 'Floor: premiums only',
  quiet: 'Quiet year',
  expected: 'Expected',
  bad: 'Bad year',
  ceiling: 'Ceiling',
};
// The label "never the cheapest" is decided on these. The floor is left out on purpose: it is
// the paycheck dimension, which the label reports separately.
const JUDGED = ['quiet', 'expected', 'bad', 'ceiling'];

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

// What a year costs, given what the household pays for care (`care`).
//   raw:       premiums + care
//   take-home: premiums are pre-tax, so they cost (1 - t) each. Care is paid from taxed money
//              unless it goes through an FSA or HSA.
//     FSA of E: the first E of care is pre-tax. Unspent money rolls over up to the carryover
//               limit and is lost beyond it.
//     HSA of H: saves t x H whatever the year brings (the money stays yours).
function yearCost(config, plan, hh, care, view) {
  const prem = premiumYear(config, plan, hh);
  const el = election(config, plan, hh);
  const employer = plan.account === 'hsa' && config.hsa && hh.hsaEligible ? config.hsa.employerContribution || 0 : 0;
  if (view === 'raw') return prem + care - employer;
  const t = hh.taxRate || 0;
  let careCost = care;
  if (el.kind === 'fsa' && el.amount > 0) {
    const E = el.amount;
    if (care >= E) careCost = care - t * E;
    else {
      const rolled = Math.min(config.fsa.carryover || 0, E - care);
      careCost = (1 - t) * (E - rolled);
    }
  } else if (el.kind === 'hsa' && el.amount > 0) {
    careCost = care - t * el.amount;
  }
  return prem * (1 - t) + careCost - employer;
}

function perPaycheck(config, plan, hh, view) {
  const periods = config.payPeriods.premium;
  const el = election(config, plan, hh);
  const sur = hh.surcharge && config.spousalSurcharge ? (config.spousalSurcharge.monthly * 12) / periods : 0;
  const premium = premiumPerPeriod(plan, hh.tierId, hh.credit) + sur;
  const elect = el.amount > 0 ? el.amount / el.periods : 0;
  const k = view === 'raw' ? 1 : 1 - (hh.taxRate || 0);
  return { premium: premium * k, election: elect * k, total: (premium + elect) * k, electionKind: el.kind };
}

function seriousItems(config, person, month) {
  return config.seriousEvent.items.map((it) => ({
    person,
    month,
    network: 'in',
    category: it.category,
    allowed: it.allowed,
    group: 'Bad year: ' + it.label,
  }));
}

function scaled(items, k) {
  return items.map((it) =>
    Object.assign({}, it, {
      allowed: it.allowed * k,
      count: (it.count == null ? 1 : it.count) * k,
      billed: it.billed == null ? undefined : it.billed * k,
    })
  );
}

function range(values) {
  return { lo: Math.min(...values), hi: Math.max(...values) };
}

function evaluate(config, hh, opts = {}) {
  const view = opts.view || 'takehome';
  const tier = getTier(config, hh.tierId);
  const family = hh.family != null ? hh.family : tier.family;
  const expectedItems = hh.items;
  const quietItems = expectedItems.filter((it) => !it.oneoff);
  const anyRx = expectedItems.some((it) => /^rx_/.test(it.category));
  const anyOut = expectedItems.some((it) => it.network === 'out');
  const eventMonth = Math.min(hh.monthsCovered || 12, 7);
  const candidates = hh.people && hh.people.length ? hh.people.map((p) => p.id) : ['someone'];

  const plans = config.plans.map((plan) => {
    const { variants, open } = expandVariants(plan, { family, rx: anyRx });
    const per = variants.map((v) => {
      const quiet = replay(quietItems, v.plan, { family });
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
      const cap = ceiling(v.plan, family);
      const care = { floor: 0, quiet: quiet.memberTotal, expected: expected.memberTotal, bad: bad.memberTotal, ceiling: cap };
      const cost = {};
      for (const s of SCENARIOS) cost[s] = yearCost(config, v.plan, hh, care[s], view);
      const atLeast = (hh.lowerBound || []).some((id) => !expected.capped[id]);
      return { assumptions: v.assumptions, plan: v.plan, care, cost, expected, quiet, bad, badPerson, atLeast };
    });

    const scenarios = {};
    for (const s of SCENARIOS) {
      scenarios[s] = range(per.map((v) => v.cost[s]));
      scenarios[s].care = range(per.map((v) => v.care[s]));
    }
    return {
      id: plan.id,
      name: plan.name,
      short: plan.short,
      account: plan.account,
      premiumYear: premiumYear(config, plan, hh),
      paycheck: perPaycheck(config, plan, hh, view),
      deductible: family ? plan.in.ded[1] : plan.in.ded[0],
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

// Break-even: total yearly cost on each plan as usage scales from none to several times the
// estimate. Returns points for drawing and the places where the cheapest plan changes.
function breakEven(config, hh, opts = {}) {
  const view = opts.view || 'takehome';
  const maxK = opts.max || 3;
  const steps = opts.steps || 60;
  const tier = getTier(config, hh.tierId);
  const family = hh.family != null ? hh.family : tier.family;
  const anyRx = hh.items.some((it) => /^rx_/.test(it.category));
  const expanded = config.plans.map((plan) => ({ plan, variants: expandVariants(plan, { family, rx: anyRx }).variants }));
  const series = expanded.map(({ plan }) => ({ id: plan.id, short: plan.short, name: plan.name, points: [] }));
  const ks = [];
  for (let i = 0; i <= steps; i++) ks.push((maxK * i) / steps);
  for (const k of ks) {
    const items = scaled(hh.items, k);
    expanded.forEach(({ variants }, pi) => {
      const costs = variants.map((v) => yearCost(config, v.plan, hh, replay(items, v.plan, { family }).memberTotal, view));
      const r = range(costs);
      series[pi].points.push({ k, lo: r.lo, hi: r.hi, mid: (r.lo + r.hi) / 2 });
    });
  }
  // Where does the cheapest plan (by midpoint) change?
  const crossings = [];
  let prev = null;
  ks.forEach((k, i) => {
    let best = null;
    for (const s of series) if (!best || s.points[i].mid < best.points[i].mid - 1e-9) best = s;
    if (prev && best.id !== prev.id) crossings.push({ k, from: prev.id, to: best.id });
    prev = best;
  });
  const cheapestAt = (k) => {
    const i = Math.round((k / maxK) * steps);
    let best = null;
    for (const s of series) if (!best || s.points[i].mid < best.points[i].mid - 1e-9) best = s;
    return best.id;
  };
  return { ks, series, crossings, maxK, cheapestAtEstimate: cheapestAt(1), cheapestAtZero: cheapestAt(0) };
}

module.exports = { evaluate, breakEven, yearCost, perPaycheck, premiumYear, election, scaled, SCENARIOS, SCENARIO_LABELS, JUDGED };
