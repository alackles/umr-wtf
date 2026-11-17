'use strict';
// From accumulators to charges.
//
// What someone paid this year is the output of this year's plan, so it cannot be carried to
// another plan directly. This backs out the underlying charges first.
//
// Per person the plan has taken money three ways: flat copays, the deductible, and
// coinsurance. The deductible dollars are reported directly ("deductible met"). Copays are
// estimated from the visits and fills the person lists. What is left of "out-of-pocket met"
// is coinsurance, and coinsurance divided by the member's share is the charge behind it:
//
//     charges = deductible met + (out-of-pocket met - deductible met - copays - known coinsurance) / share
//
// "Known coinsurance" is care that skips the deductible but still takes a percentage (an
// emergency room visit on some plans). The same formula covers the case where the family
// deductible, not the person's own, is what stopped their deductible from growing.
//
// Everything is read off the current plan's rules, so nothing here is specific to one plan
// design: if this year's plan sends office visits to the deductible, the visits are simply
// part of the charges rather than part of the copays.

const { ruleFor } = require('./plans.js');

const TOL = 1; // dollars of slack before two numbers are called different

// usage: [{ category, count, allowedEach, given }] care the person listed, year to date.
// `given` marks a price the person typed; the rest are the tool's typical figures.
// Returns how those lines split under the plan: copays, coinsurance that skips the
// deductible, and charges that go through the deductible (`given` is the part of those
// charges that stands on prices the person typed).
function splitUsage(plan, usage) {
  let copays = 0;
  let knownCoins = 0;
  let throughDed = 0;
  let given = 0;
  for (const u of usage) {
    if (!(u.count > 0)) continue;
    const rule = ruleFor(plan, u.category, 'in');
    if (rule.free || rule.uncovered) continue;
    const allowed = u.allowedEach * u.count;
    const c = Math.min((rule.copay || 0) * u.count, allowed);
    const rem = allowed - c;
    copays += c;
    if (rule.ded) {
      throughDed += rem;
      if (u.given) given += rem;
    } else if (rule.coins) {
      const rate = rule.coins === true ? plan.in.coins : rule.coins;
      let s = rem * rate;
      if (rule.min != null) s = Math.max(s, rule.min * u.count);
      if (rule.max != null) s = Math.min(s, rule.max * u.count);
      knownCoins += Math.min(s, rem);
    }
  }
  return { copays, knownCoins, throughDed, given };
}

// Back out one person's year-to-date charges.
//
//   plan            the current plan (configuration object)
//   family          more than one person on the plan this year
//   dedMet, oopMet  the person's accumulators
//   usage           listed care, year to date (see splitUsage)
//   familyDedMet    the family deductible has been reached
//   censored        the person, or the family, is at an out-of-pocket cap
//   paidShare       0..1, the part of the listed care that fell before the cap was reached
//                   (1 when not censored; null when censored and the month is not known)
//   trust           how to settle listed care that costs more than the dollars reported:
//                   'dollars' | 'counts' | null (unsettled: reported as a problem)
//   slack           dollars of disagreement to let through as 'dollars' without asking
//
// Returns { charges, residual, copays, coinsurance, usageScale, priceScale, extraCopays, problems, notes }
//   charges     everything that went through deductible and coinsurance, year to date
//   residual    charges not explained by the listed care: labs, imaging, hospital, the rest
//   priceScale  1, or less when the plan sends visits through the deductible and the visits
//               listed, at typical prices, come to more than the charges. The charges are
//               the person's own dollars and the prices are the tool's guess, so the prices
//               give way: multiply them by this. Prices the person typed are left alone.
//   listedGiven the part of the listed care that stands on prices the person typed
//   problems    [{ code, text, blocking }]  inconsistent inputs, said out loud
function backOut(input) {
  const { plan, family, usage } = input;
  const d = Number(input.dedMet) || 0;
  const o = Number(input.oopMet) || 0;
  const D = plan.in.ded[0];
  const cap = plan.in.oop[0];
  const share = plan.in.coins;
  const problems = [];
  const notes = [];
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

  if (d > D + TOL && !(family && plan.in.dedMode === 'aggregate')) {
    problems.push({ code: 'ded-over', blocking: true, text: `Deductible met (${money(d)}) is more than this plan's deductible (${money(D)}). Is the current plan right?` });
  }
  if (o > cap + TOL) {
    problems.push({ code: 'oop-over', blocking: true, text: `Out-of-pocket met (${money(o)}) is more than this plan's cap (${money(cap)}). Is the current plan right?` });
  }
  if (o < d - TOL) {
    problems.push({ code: 'oop-under-ded', blocking: true, text: `Out-of-pocket met (${money(o)}) is less than deductible met (${money(d)}). The deductible counts toward out-of-pocket, so it should be at least as large.` });
  }
  if (problems.length) return { charges: 0, residual: 0, copays: 0, coinsurance: 0, usageScale: 1, priceScale: 1, listedGiven: 0, extraCopays: 0, problems, notes };

  let { copays, knownCoins, throughDed, given } = splitUsage(plan, usage);
  let usageScale = 1;
  const paidShare = input.censored ? input.paidShare : 1;
  if (paidShare != null) {
    // Only the care that fell before the cap left a trace in the dollars.
    copays *= paidShare;
    knownCoins *= paidShare;
    throughDed *= paidShare;
    given *= paidShare;
  }

  const afterDed = o - d;
  let coins = afterDed - copays - knownCoins;
  let extraCopays = 0;

  if (coins < -TOL) {
    if (input.censored && paidShare == null) {
      // At the cap with no month given: care after the cap cost nothing, so listed care can
      // honestly exceed the dollars. Not a contradiction; the result is a lower bound anyway.
      coins = 0;
    } else if (afterDed - copays >= -TOL) {
      // The copays fit; only the percentage-based care (the ER estimate) is too big. Shrink it.
      notes.push({ code: 'er-shrunk', text: 'The typical emergency-room amount is more than the dollars reported allow, so a smaller one was used.' });
      knownCoins = Math.max(0, afterDed - copays);
      coins = 0;
    } else if (input.trust === 'dollars' || (!input.trust && -coins <= (input.slack || 0))) {
      usageScale = copays > 0 ? Math.max(0, afterDed) / copays : 0;
      notes.push({ code: 'trusted-dollars', text: 'Visit counts were scaled down to fit the dollars reported.' });
      copays = Math.max(0, afterDed);
      knownCoins = 0;
      coins = 0;
    } else if (input.trust === 'counts') {
      notes.push({ code: 'trusted-counts', text: 'Visit counts were kept; the out-of-pocket figure was treated as out of date.' });
      coins = 0;
    } else {
      problems.push({
        code: 'copays-exceed',
        blocking: true,
        shortfall: -coins,
        text: `The visits and prescriptions listed would cost about ${money(copays + knownCoins)} in copays, but only ${money(Math.max(0, afterDed))} was paid beyond the deductible. Which should the tool trust?`,
      });
      coins = 0;
    }
  }

  // A pooled family deductible is only met when the family's is; one person's share says nothing.
  const pooled = !!family && plan.in.dedMode === 'aggregate';
  const dedSatisfied = (!pooled && d >= D - TOL) || !!input.familyDedMet;
  if (coins > TOL && !dedSatisfied && !input.censored) {
    // Coinsurance cannot start before a deductible is met, so this money was something flat:
    // visits or prescriptions that were not listed. On a plan with no visit copay there is
    // no such thing to count it as, and it is carried as other care.
    extraCopays = coins;
    coins = 0;
    const flat = ruleFor(plan, 'office', 'in').copay > 0;
    notes.push({
      code: 'extra-copays',
      amount: extraCopays,
      text: flat
        ? `${money(extraCopays)} of what was paid is not explained by the care listed, and the deductible is not met, so it was treated as copays for more visits.`
        : `${money(extraCopays)} was paid beyond the deductible though the deductible is not met. It was counted as other care.`,
    });
  }

  const viaCoins = share > 0 ? Math.max(0, coins) / share : 0;
  const charges = d + viaCoins;
  const listedGiven = given * usageScale;
  const listedGuessed = (throughDed - given) * usageScale;
  let priceScale = 1;
  // At a cap with no month given the charges are only a lower bound, so they prove nothing
  // about prices.
  const lowerBound = input.censored && paidShare == null;
  if (!lowerBound && listedGuessed > TOL && listedGiven + listedGuessed > charges + TOL) {
    priceScale = Math.max(0, charges - listedGiven) / listedGuessed;
    notes.push({
      code: 'prices-shrunk',
      scale: priceScale,
      text: `At typical full prices the care listed comes to ${money(listedGiven + listedGuessed)}, more than the ${money(charges)} these numbers show, so lower prices were used.`,
    });
  }
  const residual = Math.max(0, charges - listedGiven - listedGuessed * priceScale);
  return { charges, residual, copays, coinsurance: Math.max(0, coins), knownCoins, usageScale, priceScale, listedGiven, extraCopays, problems, notes };
}

// Months of the year elapsed at a date, as a fraction of twelve. "2026-07-01" -> about 6.
function monthsElapsed(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || day < 1 || day > len[mo - 1]) return null;
  let doy = day;
  for (let i = 0; i < mo - 1; i++) doy += len[i];
  return (12 * doy) / (leap ? 366 : 365);
}

module.exports = { backOut, splitUsage, monthsElapsed, TOL };
