'use strict';
// Plan configuration helpers. The configuration is plain data (see demo/plans.demo.json
// for the shape). Nothing in here knows any particular employer's numbers.

const CATEGORIES = [
  'preventive',
  'office',
  'teladoc',
  'urgent',
  'er_facility',
  'er_physician',
  'ded_coins',
  'rx_generic',
  'rx_preferred',
  'rx_nonpreferred',
  'rx_specialty',
  'not_covered',
];

const CATEGORY_LABELS = {
  preventive: 'Preventive care',
  office: 'Office or therapy visit',
  teladoc: 'Telehealth visit',
  urgent: 'Urgent care',
  er_facility: 'Emergency room (facility)',
  er_physician: 'Emergency room (physician)',
  ded_coins: 'Hospital, lab, imaging, other',
  rx_generic: 'Prescription: generic',
  rx_preferred: 'Prescription: preferred brand',
  rx_nonpreferred: 'Prescription: non-preferred brand',
  rx_specialty: 'Prescription: specialty',
  not_covered: 'Not covered',
};

const RX_TIERS = ['rx_generic', 'rx_preferred', 'rx_nonpreferred', 'rx_specialty'];

class ConfigError extends Error {}

function fail(msg) {
  throw new ConfigError(msg);
}

function isPair(v) {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= 0);
}

function validateRule(rule, where) {
  if (!rule || typeof rule !== 'object') fail(`${where}: rule is missing`);
  const known = ['free', 'uncovered', 'copay', 'ded', 'coins', 'min', 'max', 'acc'];
  for (const k of Object.keys(rule)) if (!known.includes(k)) fail(`${where}: unknown rule field "${k}"`);
  if (rule.coins !== undefined && rule.coins !== true && !(typeof rule.coins === 'number' && rule.coins >= 0 && rule.coins <= 1)) {
    fail(`${where}: coins must be true (the plan's rate) or a share between 0 and 1`);
  }
  if (rule.acc !== undefined && rule.acc !== 'in' && rule.acc !== 'out') fail(`${where}: acc must be "in" or "out"`);
}

function validateNetwork(side, where) {
  if (!side) fail(`${where}: missing`);
  if (!isPair(side.ded)) fail(`${where}.ded must be [individual, family]`);
  if (!isPair(side.oop)) fail(`${where}.oop must be [individual, family]`);
  if (!(side.coins >= 0 && side.coins <= 1)) fail(`${where}.coins must be the member's share, 0 to 1`);
  if (side.dedMode !== 'embedded' && side.dedMode !== 'aggregate') fail(`${where}.dedMode must be "embedded" or "aggregate"`);
}

function validatePlan(plan, config) {
  const w = `plan "${plan && plan.id}"`;
  if (!plan.id || !plan.name || !plan.short) fail(`${w}: needs id, name and short`);
  validateNetwork(plan.in, `${w}.in`);
  validateNetwork(plan.out, `${w}.out`);
  for (const cat of CATEGORIES) validateRule(plan.rules && plan.rules[cat], `${w}.rules.${cat}`);
  if (!plan.outRules || !plan.outRules.default) fail(`${w}.outRules.default is required`);
  for (const [cat, rule] of Object.entries(plan.outRules)) validateRule(rule, `${w}.outRules.${cat}`);
  if (plan.account !== 'fsa' && plan.account !== 'hsa' && plan.account !== null) fail(`${w}.account must be "fsa", "hsa" or null`);
  if (config) {
    for (const tier of config.tiers) {
      const p = plan.premiums && plan.premiums[tier.id];
      if (!Array.isArray(p) || p.length < 1) fail(`${w}.premiums.${tier.id} is missing`);
    }
  }
  for (const u of plan.unknowns || []) {
    if (!u.id || !u.text || !Array.isArray(u.options) || u.options.length < 2) fail(`${w}: unknown "${u.id}" needs text and at least two options`);
  }
}

function validateConfig(config) {
  if (!config || config.schema !== 1) fail('configuration: schema 1 expected');
  if (!Array.isArray(config.tiers) || !config.tiers.length) fail('configuration: tiers missing');
  if (!Array.isArray(config.plans) || !config.plans.length) fail('configuration: plans missing');
  if (!config.payPeriods || !config.payPeriods.premium) fail('configuration: payPeriods missing');
  const ids = new Set();
  for (const plan of config.plans) {
    validatePlan(plan, config);
    if (ids.has(plan.id)) fail(`configuration: duplicate plan id ${plan.id}`);
    ids.add(plan.id);
  }
  return config;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function applyPatch(plan, patch) {
  const out = clone(plan);
  for (const [path, value] of Object.entries(patch || {})) setPath(out, path, clone(value));
  return out;
}

// Where the guide is silent the configuration lists alternatives. A plan expands into one
// variant per combination of the alternatives that matter for this household.
//   ctx.family: more than one person covered;  ctx.rx: any prescription items in play.
function expandVariants(plan, ctx = {}) {
  let variants = [{ plan, assumptions: [] }];
  const open = [];
  for (const u of plan.unknowns || []) {
    if (u.appliesTo === 'family' && !ctx.family) continue;
    if (u.appliesTo === 'rx' && !ctx.rx) continue;
    open.push(u);
    const next = [];
    for (const v of variants) {
      for (const opt of u.options) {
        next.push({ plan: applyPatch(v.plan, opt.patch), assumptions: v.assumptions.concat([{ id: u.id, label: opt.label }]) });
      }
    }
    variants = next;
  }
  return { variants, open };
}

function getPlan(config, id) {
  const plan = config.plans.find((p) => p.id === id);
  if (!plan) fail(`no plan with id "${id}"`);
  return plan;
}

function getTier(config, id) {
  const tier = config.tiers.find((t) => t.id === id);
  if (!tier) fail(`no tier with id "${id}"`);
  return tier;
}

// Tier from who is covered: counts of spouse/partner and children.
function tierFor(config, { spouse, children }) {
  const id = spouse && children ? 'family' : spouse ? 'spouse' : children ? 'children' : 'employee';
  return getTier(config, id);
}

// Premium per pay period. credit: 0 none, 1 employee, 2 employee and spouse.
// Tiers without a spouse column fall back to the highest column they have.
function premiumPerPeriod(plan, tierId, credit = 0) {
  const row = plan.premiums[tierId];
  if (!row) fail(`plan ${plan.id} has no premiums for tier ${tierId}`);
  return row[Math.min(Math.max(0, credit), row.length - 1)];
}

function ruleFor(plan, category, network) {
  if (network === 'out') {
    const r = plan.outRules[category] || plan.outRules.default;
    return r;
  }
  const r = plan.rules[category];
  if (!r) fail(`plan ${plan.id} has no rule for category "${category}"`);
  return r;
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  RX_TIERS,
  ConfigError,
  validateConfig,
  validatePlan,
  expandVariants,
  applyPatch,
  getPlan,
  getTier,
  tierFor,
  premiumPerPeriod,
  ruleFor,
  clone,
};
