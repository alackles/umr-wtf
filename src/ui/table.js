'use strict';
// The line-item table, grouped by label, with a switch per group. Used two ways:
// editable for an imported table (Path B), and read-only to show the working behind the
// questionnaire (Path A). Turning a group off removes it from every scenario.

const { h, dollars, parseNumber } = require('./dom.js');
const { CATEGORIES, CATEGORY_LABELS } = require('../plans.js');
const { MONTHS } = require('../household.js');

const UNGROUPED = '(no group)';

// opts: {
//   items        array of line items (mutated in place when editable)
//   editable     boolean
//   groupsOff    array of labels switched off (mutated)
//   oneoffGroups object label -> boolean (mutated; editable only)
//   open         Set of labels currently expanded (mutated)
//   personName   (id) => display name
//   onChange     (structural) => void
// }
function itemsTable(opts) {
  const { items, editable } = opts;
  const groups = new Map();
  items.forEach((it, i) => {
    const g = it.group || UNGROUPED;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  const root = h('div', { class: 'items' });
  if (!items.length) {
    root.appendChild(h('p', { class: 'muted' }, 'No line items yet.'));
    return root;
  }
  const name = opts.personName || ((id) => id);

  for (const [label, idxs] of groups) {
    const off = opts.groupsOff.includes(label);
    const total = idxs.reduce((s, i) => s + (Number(items[i].allowed) || 0), 0);
    const flagged = editable && Object.prototype.hasOwnProperty.call(opts.oneoffGroups, label) ? !!opts.oneoffGroups[label] : idxs.every((i) => items[i].oneoff);
    const planned = idxs.every((i) => items[i].planned);
    const isOpen = opts.open.has(label);

    const toggle = h('input', {
      type: 'checkbox',
      class: 'switch',
      checked: !off,
      'aria-label': `Include ${label}`,
      onchange: (e) => {
        const at = opts.groupsOff.indexOf(label);
        if (e.target.checked && at >= 0) opts.groupsOff.splice(at, 1);
        if (!e.target.checked && at < 0) opts.groupsOff.push(label);
        opts.onChange(true);
      },
    });
    const title = editable
      ? h('input', {
          class: 'grp-name',
          type: 'text',
          value: label === UNGROUPED ? '' : label,
          placeholder: 'group label',
          'aria-label': 'Group label',
          onchange: (e) => {
            const next = e.target.value.trim();
            for (const i of idxs) {
              if (next) items[i].group = next;
              else delete items[i].group;
            }
            opts.onChange(true);
          },
        })
      : h('span', { class: 'grp-name' }, label);
    const oneoff = editable
      ? h(
          'label',
          { class: 'tag-check', title: 'One-offs are left out of the quiet year' },
          h('input', {
            type: 'checkbox',
            checked: flagged,
            onchange: (e) => {
              opts.oneoffGroups[label] = e.target.checked;
              opts.onChange(false);
            },
          }),
          ' one-off'
        )
      : flagged
        ? h('span', { class: 'tag' }, 'one-off')
        : planned
          ? h('span', { class: 'tag' }, 'planned')
          : null;
    const head = h(
      'div',
      { class: 'grp-head' + (off ? ' off' : '') },
      toggle,
      title,
      h('span', { class: 'grp-meta' }, `${idxs.length} ${idxs.length === 1 ? 'line' : 'lines'}, ${dollars(total)} billed`),
      oneoff,
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          'aria-expanded': isOpen ? 'true' : 'false',
          onclick: () => {
            if (isOpen) opts.open.delete(label);
            else opts.open.add(label);
            opts.onChange(true);
          },
        },
        isOpen ? 'hide lines' : 'show lines'
      )
    );
    const box = h('div', { class: 'grp' }, head);
    if (isOpen) box.appendChild(rowsTable(opts, idxs, name));
    root.appendChild(box);
  }
  return root;
}

function rowsTable(opts, idxs, name) {
  const { items, editable } = opts;
  const anyOut = idxs.some((i) => items[i].network === 'out');
  const head = ['Person', 'Month', 'Kind of care', 'Allowed', 'Network', 'Count'];
  if (anyOut || editable) head.push('Billed');
  if (editable) head.push('');
  const table = h('table', { class: 'rows' }, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))));
  const body = h('tbody', null);
  for (const i of idxs) {
    const it = items[i];
    if (!editable) {
      const cells = [
        name(it.person),
        MONTHS[(it.month || 1) - 1],
        CATEGORY_LABELS[it.category] || it.category,
        dollars(it.allowed),
        it.network === 'out' ? 'out' : 'in',
        it.count == null ? '1' : String(Math.round(it.count * 100) / 100),
      ];
      if (anyOut) cells.push(it.billed != null ? dollars(it.billed) : '');
      body.appendChild(h('tr', null, cells.map((c, ci) => h('td', { class: ci === 3 || ci === 5 || ci === 6 ? 'num' : null }, c))));
      continue;
    }
    const set = (key, parse) => (e) => {
      const v = parse(e.target.value);
      if (v == null || (typeof v === 'number' && isNaN(v))) {
        e.target.classList.add('bad');
        return;
      }
      e.target.classList.remove('bad');
      it[key] = v;
      if (key === 'month') delete it.date;
      opts.onChange(false);
    };
    const numCell = (key, optional) =>
      h('input', {
        type: 'text',
        inputmode: 'decimal',
        class: 'num',
        value: it[key] == null ? '' : String(Math.round(it[key] * 100) / 100),
        'aria-label': key,
        onchange: (e) => {
          const v = parseNumber(e.target.value);
          if (v == null && optional) {
            delete it[key];
            e.target.classList.remove('bad');
            opts.onChange(false);
            return;
          }
          if (v == null || isNaN(v) || v < 0) {
            e.target.classList.add('bad');
            return;
          }
          e.target.classList.remove('bad');
          it[key] = v;
          opts.onChange(false);
        },
      });
    body.appendChild(
      h(
        'tr',
        null,
        h('td', null, h('input', { type: 'text', value: it.person, 'aria-label': 'person', onchange: set('person', (v) => v.trim() || null) })),
        h(
          'td',
          null,
          h(
            'select',
            { 'aria-label': 'month', onchange: set('month', (v) => Number(v)) },
            MONTHS.map((mName, mi) => h('option', { value: mi + 1, selected: (it.month || 1) === mi + 1 }, mName.slice(0, 3)))
          )
        ),
        h(
          'td',
          null,
          h(
            'select',
            { 'aria-label': 'kind of care', onchange: set('category', (v) => v) },
            CATEGORIES.map((c) => h('option', { value: c, selected: it.category === c }, CATEGORY_LABELS[c]))
          )
        ),
        h('td', null, numCell('allowed')),
        h(
          'td',
          null,
          h(
            'select',
            { 'aria-label': 'network', onchange: set('network', (v) => v) },
            h('option', { value: 'in', selected: it.network !== 'out' }, 'in'),
            h('option', { value: 'out', selected: it.network === 'out' }, 'out')
          )
        ),
        h('td', null, numCell('count', true)),
        h('td', null, numCell('billed', true)),
        h(
          'td',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'link',
              'aria-label': 'Delete line',
              onclick: () => {
                items.splice(i, 1);
                opts.onChange(true);
              },
            },
            'delete'
          )
        )
      )
    );
  }
  table.appendChild(body);
  const wrap = h('div', { class: 'rows-wrap' }, table);
  if (editable) {
    wrap.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: () => {
            const last = items[idxs[idxs.length - 1]];
            items.push({ person: last.person, month: last.month || 1, category: last.category, allowed: 0, network: last.network || 'in', group: last.group });
            opts.onChange(true);
          },
        },
        '+ add a line to this group'
      )
    );
  }
  return wrap;
}

module.exports = { itemsTable, UNGROUPED };
