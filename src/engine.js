'use strict';
// The replay engine. Walks a year of line items in date order under one plan's rules and
// tracks individual and family deductibles and out-of-pocket caps, separately for
// in-network and out-of-network. Pure: no DOM, no clock, no configuration lookups beyond
// the plan object it is handed.
//
// A line item:
//   person    string   who the care was for
//   month     1..12    when (or `date: "YYYY-MM-DD"`, which wins if both are given)
//   category  one of plans.CATEGORIES (or any category the plan has a rule for)
//   allowed   number   the plan's allowed amount for the whole line
//   network   "in" | "out"   (default "in")
//   count     number   how many visits or fills the line stands for (default 1). Copays are
//                      charged per count. 0 means the line rides on a visit that is already
//                      counted, such as a lab drawn during an office visit.
//   billed    number   out-of-network only: what the provider charged. Anything above
//                      `allowed` is the member's, counts toward nothing, and has no cap.
//   group     string   optional label, used by the page to switch sets of lines on and off
//
// A rule (from the plan configuration) is read in this order:
//   free       member pays nothing
//   uncovered  member pays everything; nothing counts toward deductible or cap
//   copay      flat amount per count, taken first
//   ded        what is left goes to the deductible while there is room
//   coins      member's share of what is left: true = the plan's rate, or a number
//   min, max   floor and ceiling on the coinsurance amount, per count
//   acc        "in" or "out": which set of accumulators the line counts toward

const { ruleFor } = require('./plans.js');

class ItemError extends Error {}

function sortKey(item) {
  if (item.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
    if (!m) throw new ItemError(`unreadable date "${item.date}" (expected YYYY-MM-DD)`);
    return Number(m[2]) * 100 + Number(m[3]);
  }
  const month = Number(item.month);
  if (!(month >= 1 && month < 13)) throw new ItemError(`item needs a month from 1 to 12 or a date (got ${item.month})`);
  return month * 100 + 15;
}

function newAcc() {
  return { ded: {}, oop: {}, fded: 0, foop: 0 };
}

function replay(items, plan, opts = {}) {
  const family = opts.family !== false;
  const acc = { in: newAcc(), out: newAcc() };
  const byPerson = {};
  const parts = { copay: 0, ded: 0, coins: 0 };
  const lines = [];
  let total = 0;
  let uncapped = 0;

  const order = items.map((it, i) => ({ it, i, k: sortKey(it) })).sort((a, b) => a.k - b.k || a.i - b.i);

  for (const { it, i } of order) {
    const a = Number(it.allowed);
    if (!(a >= 0) || !isFinite(a)) throw new ItemError(`item ${i + 1}: allowed amount must be a number, zero or more`);
    if (it.person == null || it.person === '') throw new ItemError(`item ${i + 1}: person is missing`);
    const net = it.network === 'out' ? 'out' : 'in';
    if (it.network != null && it.network !== 'in' && it.network !== 'out') {
      throw new ItemError(`item ${i + 1}: network must be "in" or "out"`);
    }
    const rule = ruleFor(plan, it.category, net);
    if (!rule) throw new ItemError(`item ${i + 1}: no rule for category "${it.category}"`);
    const count = it.count == null ? 1 : Number(it.count);
    if (!(count >= 0)) throw new ItemError(`item ${i + 1}: count must be zero or more`);
    const p = String(it.person);
    const who = byPerson[p] || (byPerson[p] = { in: 0, out: 0, uncapped: 0 });
    const line = { index: i, copay: 0, ded: 0, coins: 0, uncapped: 0, counted: 0 };
    lines.push(line);

    const billed = it.billed == null ? a : Number(it.billed);
    if (rule.uncovered) {
      line.uncapped = Math.max(a, billed);
      who.uncapped += line.uncapped;
      uncapped += line.uncapped;
      continue;
    }
    if (net === 'out' && billed > a) {
      line.uncapped = billed - a;
      who.uncapped += line.uncapped;
      uncapped += line.uncapped;
    }
    if (rule.free) continue;

    const side = rule.acc || net;
    const lim = plan[side];
    const A = acc[side];
    const dedSoFar = A.ded[p] || 0;
    const oopSoFar = A.oop[p] || 0;

    let rem = a;
    let c = 0;
    let d = 0;
    let s = 0;
    if (rule.copay) {
      c = Math.min(rule.copay * count, rem);
      rem -= c;
    }
    if (rule.ded) {
      let room;
      if (!family) room = lim.ded[0] - dedSoFar;
      else if (lim.dedMode === 'aggregate') room = lim.ded[1] - A.fded;
      else room = Math.min(lim.ded[0] - dedSoFar, lim.ded[1] - A.fded);
      d = Math.min(rem, Math.max(0, room));
      rem -= d;
      A.ded[p] = dedSoFar + d;
      A.fded += d;
    }
    if (rule.coins) {
      const rate = rule.coins === true ? lim.coins : rule.coins;
      s = rem * rate;
      if (rule.min != null) s = Math.max(s, rule.min * count);
      if (rule.max != null) s = Math.min(s, rule.max * count);
      s = Math.min(s, rem);
    }

    let tot = c + d + s;
    const cap = Math.max(0, family ? Math.min(lim.oop[0] - oopSoFar, lim.oop[1] - A.foop) : lim.oop[0] - oopSoFar);
    if (tot > cap) {
      const scale = tot ? cap / tot : 0;
      c *= scale;
      d *= scale;
      s *= scale;
      tot = cap;
    }
    A.oop[p] = oopSoFar + tot;
    A.foop += tot;
    who[side] += tot;
    parts.copay += c;
    parts.ded += d;
    parts.coins += s;
    total += tot;
    line.copay = c;
    line.ded = d;
    line.coins = s;
    line.counted = tot;
  }

  // Did anyone (or the family) run into an in-network cap?
  const capped = {};
  for (const p of Object.keys(byPerson)) {
    const o = acc.in.oop[p] || 0;
    capped[p] = o >= plan.in.oop[0] - 0.005 || (family && acc.in.foop >= plan.in.oop[1] - 0.005);
  }

  return {
    total, // counted toward the caps, in- and out-of-network together
    uncapped, // not covered, or above the allowed amount out of network: no cap applies
    memberTotal: total + uncapped,
    byPerson,
    parts,
    acc,
    capped,
    lines,
  };
}

// The most the plan can make a household pay in-network in a year.
function ceiling(plan, family) {
  return family ? plan.in.oop[1] : plan.in.oop[0];
}

module.exports = { replay, ceiling, sortKey, ItemError };
