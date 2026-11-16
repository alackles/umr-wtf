'use strict';
// The page. State is one plain object; the form is rebuilt when its structure changes and
// the results are rebuilt on every change. Nothing here talks to a network.

const { h, dollars, dollarsRange, parseNumber, clear } = require('./dom.js');
const { validateConfig, getPlan, RX_TIERS } = require('../plans.js');
const { build, buildFromTable, defaultAnswers, newPerson, PRESETS, RX_DEFAULT_PRICE, RX_LABEL, MONTHS, describeCounts } = require('../household.js');
const { evaluate, breakEven, SCENARIOS, SCENARIO_LABELS } = require('../outlook.js');
const { parseTable, toCsv, COLUMNS } = require('../importer.js');
const { CATEGORIES } = require('../plans.js');
const { stackedBars, breakEvenChart, breakEvenSentence, hideTip } = require('./charts.js');
const { itemsTable } = require('./table.js');

const STORE_VERSION = 1;
let config;
let S; // { v, mode: 'A' | 'B', answers, table: { items, groupsOff, oneoffGroups }, importText, importErrors }
const ui = { openGroups: new Set(), advOpen: false, uid: 1, scenario: 'expected' };
let formEl;
let resultsEl;

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- storage: this tab only -----------------------------------------------------------------
const storeKey = () => `umr-wtf:${config.planYear}:${config.plans.map((p) => p.id).join('+')}`;
function save() {
  try {
    sessionStorage.setItem(storeKey(), JSON.stringify(S));
  } catch (e) {
    /* private window or storage blocked: the page still works, it just forgets on reload */
  }
}
function load() {
  try {
    const raw = sessionStorage.getItem(storeKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.v === STORE_VERSION && data.answers ? data : null;
  } catch (e) {
    return null;
  }
}
function fresh() {
  return { v: STORE_VERSION, mode: 'A', answers: defaultAnswers(config, todayIso()), table: { items: [], groupsOff: [], oneoffGroups: {} }, importText: '', importErrors: [] };
}

function changed(structural) {
  save();
  if (structural) renderForm();
  renderResults();
}

// ---- small form pieces ----------------------------------------------------------------------
function field(label, control, hint, attrs) {
  return h('label', Object.assign({ class: 'field' }, attrs), h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

// A number box bound to obj[key]. Accepts "$1,234.00" as pasted from a portal.
function numberBox(obj, key, opts = {}) {
  const input = h('input', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    id: opts.id,
    class: 'num' + (opts.wide ? ' wide' : ''),
    value: obj[key] == null ? '' : String(obj[key]),
    placeholder: opts.placeholder,
    'aria-label': opts.aria,
    oninput: (e) => {
      const v = parseNumber(e.target.value);
      const bad = (v != null && isNaN(v)) || (v != null && v < 0) || (v != null && opts.max != null && v > opts.max);
      e.target.classList.toggle('bad', bad);
      obj[key] = bad ? null : v;
      changed(false);
    },
    onchange: () => {
      if (opts.structural) changed(true);
    },
  });
  if (!opts.prefix && !opts.suffix) return input;
  return h('span', { class: 'affix' }, opts.prefix ? h('span', { class: 'pre' }, opts.prefix) : null, input, opts.suffix ? h('span', { class: 'suf' }, opts.suffix) : null);
}

function choice(options, current, onPick, opts = {}) {
  return h(
    'div',
    { class: 'choice' + (opts.stack ? ' stack' : ''), role: 'group', id: opts.id, 'aria-label': opts.aria },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip' + (o.value === current ? ' on' : ''),
          'aria-pressed': o.value === current ? 'true' : 'false',
          'data-focus': `${opts.id || opts.aria}:${o.value}`,
          onclick: () => onPick(o.value),
        },
        h('span', { class: 'chip-label' }, o.label),
        o.sub ? h('span', { class: 'chip-sub' }, o.sub) : null
      )
    )
  );
}

function yesNo(value, onPick, id) {
  return choice(
    [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ],
    value,
    onPick,
    { id, aria: id }
  );
}

function monthSelect(value, onPick, opts = {}) {
  return h(
    'select',
    { 'aria-label': opts.aria || 'month', onchange: (e) => onPick(e.target.value === '' ? null : Number(e.target.value)) },
    opts.blank ? h('option', { value: '', selected: value == null }, opts.blank) : null,
    MONTHS.map((m, i) => h('option', { value: i + 1, selected: value === i + 1 }, m))
  );
}

function personSelect(value, people, onPick) {
  return h(
    'select',
    { 'aria-label': 'who', onchange: (e) => onPick(e.target.value) },
    people.map((p) => h('option', { value: p.id, selected: p.id === value }, p.name))
  );
}

function check(obj, key, label, opts = {}) {
  return h(
    'label',
    { class: 'check', id: opts.id },
    h('input', {
      type: 'checkbox',
      checked: !!obj[key],
      onchange: (e) => {
        obj[key] = e.target.checked;
        changed(opts.structural !== false);
      },
    }),
    h('span', null, label)
  );
}

function section(n, title, intro, ...body) {
  return h('section', { class: 'card' }, h('h2', null, n != null ? h('span', { class: 'step' }, String(n)) : null, title), intro ? h('p', { class: 'intro' }, intro) : null, body);
}

const poss = (p) => (p.role === 'self' && p.name === 'You' ? 'your' : `${p.name}'s`);
const subj = (p) => (p.role === 'self' && p.name === 'You' ? 'you' : p.name);

// ---- the form -------------------------------------------------------------------------------
function renderForm() {
  const active = document.activeElement;
  const focusKey = active && active.getAttribute && (active.getAttribute('data-focus') || active.id);
  const y = window.scrollY;
  clear(formEl);
  const a = S.answers;
  const current = a.currentPlan ? getPlan(config, a.currentPlan) : null;
  const onPlan = current ? a.people.filter((p) => p.thisYear) : [];
  const next = a.people.filter((p) => p.nextYear);
  let n = 1;

  formEl.appendChild(
    h(
      'div',
      { class: 'modes', role: 'group', 'aria-label': 'How to fill this in' },
      choice(
        [
          { value: 'A', label: 'Answer a few questions', sub: 'From memory and two numbers per person. For everyone.' },
          { value: 'B', label: 'Use real claims', sub: 'A table of line items, usually made by an AI agent from your EOBs.' },
        ],
        S.mode,
        (v) => {
          S.mode = v;
          changed(true);
        },
        { id: 'mode', aria: 'mode' }
      )
    )
  );

  formEl.appendChild(peopleSection(n++, a, current));
  if (S.mode === 'A') {
    formEl.appendChild(thisYearSection(n++, a, current, onPlan));
    formEl.appendChild(usageSection(n++, a, current));
    formEl.appendChild(gatesSection(n++, a, current, onPlan, next));
    formEl.appendChild(eventsSection(n++, a, next));
  } else {
    formEl.appendChild(importSection(n++));
    formEl.appendChild(
      section(
        n++,
        'One eligibility question',
        null,
        gate(a, 'hsa', 'Is anyone on Medicare, or does your spouse have their own FSA?', hsaPanel(a))
      )
    );
  }
  formEl.appendChild(prioritySection(n++, a));
  formEl.appendChild(advancedSection(a, current, onPlan, next));

  const layout = formEl.parentNode;
  if (layout) layout.className = 'layout' + (S.mode === 'B' ? ' mode-b' : '');
  window.scrollTo(0, y);
  if (focusKey) {
    const again = formEl.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`) || document.getElementById(focusKey);
    if (again && again.focus) again.focus({ preventScroll: true });
  }
}

function peopleSection(n, a, current) {
  const hasSpouse = a.people.some((p) => p.role === 'spouse');
  const rows = a.people.map((p) => {
    const nameBox = h('input', {
      type: 'text',
      class: 'name',
      value: p.name,
      'aria-label': 'Name',
      onchange: (e) => {
        p.name = e.target.value.trim() || (p.role === 'self' ? 'You' : p.role === 'spouse' ? 'Spouse or partner' : 'Child');
        changed(true);
      },
    });
    const role =
      S.mode === 'B' || p.role == null
        ? h(
            'select',
            {
              'aria-label': `Who is ${p.name}`,
              class: p.role == null ? 'bad' : null,
              onchange: (e) => {
                const v = e.target.value || null;
                if (v === 'self' || v === 'spouse') {
                  // only one of each: whoever held the role before becomes unassigned, or goes if unused
                  a.people = a.people.filter((q) => q === p || q.role !== v || tableHas(q.name));
                  for (const q of a.people) if (q !== p && q.role === v) q.role = null;
                }
                p.role = v;
                changed(true);
              },
            },
            h('option', { value: '', selected: p.role == null }, 'who is this?'),
            h('option', { value: 'self', selected: p.role === 'self' }, 'the employee (you)'),
            h('option', { value: 'spouse', selected: p.role === 'spouse' }, 'spouse or partner'),
            h('option', { value: 'child', selected: p.role === 'child' }, 'child')
          )
        : h('span', { class: 'role' }, p.role === 'self' ? 'the employee' : p.role === 'spouse' ? 'spouse or partner' : 'child');
    return h(
      'div',
      { class: 'person-row' },
      nameBox,
      role,
      h('span', { class: 'years' }, current && S.mode === 'A' ? check(p, 'thisYear', 'this year') : null, check(p, 'nextYear', 'next year')),
      p.role === 'self' && S.mode === 'A'
        ? null
        : h(
            'button',
            {
              type: 'button',
              class: 'link',
              'aria-label': `Remove ${p.name}`,
              onclick: () => {
                a.people = a.people.filter((q) => q !== p);
                changed(true);
              },
            },
            'remove'
          )
    );
  });
  const add = (role) => () => {
    const id = 'p' + Date.now().toString(36) + ui.uid++;
    const count = a.people.filter((p) => p.role === 'child').length;
    const person = newPerson(id, role, role === 'child' && count ? `Child ${count + 1}` : undefined);
    if (!a.currentPlan) person.thisYear = false;
    a.people.push(person);
    changed(true);
  };
  const hh = safeFacts();
  return section(
    n,
    'Who is covered',
    S.mode === 'B' ? 'Names here have to match the names in your table. Say who each person is so the premium tier is right.' : 'Names are optional and stay on this page. The ticks say who is on the plan each year: if someone is joining or leaving, untick the year they are not on it.',
    h('div', { id: 'q-people', class: 'people' }, rows),
    h(
      'div',
      { class: 'row-actions' },
      hasSpouse ? null : h('button', { type: 'button', class: 'btn', 'data-focus': 'add-spouse', onclick: add('spouse') }, '+ spouse or partner'),
      h('button', { type: 'button', class: 'btn', 'data-focus': 'add-child', onclick: add('child') }, '+ child')
    ),
    hh ? h('p', { class: 'derived' }, 'Premium tier next year: ', h('b', null, hh.tierLabel)) : null
  );
}

function tableHas(name) {
  const k = String(name).trim().toLowerCase();
  return S.table.items.some((it) => String(it.person).trim().toLowerCase() === k);
}

function thisYearSection(n, a, current, onPlan) {
  const options = config.plans.filter((p) => p.currentYearOption).map((p) => ({ value: p.id, label: p.name }));
  options.push({ value: null, label: 'None', sub: 'new here, or waived this year' });
  const body = [
    choice(
      options,
      a.currentPlan,
      (v) => {
        a.currentPlan = v;
        for (const p of a.people) p.thisYear = !!v;
        changed(true);
      },
      { id: 'q-current', aria: 'Current plan' }
    ),
  ];
  if (current) {
    body.push(
      h('p', { class: 'hint block' }, config.hints && config.hints.accumulators),
      field(
        'These numbers are as of',
        h('input', {
          type: 'date',
          id: 'q-asof',
          value: a.asOf || '',
          onchange: (e) => {
            a.asOf = e.target.value;
            changed(false);
          },
        }),
        'The date on the EOB, or the day you looked at the portal. Used to scale to a full year.'
      )
    );
    for (const p of onPlan) {
      body.push(
        h(
          'div',
          { class: 'person-block', id: `q-met-${p.id}` },
          h('h3', null, p.name),
          h(
            'div',
            { class: 'pair' },
            field('Deductible met', numberBox(p, 'dedMet', { prefix: '$', placeholder: '0', aria: `${p.name} deductible met` }), `out of ${dollars(current.in.ded[0])}`),
            field('Out-of-pocket met', numberBox(p, 'oopMet', { prefix: '$', placeholder: '0', aria: `${p.name} out-of-pocket met` }), `out of ${dollars(current.in.oop[0])}`)
          ),
          h('p', { class: 'working', id: `work-${p.id}` })
        )
      );
    }
    if (onPlan.length > 1) {
      body.push(
        h(
          'div',
          { class: 'person-block', id: 'q-family-met' },
          h('h3', null, 'The family numbers ', h('span', { class: 'optional' }, 'optional, a cross-check')),
          h(
            'div',
            { class: 'pair' },
            field('Family deductible met', numberBox(a.familyMet, 'ded', { prefix: '$', aria: 'Family deductible met' }), `out of ${dollars(current.in.ded[1])}`),
            field('Family out-of-pocket met', numberBox(a.familyMet, 'oop', { prefix: '$', aria: 'Family out-of-pocket met' }), `out of ${dollars(current.in.oop[1])}`)
          )
        )
      );
    }
  } else {
    body.push(h('p', { class: 'hint block' }, 'No numbers to copy, then. The next question does the work.'));
  }
  return section(n, 'This year', 'Which plan are you on now? What you have paid so far is the best evidence of how much care your household uses.', body);
}

function usageSection(n, a, current) {
  const blocks = a.people
    .filter((p) => p.nextYear || (current && p.thisYear))
    .map((p) => {
      const onPlan = !!current && p.thisYear;
      const opts = Object.entries(PRESETS).map(([id, pr]) => ({ value: id, label: pr.label, sub: describeCounts(pr.counts) + ' a year' }));
      opts.push({ value: 'counts', label: 'Let me count', sub: onPlan ? 'visits so far this year' : 'visits in a typical year' });
      const block = h(
        'div',
        { class: 'person-block', id: `q-usage-${p.id}` },
        h('h3', null, p.name),
        choice(
          opts,
          p.usage,
          (v) => {
            if (v === 'counts' && p.usage && PRESETS[p.usage] && p.counts.office == null) {
              // start the counts from the preset just picked
              const months = onPlan ? monthsSoFar(a) : 12;
              for (const k of ['office', 'therapy', 'urgent']) p.counts[k] = Math.round((PRESETS[p.usage].counts[k] * months) / 12);
            }
            p.usage = v;
            p.trust = null;
            changed(true);
          },
          { id: `usage-${p.id}`, aria: `How much care ${subj(p)} uses`, stack: true }
        )
      );
      if (p.usage === 'counts') {
        const when = onPlan ? 'so far this year' : 'a year';
        block.appendChild(
          h(
            'div',
            { class: 'quad' },
            field('Doctor or specialist visits', numberBox(p.counts, 'office', { placeholder: '0', aria: 'office visits' }), when),
            field('Therapy, PT or chiropractic', numberBox(p.counts, 'therapy', { placeholder: '0', aria: 'therapy sessions' }), when),
            field('Urgent care', numberBox(p.counts, 'urgent', { placeholder: '0', aria: 'urgent care visits' }), when),
            field('Emergency room', numberBox(p.counts, 'er', { placeholder: '0', aria: 'ER visits' }), when)
          )
        );
        if (!onPlan) {
          block.appendChild(field('Other care in a year: labs, imaging, procedures', numberBox(p, 'other', { prefix: '$', placeholder: '0', wide: true, aria: 'other care' }), 'A rough total of the bills, before insurance. Leave blank for none.'));
        }
      }
      block.appendChild(h('div', { class: 'settle', id: `settle-${p.id}` }));
      return block;
    });
  return section(n, 'How much care', 'Checkups and other preventive care are free on every plan, so they do not count here.', blocks);
}

function monthsSoFar(a) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a.asOf || '');
  return m ? Math.max(1, Math.min(12, Number(m[2]) - 1 + Number(m[3]) / 30)) : 12;
}

function gate(a, key, question, panel) {
  const v = a.gates[key];
  return h(
    'div',
    { class: 'gate', id: `g-${key}` },
    h('div', { class: 'gate-q' }, h('span', null, question), yesNo(v, (nv) => {
      a.gates[key] = nv;
      changed(true);
    }, `gate-${key}`)),
    v === true ? h('div', { class: 'panel' }, panel) : null
  );
}

function hsaPanel(a) {
  return [
    check(a.hsa, 'selfMedicare', 'I am enrolled in Medicare (any part)', { structural: false }),
    check(a.hsa, 'spouseFsa', 'My spouse has a general-purpose health FSA through their own job', { structural: false }),
    h('p', { class: 'hint block' }, 'Either one means you cannot put money in an HSA, so the high-deductible plan is shown without that tax benefit. A spouse or child on Medicare does not block you.'),
  ];
}

function gatesSection(n, a, current, onPlan, next) {
  const everyone = a.people.filter((p) => p.nextYear || (current && p.thisYear));
  const rxPanel = everyone.map((p) =>
    h(
      'div',
      { class: 'person-block' },
      h('h3', null, p.name),
      h(
        'table',
        { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'fills a month'), h('th', null, 'cash price per fill'))),
        h(
          'tbody',
          null,
          RX_TIERS.map((t) => {
            if (!p.rx[t]) p.rx[t] = { fills: null, price: null };
            return h(
              'tr',
              null,
              h('th', { scope: 'row' }, RX_LABEL[t]),
              h('td', null, numberBox(p.rx[t], 'fills', { placeholder: '0', aria: `${p.name} ${RX_LABEL[t]} fills a month` })),
              h('td', null, numberBox(p.rx[t], 'price', { prefix: '$', placeholder: String(RX_DEFAULT_PRICE[t]), aria: `${p.name} ${RX_LABEL[t]} cash price` }))
            );
          })
        )
      )
    )
  );
  rxPanel.push(h('p', { class: 'hint block' }, 'The cash price only matters for a plan that sends prescriptions to the deductible. A pharmacy receipt or a discount-card site will show it; the grey numbers are rough stand-ins.'));

  const oonPanel = next.map((p) =>
    h(
      'div',
      { class: 'person-block' },
      h('h3', null, p.name),
      h(
        'div',
        { class: 'pair' },
        field('Visits a year', numberBox(p.oon, 'visits', { placeholder: '0', aria: `${p.name} out-of-network visits` })),
        field('What the provider charges per visit', numberBox(p.oon, 'charge', { prefix: '$', placeholder: '0', aria: `${p.name} out-of-network charge` }))
      )
    )
  );

  const capPanel = onPlan.length
    ? onPlan
        .map((p) =>
          field(
            `${p.name} hit the cap in`,
            monthSelect(p.capMonth, (v) => {
              p.capMonth = v;
              changed(false);
            }, { blank: 'did not, or not sure', aria: `${p.name} cap month` })
          )
        )
        .concat([h('p', { class: 'hint block' }, 'After the cap, care is free and leaves no trace in the numbers. Knowing the month lets the tool project the rate before it forward.')])
    : [h('p', { class: 'hint block' }, 'Nothing to ask: nobody was on a plan this year.')];

  return section(
    n,
    'Four quick questions',
    'Each "yes" opens a few more boxes. Each "no" is taken at its word and listed under the chart.',
    gate(a, 'rx', 'Does anyone take regular prescriptions?', rxPanel),
    gate(a, 'oon', 'Does anyone see a provider who doesn\'t take your insurance?', oonPanel),
    gate(a, 'hsa', 'Is anyone on Medicare, or does your spouse have their own FSA?', hsaPanel(a)),
    gate(a, 'cap', 'Did anyone hit their out-of-pocket cap this year?', capPanel)
  );
}

function eventsSection(n, a, next) {
  const ev = a.events;
  const who = (e) => {
    if (!next.some((p) => p.id === e.person)) e.person = next.length ? next[0].id : null;
    return field('Who', personSelect(e.person, next, (v) => {
      e.person = v;
      changed(false);
    }));
  };
  const when = (e, key, label) =>
    field(label || 'Roughly when', monthSelect(e[key], (v) => {
      e[key] = v;
      changed(false);
    }));
  const cost = (e, key, label, fallback) => field(label, numberBox(e, key, { prefix: '$', placeholder: String(fallback), wide: true, aria: label }), 'The bill before insurance. The grey number is a typical figure, used if you leave this blank.');
  const defs = [
    ['birth', 'Pregnancy or birth', () => [who(ev.birth), when(ev.birth, 'month'), cost(ev.birth, 'allowed', 'Total charges', config.events.birth.allowed), h('p', { class: 'hint block' }, 'A new baby joins the plan too: add them under "Who is covered", ticked for next year only.')]],
    ['surgery', 'Planned surgery', () => [who(ev.surgery), when(ev.surgery, 'month'), cost(ev.surgery, 'allowed', 'Total charges', config.events.surgery.allowed)]],
    ['recurring', 'Recurring treatment', () => [who(ev.recurring), when(ev.recurring, 'startMonth', 'Starting'), field('For how many months', numberBox(ev.recurring, 'months', { placeholder: '12', max: 12, aria: 'months of treatment' })), cost(ev.recurring, 'allowedPerMonth', 'Charges per month', config.events.recurring.allowedPerMonth), h('p', { class: 'hint block' }, 'For treatment that is new next year. If it is already in this year\'s numbers, leave this off or it is counted twice.')]],
    ['dme', 'Medical equipment', () => [who(ev.dme), cost(ev.dme, 'allowed', 'Total charges', config.events.dme.allowed)]],
    ['turning65', 'Someone turning 65', () => [field('Who', personSelect(ev.turning65.person || (a.people[0] && a.people[0].id), a.people, (v) => {
      ev.turning65.person = v;
      changed(false);
    })), when(ev.turning65, 'month', 'Birthday month')]],
    ['leaving', 'Leaving mid-year', () => [when(ev.leaving, 'month', 'Last month on the plan')]],
  ];
  const chips = h(
    'div',
    { class: 'choice' },
    defs.map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip' + (ev[key].on ? ' on' : ''),
          'aria-pressed': ev[key].on ? 'true' : 'false',
          'data-focus': `ev:${key}`,
          onclick: () => {
            ev[key].on = !ev[key].on;
            changed(true);
          },
        },
        h('span', { class: 'chip-label' }, label)
      )
    )
  );
  const panels = defs.filter(([key]) => ev[key].on).map(([key, label, make]) => h('div', { class: 'panel', id: `ev-${key}` }, h('h3', null, label), h('div', { class: 'trio' }, make())));
  return section(n, 'Anything coming up next year', 'Tap any that apply. None is a fine answer.', chips, panels);
}

function importSection(n) {
  const t = S.table;
  const box = h('textarea', {
    id: 'import-box',
    rows: '7',
    spellcheck: 'false',
    placeholder: `${['person', 'month', 'category', 'allowed', 'network', 'group'].join(',')}\nSam,3,er_facility,1900,in,ER visit in March\nSam,3,er_physician,340,in,ER visit in March\nSam,1,office,110,in,weekly therapy\n...`,
    oninput: (e) => {
      S.importText = e.target.value;
      save();
    },
  });
  box.value = S.importText || '';
  const read = () => {
    const res = parseTable(S.importText);
    S.importErrors = res.errors;
    if (!res.errors.length) {
      t.items = res.items;
      t.groupsOff = [];
      t.oneoffGroups = {};
      ui.openGroups.clear();
      syncPeopleFromTable();
    }
    changed(true);
  };
  const file = h('input', {
    type: 'file',
    accept: '.csv,.json,.txt,text/csv,application/json,text/plain',
    class: 'file',
    'aria-label': 'Load a table from a file',
    onchange: (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        S.importText = String(reader.result || '');
        read();
      };
      reader.onerror = () => {
        S.importErrors = [`Could not read ${f.name}.`];
        changed(true);
      };
      reader.readAsText(f);
    },
  });
  const errors = S.importErrors && S.importErrors.length
    ? h('div', { class: 'problem', role: 'alert' }, h('b', null, 'Nothing was imported. '), 'The table has to read cleanly first:', h('ul', null, S.importErrors.slice(0, 12).map((e) => h('li', null, e))), S.importErrors.length > 12 ? h('p', null, `and ${S.importErrors.length - 12} more.`) : null)
    : null;
  const hasA = S.answers.people.some((p) => p.usage);
  return section(
    n,
    'Your line items',
    null,
    h(
      'div',
      { class: 'notice' },
      h('p', null, h('b', null, 'What this path means. '), 'You give a year of your family\'s medical documents to an AI agent, and it hands back a table. Which agent, and whose account, is your choice and your call. This page still sends nothing anywhere: the table is read here, in your browser.'),
      h('p', { class: 'muted' }, 'The EOB downloader and the agent prompt are not built yet. Until they are, any table in the format below works, including one you type.')
    ),
    box,
    h(
      'div',
      { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn primary', 'data-focus': 'read-table', onclick: read }, 'Read the table'),
      h('label', { class: 'btn' }, 'Load a file', file),
      hasA
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                const hh = build(config, S.answers);
                const nameOf = new Map(S.answers.people.map((p) => [p.id, p.name]));
                S.importText = toCsv(hh.allItems.map((it) => Object.assign({}, it, { month: Math.round(it.month), person: nameOf.get(it.person) || it.person })));
                read();
              },
            },
            'Start from my questionnaire answers'
          )
        : null,
      t.items.length
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                S.importText = toCsv(t.items.map((it) => Object.assign({}, it, { oneoff: Object.prototype.hasOwnProperty.call(t.oneoffGroups, it.group || '(no group)') ? t.oneoffGroups[it.group || '(no group)'] : it.oneoff })));
                changed(true);
                const el = document.getElementById('import-box');
                if (el) el.select();
              },
            },
            'Show the table as CSV'
          )
        : null
    ),
    errors,
    h(
      'details',
      { class: 'help' },
      h('summary', null, 'The format'),
      h('p', null, 'CSV with a header row, or JSON (a list of objects). One line per service. Columns:'),
      h(
        'ul',
        null,
        h('li', null, h('code', null, 'person'), ' a name, matching "Who is covered"'),
        h('li', null, h('code', null, 'month'), ' 1 to 12, or ', h('code', null, 'date'), ' as YYYY-MM-DD'),
        h('li', null, h('code', null, 'category'), ' one of: ', CATEGORIES.join(', ')),
        h('li', null, h('code', null, 'allowed'), ' the plan\'s allowed amount for the line (plan paid plus what you owed)'),
        h('li', null, h('code', null, 'network'), ' in or out (blank means in)'),
        h('li', null, h('code', null, 'count'), ' optional: visits or fills the line stands for. Use 0 for an extra line on a visit already counted, such as a lab drawn at an office visit'),
        h('li', null, h('code', null, 'billed'), ' optional, out-of-network only: what the provider charged'),
        h('li', null, h('code', null, 'group'), ' optional label, such as "ER visit in March" or "weekly therapy"'),
        h('li', null, h('code', null, 'oneoff'), ' optional yes/no: one-offs are left out of the quiet year')
      ),
      h('p', { class: 'muted' }, `Accepted columns: ${COLUMNS.join(', ')}. Anything else is reported, not ignored.`)
    ),
    t.items.length
      ? h(
          'div',
          { class: 'table-host' },
          h('p', { class: 'intro' }, 'Switch a group off to see the year without it. Tick "one-off" for things that would not happen in a quiet year.'),
          itemsTable({
            items: t.items,
            editable: true,
            groupsOff: t.groupsOff,
            oneoffGroups: t.oneoffGroups,
            open: ui.openGroups,
            onChange: (structural) => {
              if (structural) syncPeopleFromTable();
              changed(structural);
            },
          })
        )
      : null
  );
}

// Every name in the table needs a person; new names arrive without a role and are asked about.
function syncPeopleFromTable() {
  const a = S.answers;
  const have = new Set(a.people.map((p) => p.name.trim().toLowerCase()));
  const names = [];
  for (const it of S.table.items) {
    const k = String(it.person).trim().toLowerCase();
    if (!have.has(k)) {
      have.add(k);
      names.push(String(it.person).trim());
    }
  }
  if (!names.length) return;
  // The untouched starter person makes way for real names.
  if (a.people.length === 1 && a.people[0].name === 'You' && !tableHas('You')) a.people = [];
  for (const name of names) {
    const p = newPerson('p' + Date.now().toString(36) + ui.uid++, null, name);
    p.name = name;
    a.people.push(p);
  }
}

function prioritySection(n, a) {
  const biggest = Math.max(...config.plans.map((p) => p.in.ded[0]));
  return section(
    n,
    'What matters most',
    'This changes what the chart draws attention to. It never changes the numbers.',
    choice(
      [
        { value: 'normal', label: 'Lowest cost in a normal year' },
        { value: 'protect', label: 'Protected if something big happens' },
        { value: 'paycheck', label: 'Smallest paycheck deduction' },
      ],
      a.priority,
      (v) => {
        a.priority = a.priority === v ? null : v;
        changed(true);
      },
      { id: 'q-priority', aria: 'What matters most', stack: true }
    ),
    h(
      'div',
      { class: 'gate' },
      h('div', { class: 'gate-q' }, h('span', null, `Could you absorb a ${dollars(biggest)} bill in February?`), yesNo(a.canAbsorb, (v) => {
        a.canAbsorb = a.canAbsorb === v ? null : v;
        changed(true);
      }, 'q-absorb'))
    )
  );
}

function advancedSection(a, current, onPlan, next) {
  const adv = a.adv;
  const hasFsa = config.plans.some((p) => p.account === 'fsa');
  const hasHsa = config.plans.some((p) => p.account === 'hsa');
  const spouse = next.some((p) => p.role === 'spouse');
  const t = config.typicalAllowed;
  const hsaMax = config.hsa ? (next.length > 1 ? config.hsa.family : config.hsa.single) : 0;
  const body = [
    h(
      'div',
      { class: 'adv-group', id: 'adv-tax' },
      h('h3', null, 'Tax and accounts'),
      h(
        'div',
        { class: 'trio' },
        field('Combined tax rate on your last dollar', numberBox(adv, 'taxRate', { suffix: '%', placeholder: '30', max: 60, aria: 'tax rate' }), 'Federal bracket + 7.65% payroll tax + state. Roughly 25 to 40 for most people.'),
        hasFsa ? field(`FSA election (${config.plans.filter((p) => p.account === 'fsa').map((p) => p.short).join(', ')})`, numberBox(adv, 'fsa', { prefix: '$', placeholder: '0', max: config.fsa.limit, aria: 'FSA election' }), `Up to ${dollars(config.fsa.limit)} a year. Unspent money over ${dollars(config.fsa.carryover)} is lost.`) : null,
        hasHsa ? field(`HSA contribution (${config.plans.filter((p) => p.account === 'hsa').map((p) => p.short).join(', ')})`, numberBox(adv, 'hsa', { prefix: '$', placeholder: '0', max: hsaMax, aria: 'HSA contribution' }), `Up to ${dollars(hsaMax)} a year for your tier. The money stays yours.`) : null
      )
    ),
    h(
      'div',
      { class: 'adv-group', id: 'adv-premium' },
      h('h3', null, 'Premium'),
      config.credits ? check(adv, 'creditSelf', `I get the credit: ${config.credits.labels[1]}`, { structural: false }) : null,
      config.credits && spouse ? check(adv, 'creditSpouse', `My spouse does too: ${config.credits.labels[2]}`, { structural: false }) : null,
      config.spousalSurcharge && spouse ? check(adv, 'surcharge', `Spousal surcharge of ${dollars(config.spousalSurcharge.monthly)} a month applies. ${config.spousalSurcharge.text || ''}`, { structural: false }) : null
    ),
  ];
  if (S.mode === 'A' && current && onPlan.length) {
    body.push(
      h(
        'div',
        { class: 'adv-group', id: 'adv-shape' },
        h('h3', null, 'The shape of this year'),
        h('p', { class: 'hint block' }, 'Numbers are scaled up to twelve months as if care was spread evenly. Say so here if it was not.'),
        onPlan.map((p) =>
          h(
            'div',
            { class: 'person-block' },
            h('h4', null, p.name),
            h(
              'div',
              { class: 'trio' },
              field(
                'Regular care',
                h(
                  'select',
                  {
                    'aria-label': `${p.name} shape of the year`,
                    onchange: (e) => {
                      p.shape = e.target.value;
                      if (p.shape !== 'steady' && !p.shapeMonth) p.shapeMonth = 6;
                      changed(true);
                    },
                  },
                  h('option', { value: 'steady', selected: p.shape === 'steady' }, 'ran all year'),
                  h('option', { value: 'started', selected: p.shape === 'started' }, 'started partway, still going'),
                  h('option', { value: 'stopped', selected: p.shape === 'stopped' }, 'has stopped')
                )
              ),
              p.shape === 'started'
                ? field('Started in', monthSelect(p.shapeMonth, (v) => {
                    p.shapeMonth = v;
                    changed(false);
                  }))
                : null,
              field('A one-off this year, total charges', numberBox(p, 'oneOff', { prefix: '$', placeholder: '0', wide: true, aria: `${p.name} one-off` }), 'A surgery, a hospital stay: the bill before insurance. Carried over once, and left out of the quiet year.')
            )
          )
        )
      )
    );
  }
  if (S.mode === 'A') {
    body.push(
      h(
        'div',
        { class: 'adv-group', id: 'adv-typical' },
        h('h3', null, 'Full prices'),
        h('p', { class: 'hint block' }, 'What a visit costs before any insurance pays, used for plans that send visits to the deductible. Rough local figures; an old EOB shows yours as the "allowed amount".'),
        h(
          'div',
          { class: 'trio' },
          field('Office visit', numberBox(adv.typical, 'office', { prefix: '$', placeholder: String(t.office), aria: 'office visit price' })),
          field('Therapy session', numberBox(adv.typical, 'therapy', { prefix: '$', placeholder: String(t.therapy), aria: 'therapy price' })),
          field('Urgent care', numberBox(adv.typical, 'urgent', { prefix: '$', placeholder: String(t.urgent), aria: 'urgent care price' })),
          field('ER, the facility', numberBox(adv.typical, 'er_facility', { prefix: '$', placeholder: String(t.er_facility), aria: 'ER facility price' })),
          field('ER, the physician', numberBox(adv.typical, 'er_physician', { prefix: '$', placeholder: String(t.er_physician), aria: 'ER physician price' }))
        )
      ),
      h(
        'div',
        { class: 'adv-group', id: 'adv-oon' },
        h('h3', null, 'Out-of-network'),
        field('Share of an out-of-network charge the plan recognises', numberBox(adv, 'oonShare', { suffix: '%', placeholder: String(Math.round(config.oonAllowedShare * 100)), max: 100, aria: 'out-of-network share' }), 'The rest is yours and counts toward nothing.')
      )
    );
  }
  const details = h('details', { class: 'card advanced', id: 'advanced', open: ui.advOpen }, h('summary', null, h('h2', null, 'Advanced'), h('span', { class: 'muted' }, 'tax, accounts, premium credits, prices. All have defaults, listed under the chart.')), body);
  details.addEventListener('toggle', () => {
    ui.advOpen = details.open;
  });
  return details;
}

// ---- results --------------------------------------------------------------------------------
function safeFacts() {
  try {
    return S.mode === 'B' ? buildFromTable(config, S.answers, S.table) : build(config, S.answers);
  } catch (e) {
    return null;
  }
}

function compute() {
  let hh;
  try {
    hh = S.mode === 'B' ? buildFromTable(config, S.answers, S.table) : build(config, S.answers);
  } catch (e) {
    return { hh: null, problems: [{ blocking: true, text: `Something in the inputs could not be read: ${e.message}` }] };
  }
  const problems = hh.problems.slice();
  for (const p of S.answers.people) {
    if (p.role == null) problems.push({ blocking: true, anchor: 'q-people', text: `Say who ${p.name} is: the employee, a spouse or partner, or a child.` });
  }
  if (!S.answers.people.some((p) => p.nextYear)) problems.push({ blocking: true, anchor: 'q-people', text: 'Nobody is ticked as covered next year.' });
  if (problems.some((p) => p.blocking)) return { hh, problems };
  try {
    const view = S.answers.view === 'raw' ? 'raw' : 'takehome';
    return { hh, problems, out: evaluate(config, hh, { view }), be: breakEven(config, hh, { view }) };
  } catch (e) {
    return { hh, problems: [{ blocking: true, text: `The table could not be replayed: ${e.message}` }] };
  }
}

// A link that scrolls to an input and flashes it.
function jumpLink(text, anchor) {
  return h('a', { href: '#' + anchor, onclick: (e) => { e.preventDefault(); jump(anchor); } }, text);
}

function trustButtons(person) {
  return h(
    'div',
    { class: 'row-actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => { person.trust = 'dollars'; changed(true); } }, 'Trust the dollars', h('span', { class: 'chip-sub' }, 'fewer visits than I listed')),
    h('button', { type: 'button', class: 'btn', onclick: () => { person.trust = 'counts'; changed(true); } }, 'Trust the counts', h('span', { class: 'chip-sub' }, 'the dollar figure is behind'))
  );
}

function jump(anchor) {
  const el = anchor && document.getElementById(anchor);
  if (!el) return;
  const adv = el.closest('details');
  if (adv && !adv.open) adv.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  const first = el.matches('input,select,button') ? el : el.querySelector('input,select,button');
  if (first) first.focus({ preventScroll: true });
}

function renderWorking(res) {
  for (const el of formEl.querySelectorAll('.working')) clear(el);
  for (const el of formEl.querySelectorAll('.settle')) clear(el);
  if (!res.hh) return;
  for (const w of res.hh.working) {
    const el = document.getElementById(`work-${w.person}`);
    if (!el) continue;
    const bits = [`${dollars(w.dedMet)} deductible`];
    if (w.copays > 0.5) bits.push(`${dollars(w.copays)} copays`);
    if (w.knownCoins > 0.5) bits.push(`${dollars(w.knownCoins)} ER coinsurance`);
    if (w.coinsurance > 0.5) bits.push(`${dollars(w.coinsurance)} coinsurance at ${Math.round(w.share * 100)}%`);
    let text = `Read as ${bits.join(' + ')}. That is about ${dollars(w.charges)} of care billed through the deductible so far`;
    if (w.recurring > 0.5 || w.oneOff > 0.5) text += `, or ${dollars(w.recurring)} a year` + (w.oneOff > 0.5 ? ` plus a ${dollars(w.oneOff)} one-off` : '');
    text += w.censored ? (w.capMonth ? '. At the cap: projected from the months before it.' : '. At the cap, so this is a lower bound.') : '.';
    el.textContent = text;
  }
  // Inconsistent inputs: ask which to trust, right where the numbers are.
  for (const p of res.problems) {
    if (p.code !== 'copays-exceed' || !p.person) continue;
    const el = document.getElementById(`settle-${p.person}`);
    const person = S.answers.people.find((q) => q.id === p.person);
    if (!el || !person) continue;
    el.appendChild(
      h(
        'div',
        { class: 'problem', role: 'alert' },
        h('p', null, p.text),
        trustButtons(person)
      )
    );
  }
  for (const person of S.answers.people) {
    if (!person.trust || person.usage !== 'counts') continue;
    const el = document.getElementById(`settle-${person.id}`);
    if (el && !el.firstChild) {
      el.appendChild(
        h('p', { class: 'hint block' }, person.trust === 'dollars' ? 'Trusting the dollars over the visit counts. ' : 'Trusting the visit counts over the dollars. ', h('button', { type: 'button', class: 'link', onclick: () => { person.trust = null; changed(true); } }, 'ask me again'))
      );
    }
  }
}

function renderResults() {
  hideTip();
  const res = compute();
  renderWorking(res);
  clear(resultsEl);
  const a = S.answers;
  const view = a.view === 'raw' ? 'raw' : 'takehome';

  const head = h(
    'div',
    { class: 'results-head' },
    h('h2', null, 'Your year on each plan'),
    h(
      'div',
      { class: 'toggle', role: 'group', 'aria-label': 'Money view' },
      [
        ['takehome', 'Take-home pay'],
        ['raw', 'Raw dollars'],
      ].map(([v, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: view === v ? 'on' : '',
            'aria-pressed': view === v ? 'true' : 'false',
            'data-focus': `view:${v}`,
            onclick: () => {
              a.view = v;
              save();
              renderResults();
              const again = resultsEl.querySelector(`[data-focus="view:${v}"]`);
              if (again) again.focus();
            },
          },
          label
        )
      )
    )
  );
  resultsEl.appendChild(head);

  if (!res.out) {
    const blocking = res.problems.filter((p) => p.blocking);
    resultsEl.appendChild(
      h(
        'div',
        { class: 'waiting' },
        h('p', { class: 'waiting-lead' }, blocking.some((p) => p.code === 'copays-exceed' || /over|under/.test(p.code || '')) ? 'Something does not add up yet.' : 'A few more answers and the chart appears.'),
        h(
          'ul',
          null,
          blocking.map((p) => {
            const person = p.code === 'copays-exceed' && S.answers.people.find((q) => q.id === p.person);
            return h('li', null, p.anchor ? jumpLink(p.text, person ? `q-usage-${person.id}` : p.anchor) : p.text, person ? trustButtons(person) : null);
          })
        ),
        h('div', { class: 'ghost', 'aria-hidden': 'true' }, config.plans.map((p, i) => h('div', { class: 'ghost-col' }, h('i', { style: { height: 46 + i * 9 + '%' } }), h('i', { style: { height: 38 - i * 11 + '%' } }), h('span', null, p.name))))
      )
    );
    footer(res);
    return;
  }

  const out = res.out;
  const hh = res.hh;
  const t = Math.round(hh.taxRate * 100);
  resultsEl.appendChild(
    h(
      'p',
      { class: 'view-note' },
      view === 'takehome'
        ? `In take-home pay: premiums come out before tax, so at a ${t}% rate each premium dollar costs you ${100 - t} cents. Care is paid from taxed money unless it goes through an FSA or HSA.`
        : 'In raw dollars: premiums plus what you pay for care, ignoring tax.'
    )
  );

  // Which year the solid bars show. The dashed outline always runs on to the worst case.
  const year = ['quiet', 'expected', 'bad'].includes(ui.scenario) ? ui.scenario : 'expected';
  const yearNote = {
    quiet: 'Recurring care only: this year\'s one-offs do not repeat.',
    expected: 'The year your answers describe.',
    bad: `The expected year, plus ${(config.seriousEvent && config.seriousEvent.label) || 'one serious event'}.`,
  }[year];
  resultsEl.appendChild(
    h(
      'div',
      { class: 'year-switch' },
      h(
        'div',
        { class: 'toggle', role: 'group', 'aria-label': 'Which year the bars show' },
        [
          ['quiet', 'Quiet year'],
          ['expected', 'Expected'],
          ['bad', 'Bad year'],
        ].map(([v, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: year === v ? 'on' : '',
              'aria-pressed': year === v ? 'true' : 'false',
              'data-focus': `year:${v}`,
              onclick: () => {
                ui.scenario = v;
                renderResults();
                const again = resultsEl.querySelector(`[data-focus="year:${v}"]`);
                if (again) again.focus();
              },
            },
            label
          )
        )
      ),
      h('span', { class: 'view-note' }, yearNote)
    )
  );
  resultsEl.appendChild(
    stackedBars(out, {
      priority: a.priority,
      canAbsorb: a.canAbsorb,
      view,
      viewLabel: view === 'takehome' ? 'in take-home pay' : 'in raw dollars',
      scenario: year,
      seriousLabel: config.seriousEvent && config.seriousEvent.label,
    })
  );

  // The trade in words.
  if (out.trades.length) {
    const nameOf = (id) => out.plans.find((p) => p.id === id).short;
    const list = h('ul', { class: 'trades' });
    for (const tr of out.trades) {
      const A = nameOf(tr.more);
      const B = nameOf(tr.less);
      let s;
      if (tr.perPaycheck < 0.5) s = `${A} and ${B} cost the same per paycheck`;
      else s = `${A} costs ${dollars(tr.perPaycheck)} more per paycheck than ${B}`;
      if (tr.worstCase > 0.5) s += ` and lowers your worst case by ${dollars(tr.worstCase)}.`;
      else if (tr.worstCase < -0.5) s += `, and its worst case is ${dollars(-tr.worstCase)} higher.`;
      else s += ', with the same worst case.';
      let e;
      if (tr.expectedOverlap && Math.abs(tr.expected) < 120) e = ' In the year you described they come out about the same.';
      else if (tr.expected > 0) e = ` In the year you described, ${A} comes out ${dollars(tr.expected)} ahead${tr.expectedOverlap ? ', give or take the unknowns' : ''}.`;
      else e = ` In the year you described, ${B} comes out ${dollars(-tr.expected)} ahead${tr.expectedOverlap ? ', give or take the unknowns' : ''}.`;
      list.appendChild(h('li', null, s + e));
    }
    resultsEl.appendChild(h('div', { class: 'block' }, h('h3', null, 'The trade'), list));
  } else {
    const standing = out.plans.filter((p) => !p.neverCheapest);
    if (standing.length === 1 && out.plans.length > 1) {
      resultsEl.appendChild(
        h('div', { class: 'block' }, h('h3', null, 'The trade'), h('p', null, `For your answers there is no trade to weigh over a year: ${standing[0].name} costs least in the quiet year, the expected year, the bad year and the worst case. The others only win on the size of the paycheck deduction.`))
      );
    }
  }

  // The "assuming..." line.
  if (hh.assumptions.length) {
    const line = h('p', { class: 'assuming' }, h('b', null, 'Assuming '));
    hh.assumptions.forEach((as, i) => {
      if (i) line.appendChild(document.createTextNode(i === hh.assumptions.length - 1 ? ', and ' : ', '));
      line.appendChild(as.anchor ? jumpLink(as.text, as.anchor) : h('span', null, as.text));
    });
    line.appendChild(document.createTextNode('. Tap any of these to change it.'));
    resultsEl.appendChild(line);
  }
  if (hh.notes.length) resultsEl.appendChild(h('ul', { class: 'notes' }, hh.notes.map((nt) => h('li', null, nt.text))));

  // The numbers as a table.
  const table = h(
    'table',
    { class: 'numbers' },
    h('thead', null, h('tr', null, h('th', null, ''), SCENARIOS.map((s) => h('th', null, SCENARIO_LABELS[s].replace(': premiums only', ''))), h('th', null, 'Per paycheck'))),
    h(
      'tbody',
      null,
      out.plans.map((p) => h('tr', null, h('th', { scope: 'row' }, p.name), SCENARIOS.map((s) => h('td', null, dollarsRange(p.scenarios[s]))), h('td', null, dollars(p.paycheck.total))))
    )
  );
  resultsEl.appendChild(h('details', { class: 'block' }, h('summary', null, 'The numbers as a table'), h('div', { class: 'rows-wrap' }, table)));

  // Break-even.
  const beHost = h('div', null);
  resultsEl.appendChild(
    h(
      'details',
      { class: 'block', open: true },
      h('summary', null, 'How wrong would the estimate have to be?'),
      h('p', { class: 'intro' }, breakEvenSentence(res.be, out)),
      beHost
    )
  );
  beHost.appendChild(breakEvenChart(res.be, out, { width: Math.min(720, resultsEl.clientWidth - 8), priority: a.priority }));

  // The line items behind the questionnaire.
  if (S.mode === 'A') {
    const nameOf = new Map(a.people.map((p) => [p.id, p.name]));
    if (!a.groupsOff) a.groupsOff = [];
    const itemsHost = h('details', { class: 'block', open: ui.itemsOpen }, h('summary', null, `The line items behind this (${hh.allItems.length})`));
    itemsHost.addEventListener('toggle', () => {
      ui.itemsOpen = itemsHost.open;
    });
    itemsHost.appendChild(h('p', { class: 'intro' }, 'This is the coming year as the tool understands your answers. Switch a group off to see the year without it.'));
    itemsHost.appendChild(
      itemsTable({
        items: hh.allItems,
        editable: false,
        groupsOff: a.groupsOff,
        oneoffGroups: {},
        open: ui.openGroups,
        personName: (id) => nameOf.get(id) || id,
        onChange: () => {
          save();
          renderResults();
        },
      })
    );
    resultsEl.appendChild(itemsHost);
  }
  footer(res);
}

// What was entered, for the printed page (the form itself is not printed).
function answersSummary() {
  const a = S.answers;
  const rows = [];
  const current = a.currentPlan ? getPlan(config, a.currentPlan) : null;
  if (S.mode === 'B') rows.push(`From a table of ${S.table.items.length} line items.`);
  else rows.push(current ? `On ${current.name} this year; numbers as of ${a.asOf}.` : 'No plan this year.');
  for (const p of a.people) {
    const bits = [p.role === 'self' ? 'employee' : p.role || 'role not set'];
    if (!p.nextYear) bits.push('not covered next year');
    if (S.mode === 'A') {
      if (current && p.thisYear && p.dedMet != null && p.oopMet != null) bits.push(`deductible met ${dollars(p.dedMet)}, out-of-pocket met ${dollars(p.oopMet)}`);
      if (p.usage === 'counts') bits.push(describeCounts({ office: p.counts.office || 0, therapy: p.counts.therapy || 0, urgent: p.counts.urgent || 0, er: p.counts.er || 0 }) + (current && p.thisYear ? ' so far this year' : ' a year'));
      else if (PRESETS[p.usage]) bits.push(PRESETS[p.usage].label.toLowerCase());
    }
    rows.push(`${p.name}: ${bits.join('; ')}.`);
  }
  return h('div', { class: 'print-only block' }, h('h3', null, 'What was entered'), h('ul', { class: 'notes' }, rows.map((r) => h('li', null, r))), h('p', { class: 'footnote' }, `Printed ${todayIso()}.`));
}

function footer() {
  resultsEl.appendChild(answersSummary());
  const notes = (config.footnotes || []).map((f) => h('p', { class: 'footnote' }, '* ', f));
  resultsEl.appendChild(
    h(
      'div',
      { class: 'foot' },
      notes,
      h('p', { class: 'footnote' }, (config.hints && config.hints.disclaimer) || 'Estimates only. The plan documents govern.'),
      h(
        'div',
        { class: 'row-actions no-print' },
        h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, 'Print or save as PDF'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => {
              if (!window.confirm('Clear every answer on this page?')) return;
              try {
                sessionStorage.removeItem(storeKey());
              } catch (e) {
                /* nothing stored */
              }
              S = fresh();
              ui.openGroups.clear();
              renderForm();
              renderResults();
              window.scrollTo(0, 0);
            },
          },
          'Start over'
        )
      )
    )
  );
}

// ---- boot -----------------------------------------------------------------------------------
function start(rawConfig) {
  config = validateConfig(rawConfig);
  S = load() || fresh();
  const app = clear(document.getElementById('app'));
  document.title = `umr-wtf: ${config.planYear} plan chooser`;
  app.appendChild(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('h1', null, 'umr-wtf'), h('p', { class: 'tagline' }, 'Which medical plan? Your numbers, the trade-offs, no verdict.')),
      h(
        'div',
        { class: 'badges' },
        h(
          'details',
          { class: 'badge' },
          h('summary', null, 'Nothing leaves this page'),
          h('p', null, 'This is one file. It makes no network requests, and your browser is told to block any it might try. Turn off wifi and it works the same. Answers live in this tab only and are gone when you close it.')
        ),
        h('details', { class: 'badge' }, h('summary', null, 'Unofficial'), h('p', null, (config.hints && config.hints.disclaimer) || 'Estimates only. The plan documents govern.'))
      )
    )
  );
  app.appendChild(
    h('p', { class: 'lede' }, `For ${config.audience || 'people'} choosing between ${config.plans.map((p) => p.name).join(', ').replace(/, ([^,]*)$/, ' and $1')} for ${config.planYear}. Everyone wants to pay as little as possible for as much protection as possible; people differ in where they sit on that trade. So this shows you your trade, and says which plans are never worth picking for your answers.`)
  );
  formEl = h('form', { class: 'form', onsubmit: (e) => e.preventDefault(), novalidate: true });
  resultsEl = h('div', { class: 'results', 'aria-live': 'polite' });
  app.appendChild(h('main', { class: 'layout' }, formEl, h('aside', { class: 'results-col', id: 'results' }, resultsEl)));
  app.appendChild(h('a', { class: 'to-results', href: '#results', onclick: (e) => { e.preventDefault(); document.getElementById('results').scrollIntoView({ behavior: 'smooth' }); } }, 'See the chart'));
  app.appendChild(h('footer', { class: 'page-foot' }, `${config.planYear} plan year. ${config.source || ''} Built ${window.__BUILD__ || ''}.`));
  renderForm();
  renderResults();
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(renderResults, 160);
  });
}

if (typeof document !== 'undefined') {
  const node = document.getElementById('plan-config');
  try {
    start(JSON.parse(node.textContent));
  } catch (e) {
    const app = document.getElementById('app');
    app.textContent = `This page could not start: ${e.message}`;
    throw e;
  }
}

module.exports = { start };
