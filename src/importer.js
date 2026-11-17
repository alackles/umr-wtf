'use strict';
// Path B import: a table of line items as CSV or JSON, in the engine's own schema.
// Anything unreadable is reported with its row; nothing is guessed, and nothing is imported
// unless every row reads cleanly.

const { CATEGORIES } = require('./plans.js');

const COLUMNS = ['person', 'date', 'month', 'category', 'allowed', 'network', 'count', 'billed', 'group'];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
      any = true;
    } else if (ch === ',' || ch === '\t') {
      row.push(cell);
      cell = '';
      any = true;
    } else if (ch === '\n') {
      row.push(cell);
      if (any || cell.trim() !== '') rows.push(row);
      row = [];
      cell = '';
      any = false;
    } else if (ch !== '\r') {
      cell += ch;
      if (ch.trim() !== '') any = true;
    }
  }
  if (any || cell.trim() !== '') {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function money(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

// One raw record (object with string or native values) -> a clean item, or errors.
function readRecord(rec, where, errors) {
  const item = {};
  const person = String(rec.person == null ? '' : rec.person).trim();
  if (!person) errors.push(`${where}: person is missing`);
  item.person = person;

  const date = String(rec.date == null ? '' : rec.date).trim();
  const month = rec.month == null || String(rec.month).trim() === '' ? null : Number(rec.month);
  if (date) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date) || null;
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(date);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) {
      item.date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      item.month = Number(m[2]);
    } else if (us && Number(us[1]) >= 1 && Number(us[1]) <= 12 && Number(us[2]) >= 1 && Number(us[2]) <= 31) {
      const y = us[3].length === 2 ? '20' + us[3] : us[3];
      item.date = `${y}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      item.month = Number(us[1]);
    } else errors.push(`${where}: date "${date}" is not YYYY-MM-DD or MM/DD/YYYY`);
  } else if (month != null) {
    if (Number.isInteger(month) && month >= 1 && month <= 12) item.month = month;
    else errors.push(`${where}: month "${rec.month}" is not a whole number from 1 to 12`);
  } else errors.push(`${where}: needs a date or a month`);

  const category = String(rec.category == null ? '' : rec.category).trim().toLowerCase();
  if (!CATEGORIES.includes(category)) errors.push(`${where}: category "${rec.category == null ? '' : rec.category}" is not one of ${CATEGORIES.join(', ')}`);
  item.category = category;

  const allowed = money(rec.allowed);
  if (allowed == null || isNaN(allowed) || allowed < 0) errors.push(`${where}: allowed "${rec.allowed == null ? '' : rec.allowed}" is not an amount of zero or more`);
  item.allowed = allowed;

  const network = String(rec.network == null ? '' : rec.network).trim().toLowerCase();
  if (network === '' || network === 'in' || network === 'in-network') item.network = 'in';
  else if (network === 'out' || network === 'out-of-network' || network === 'oon') item.network = 'out';
  else errors.push(`${where}: network "${rec.network}" is not "in" or "out"`);

  if (rec.count != null && String(rec.count).trim() !== '') {
    const count = Number(rec.count);
    if (!(count >= 0)) errors.push(`${where}: count "${rec.count}" is not a number of zero or more`);
    else if (count !== 1) item.count = count;
  }
  if (rec.billed != null && String(rec.billed).trim() !== '') {
    const billed = money(rec.billed);
    if (isNaN(billed) || billed < 0) errors.push(`${where}: billed "${rec.billed}" is not an amount`);
    else item.billed = billed;
  }
  const group = String(rec.group == null ? '' : rec.group).trim();
  if (group) item.group = group;
  return item;
}

// Returns { items, errors }. `items` is empty whenever there are errors.
function parseTable(text) {
  const errors = [];
  const src = String(text || '').trim();
  if (!src) return { items: [], errors: ['Nothing to read: the box is empty.'] };

  let records = null;
  let where = (i) => `row ${i + 1}`;
  if (src[0] === '[' || src[0] === '{') {
    let data;
    try {
      data = JSON.parse(src);
    } catch (e) {
      return { items: [], errors: [`This looks like JSON but does not parse: ${e.message}`] };
    }
    records = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
    if (!records) return { items: [], errors: ['JSON should be a list of line items, or an object with an "items" list.'] };
    where = (i) => `item ${i + 1}`;
    records.forEach((r, i) => {
      if (!r || typeof r !== 'object') errors.push(`${where(i)}: not an object`);
      else for (const k of Object.keys(r)) if (!COLUMNS.includes(k)) errors.push(`${where(i)}: unknown field "${k}"`);
    });
    if (errors.length) return { items: [], errors };
  } else {
    const rows = parseCsv(src);
    const head = rows[0].map((c) => c.trim().toLowerCase());
    for (const c of head) if (!COLUMNS.includes(c)) errors.push(`header: unknown column "${c}". Expected: ${COLUMNS.join(', ')}`);
    for (const need of ['person', 'category', 'allowed']) if (!head.includes(need)) errors.push(`header: column "${need}" is missing`);
    if (!head.includes('month') && !head.includes('date')) errors.push('header: needs a "date" or a "month" column');
    if (errors.length) return { items: [], errors };
    records = rows.slice(1).map((r) => Object.fromEntries(head.map((c, i) => [c, r[i]])));
    where = (i) => `row ${i + 2}`;
    rows.slice(1).forEach((r, i) => {
      if (r.length > head.length && r.slice(head.length).some((c) => c.trim() !== '')) errors.push(`${where(i)}: more cells than the header has columns`);
    });
  }
  if (!records.length) errors.push('No line items found below the header.');
  const items = records.map((r, i) => readRecord(r, where(i), errors));
  return errors.length ? { items: [], errors } : { items, errors: [] };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(items) {
  const cols = ['person', 'month', 'category', 'allowed', 'network', 'count', 'billed', 'group'];
  const lines = [cols.join(',')];
  for (const it of items) {
    lines.push(
      cols
        .map((c) => {
          if (c === 'allowed' || c === 'billed') return it[c] == null ? '' : csvCell(Math.round(it[c] * 100) / 100);
          if (c === 'count') return it.count == null || it.count === 1 ? '' : csvCell(Math.round(it.count * 1000) / 1000);
          if (c === 'network') return it.network === 'out' ? 'out' : 'in';
          return csvCell(it[c]);
        })
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

module.exports = { parseTable, parseCsv, toCsv, COLUMNS };
