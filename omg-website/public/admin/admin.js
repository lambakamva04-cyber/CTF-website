// OMG admin: booking requests, the calendar, and reviews.
//
// Everything the server sends back (names, phone numbers, notes, review text)
// was typed by someone else, so it reaches the page only as text: through
// textContent and the el() helper below, never as HTML. Links are built only
// from digits we have checked (tel: and wa.me), never from raw input.

import { toMinutes, toHHMM, addMonths, daysInMonth, monthOf, nowInZone, isDate, isTime, weekday } from '../js/slots.js';
import { findService, formatDateLong, formatMonth, formatDuration, UTC_OFFSET_MINUTES } from '../js/catalog.js';

const TABS = ['requests', 'calendar', 'reviews'];
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIGN_OFF = 'OMG – Oh! My Glam';

const $ = (id) => document.getElementById(id);

const state = {
  tab: 'requests',
  month: monthOf(today()),
  loadedAt: { requests: 0, calendar: 0, reviews: 0 },
  seq: { requests: 0, calendar: 0, reviews: 0 },
};

// ---------------------------------------------------------------- DOM helpers

/**
 * Builds an element. Strings become text nodes, so nothing passed in is ever
 * parsed as HTML. `on*` keys add event listeners.
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------- dates and text

function today() {
  return nowInZone(UTC_OFFSET_MINUTES).date;
}

/** "Sat 12 Dec" */
function dayShort(date) {
  if (!isDate(date)) return String(date ?? '');
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekday(date)]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "Saturday 12 December 2026", or the raw value when it is not a date. */
function dayLong(date) {
  return isDate(date) ? formatDateLong(date) : String(date ?? '');
}

/** "12 November 2026" */
function dateMedium(date) {
  if (!isDate(date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Reads a server timestamp as UTC, whether or not it carries a "Z". */
function parseUtc(value) {
  if (typeof value !== 'string') return NaN;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`;
  return Date.parse(text);
}

/** A server timestamp in SAST: { date, time }, or null. */
function localStamp(value) {
  const ms = parseUtc(value);
  if (!Number.isFinite(ms)) return null;
  const t = nowInZone(UTC_OFFSET_MINUTES, ms);
  return { date: t.date, time: toHHMM(t.minutes) };
}

function endTime(start, minutes) {
  const s = toMinutes(start);
  if (!Number.isFinite(s) || !Number.isFinite(minutes)) return '';
  return toHHMM(Math.min(1440, s + minutes));
}

function serviceName(id, fallback) {
  return fallback || findService(id)?.name || String(id ?? '');
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || 'there';
}

/** "45 seconds", "14 minutes" */
function formatWait(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  if (!Number(seconds)) return 'a little while';
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- phone links

/** tel: link from a typed number, or null when it does not look like one. */
function telHref(phone) {
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return `tel:${raw.startsWith('+') ? '+' : ''}${digits}`;
}

/** The number in WhatsApp's format: country code, digits only. 0XXXXXXXXX is South African. */
function waNumber(phone) {
  const raw = String(phone ?? '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (/^0\d{9}$/.test(digits)) digits = `27${digits.slice(1)}`;
    else if (digits.startsWith('00')) digits = digits.slice(2);
  }
  return /^\d{9,15}$/.test(digits) ? digits : null;
}

function waHref(phone, text) {
  const number = waNumber(phone);
  if (!number) return null;
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

function contactRow(phone, waText) {
  const tel = telHref(phone);
  const wa = waHref(phone, waText);
  return el('div', { class: 'contact' },
    el('span', { class: 'phone', text: phone }),
    tel && el('a', { class: 'btn btn-ghost small', href: tel, text: 'Call' }),
    wa && el('a', { class: 'btn btn-ghost small', href: wa, target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' }),
  );
}

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || 'Something went wrong. Please try again.');
    this.status = status;
    this.code = (body && body.error) || (status === 0 ? 'network' : 'error');
    this.body = body || {};
    this.retryAfter = Number(body && body.retryAfter) || 0;
  }
}

async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
  if (method !== 'GET' && method !== 'DELETE') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, { error: 'network', message: "Couldn't reach the server. Check your connection and try again." });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.ok === false) {
    const retryAfter = Number(res.headers.get('retry-after')) || Number(data && data.retryAfter) || 0;
    throw new ApiError(res.status, { ...(data || {}), retryAfter });
  }
  return data;
}

const idOf = (item) => (Number.isInteger(item?.id) && item.id > 0 ? String(item.id) : null);

/** Disables `buttons` while `task` runs, so nothing is sent twice. */
async function withBusy(buttons, task) {
  const list = Array.from(buttons || []).filter(Boolean);
  if (list.some((b) => b.dataset.busy)) return undefined;
  for (const b of list) {
    b.dataset.busy = '1';
    b.disabled = true;
  }
  try {
    return await task();
  } finally {
    for (const b of list) {
      delete b.dataset.busy;
      b.disabled = false;
    }
  }
}

// ---------------------------------------------------------------- feedback

let toastTimer = 0;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

let bannerRetry = null;
function showBanner(text, retry) {
  $('banner-text').textContent = text;
  bannerRetry = retry || null;
  $('banner-retry').hidden = !retry;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
  bannerRetry = null;
}

function rateLimitText(err) {
  return `Too many requests. Please wait ${formatWait(err.retryAfter)} and try again.`;
}

/** Turns a failed call into the right message. Returns true when it was handled. */
function handleError(err, retry) {
  if (!(err instanceof ApiError)) {
    showBanner('Something went wrong. Please try again.', retry);
    return true;
  }
  if (err.status === 401) {
    sessionEnded();
    return true;
  }
  if (err.status === 429) {
    showBanner(rateLimitText(err), retry);
    return true;
  }
  if (err.status === 0) {
    showBanner(err.message, retry);
    return true;
  }
  showBanner(err.message || 'Something went wrong. Please try again.');
  return true;
}

function loading(container) {
  container.replaceChildren(el('p', { class: 'loading', text: 'Loading…' }));
}

function loadFailed(container, err, retry) {
  if (err instanceof ApiError && err.status === 401) {
    sessionEnded();
    return;
  }
  let text = "Couldn't load this.";
  if (err instanceof ApiError && err.status === 429) text = rateLimitText(err);
  else if (err instanceof ApiError && err.status === 0) text = err.message;
  else if (err instanceof ApiError && err.message) text = err.message;
  container.replaceChildren(el('div', { class: 'load-error' },
    el('p', { text }),
    el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Try again', onclick: retry }),
  ));
}

// ---------------------------------------------------------------- confirm dialog

/** An in-page yes/no question. Resolves true only when the action button is used. */
function askConfirm({ title, message, confirmLabel }) {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message || '';
  $('confirm-ok').textContent = confirmLabel || 'OK';
  return new Promise((resolve) => {
    const onOk = () => dialog.close('ok');
    const onCancel = () => dialog.close('cancel');
    const onClose = () => {
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      resolve(dialog.returnValue === 'ok');
    };
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    $('confirm-cancel').focus();
  });
}

// ---------------------------------------------------------------- views

function show(view) {
  $('boot').hidden = true;
  $('login').hidden = view !== 'login';
  $('app').hidden = view !== 'app';
}

function showLogin(note) {
  hideBanner();
  const dialog = $('confirm-dialog');
  if (dialog.open) dialog.close('cancel');
  for (const id of ['requests-list', 'requests-notice', 'blocks-list', 'reviews-pending', 'reviews-approved']) $(id).replaceChildren();
  setCounts({ requests: 0, reviews: 0 });
  $('login-note').textContent = note || '';
  $('login-note').hidden = !note;
  $('login-message').hidden = true;
  show('login');
  $('password').focus();
}

function sessionEnded() {
  showLogin('Your session has ended. Please log in again.');
}

function setCounts(pending) {
  for (const key of ['requests', 'reviews']) {
    const n = Math.max(0, Number(pending?.[key]) || 0);
    const badge = $(`badge-${key}`);
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
    const label = key === 'requests' ? 'Requests' : 'Reviews';
    $(`tab-${key}`).setAttribute('aria-label', n ? `${label}, ${n} waiting` : label);
  }
}

async function refreshCounts() {
  try {
    const session = await api('GET', '/api/admin/session');
    setCounts(session.pending);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) sessionEnded();
  }
}

function enterApp(session) {
  setCounts(session?.pending);
  show('app');
  selectTab(state.tab, { focus: true });
}

const loaders = {
  requests: () => loadRequests(),
  calendar: () => loadCalendar(),
  reviews: () => loadReviews(),
};

function selectTab(name, { focus = false } = {}) {
  state.tab = name;
  for (const key of TABS) {
    const on = key === name;
    const tab = $(`tab-${key}`);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${key}`).hidden = !on;
  }
  hideBanner();
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  loaders[name]();
  if (focus) $(`panel-${name}`).focus({ preventScroll: true });
}

// ---------------------------------------------------------------- requests

async function loadRequests() {
  const seq = ++state.seq.requests;
  const list = $('requests-list');
  loading(list);
  try {
    const data = await api('GET', '/api/admin/requests');
    if (seq !== state.seq.requests) return;
    state.loadedAt.requests = Date.now();
    renderRequests(Array.isArray(data.requests) ? data.requests : []);
  } catch (err) {
    if (seq === state.seq.requests) loadFailed(list, err, loadRequests);
  }
}

function renderRequests(requests) {
  const list = $('requests-list');
  list.replaceChildren(...requests.filter(idOf).map(requestCard));
  if (!list.children.length) emptyRequests();
}

function emptyRequests() {
  $('requests-list').replaceChildren(el('p', { class: 'empty', text: 'No new requests. When someone books on the website, it shows up here for you to confirm.' }));
}

function requestCard(r) {
  const name = serviceName(r.service, r.serviceName);
  const created = localStamp(r.createdAt);
  const card = el('article', { class: 'card', 'aria-label': `Request from ${r.name}` },
    el('div', { class: 'card-top' },
      el('h3', { text: name }),
      Number.isFinite(r.price) && el('span', { class: 'price', text: `R${r.price}` }),
    ),
    el('p', { class: 'when' },
      el('strong', { text: dayLong(r.date) }), el('br'),
      `${r.time} – ${endTime(r.time, r.minutes)}`,
      Number.isFinite(r.minutes) && el('span', { class: 'muted', text: ` · ${formatDuration(r.minutes)}` }),
    ),
    el('p', { class: 'who', text: r.name }),
    contactRow(r.phone),
    el('p', { class: 'meta', text: [r.ref && `Ref ${r.ref}`, created && `Requested ${dayShort(created.date)}, ${created.time}`].filter(Boolean).join(' · ') }),
  );
  const confirm = el('button', { class: 'btn btn-primary', type: 'button', text: 'Confirm' });
  const decline = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Decline' });
  confirm.addEventListener('click', () => confirmRequest(r, card, false));
  decline.addEventListener('click', () => declineRequest(r, card));
  card.append(el('div', { class: 'actions' }, confirm, decline));
  return card;
}

function conflictText(block) {
  const allDay = block?.start === '00:00' && block?.end === '24:00';
  const time = allDay ? 'All day' : `${block?.start ?? ''}–${block?.end ?? ''}`;
  const kind = block?.kind === 'closed' ? 'Time off' : 'Booking';
  const who = block?.name || block?.label;
  return [time, kind, who].filter(Boolean).join(' · ');
}

function overlapBox(conflicts, actionLabel, onForce, onCancel) {
  const items = (Array.isArray(conflicts) ? conflicts : []).map((b) => el('li', { text: conflictText(b) }));
  const force = el('button', { class: 'btn btn-primary small', type: 'button', text: actionLabel });
  const cancel = el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Cancel' });
  const box = el('div', { class: 'overlap', role: 'alert' },
    el('p', { text: 'This overlaps something already on the calendar:' }),
    items.length ? el('ul', {}, items) : null,
    el('div', { class: 'actions' }, force, cancel),
  );
  force.addEventListener('click', onForce);
  cancel.addEventListener('click', () => { box.remove(); if (onCancel) onCancel(); });
  return box;
}

async function confirmRequest(r, card, force) {
  const id = idOf(r);
  if (!id) return;
  await withBusy(card.querySelectorAll('button'), async () => {
    try {
      await api('POST', `/api/admin/requests/${id}/confirm`, force ? { force: true } : {});
      card.remove();
      if (!$('requests-list').children.length) emptyRequests();
      notice(`Confirmed: ${r.name}, ${dayShort(r.date)} at ${r.time}. It's on your calendar now.`,
        waHref(r.phone, confirmMessage(r)), `Send ${firstName(r.name)} a confirmation on WhatsApp`);
      state.loadedAt.calendar = 0;
      refreshCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'overlap') {
        card.querySelector('.overlap')?.remove();
        card.append(overlapBox(err.body.conflicts, 'Confirm anyway', () => confirmRequest(r, card, true)));
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        card.remove();
        if (!$('requests-list').children.length) emptyRequests();
        showBanner('That request is no longer waiting. It may have been dealt with already.');
        refreshCounts();
        return;
      }
      handleError(err);
    }
  });
}

async function declineRequest(r, card) {
  const id = idOf(r);
  if (!id) return;
  const ok = await askConfirm({
    title: 'Decline this request?',
    message: `${r.name} · ${serviceName(r.service, r.serviceName)} · ${dayShort(r.date)} at ${r.time}. It will be removed from your list.`,
    confirmLabel: 'Decline',
  });
  if (!ok) return;
  await withBusy(card.querySelectorAll('button'), async () => {
    try {
      await api('POST', `/api/admin/requests/${id}/decline`, {});
      card.remove();
      if (!$('requests-list').children.length) emptyRequests();
      notice(`Declined: ${r.name}, ${dayShort(r.date)} at ${r.time}.`,
        waHref(r.phone, declineMessage(r)), `Let ${firstName(r.name)} know on WhatsApp`);
      refreshCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        card.remove();
        if (!$('requests-list').children.length) emptyRequests();
        refreshCounts();
        return;
      }
      handleError(err);
    }
  });
}

function confirmMessage(r) {
  return `Hi ${firstName(r.name)}, your ${serviceName(r.service, r.serviceName)} on ${dayLong(r.date)} at ${r.time} is confirmed. See you then!\n\n${SIGN_OFF}`;
}

function declineMessage(r) {
  return `Hi ${firstName(r.name)}, thank you for your booking request for ${serviceName(r.service, r.serviceName)} on ${dayLong(r.date)} at ${r.time}. Unfortunately that time is not available. Would another time suit you?\n\n${SIGN_OFF}`;
}

/** A message above the list that stays until dismissed, with an optional WhatsApp follow-up. */
function notice(text, href, linkText) {
  const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', text: '×' });
  const box = el('div', { class: 'notice', role: 'status' },
    el('div', { class: 'notice-body' },
      el('p', { text }),
      href && el('a', { class: 'btn btn-primary small', href, target: '_blank', rel: 'noopener noreferrer', text: linkText }),
    ),
    close,
  );
  close.addEventListener('click', () => box.remove());
  $('requests-notice').replaceChildren(box);
}

// ---------------------------------------------------------------- calendar

function monthRange(month) {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

async function loadCalendar() {
  const seq = ++state.seq.calendar;
  const month = state.month;
  $('month-label').textContent = formatMonth(month);
  const list = $('blocks-list');
  loading(list);
  const { from, to } = monthRange(month);
  try {
    const data = await api('GET', `/api/admin/blocks?from=${from}&to=${to}`);
    if (seq !== state.seq.calendar) return;
    state.loadedAt.calendar = Date.now();
    renderBlocks(Array.isArray(data.blocks) ? data.blocks : [], month);
  } catch (err) {
    if (seq === state.seq.calendar) loadFailed(list, err, loadCalendar);
  }
}

function renderBlocks(blocks, month) {
  const list = $('blocks-list');
  const byDate = new Map();
  for (const b of blocks) {
    if (!idOf(b) || !isDate(b.date) || monthOf(b.date) !== month) continue;
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) {
    list.replaceChildren(el('p', { class: 'empty', text: `Nothing on the calendar in ${formatMonth(month)}.` }));
    return;
  }
  const now = today();
  list.replaceChildren(...dates.map((date) => {
    const items = byDate.get(date).sort((a, b) => (toMinutes(a.start) - toMinutes(b.start)) || (toMinutes(a.end) - toMinutes(b.end)));
    return el('section', { class: `day${date < now ? ' past' : ''}`, 'aria-label': dayLong(date) },
      el('h4', { class: 'day-head' }, dayLong(date).replace(/ \d{4}$/, ''), date === now && el('span', { class: 'tag today', text: 'Today' })),
      el('ul', { class: 'blocks' }, items.map(blockRow)),
    );
  }));
}

function blockRow(b) {
  const allDay = b.start === '00:00' && b.end === '24:00';
  const closed = b.kind === 'closed';
  const service = b.service ? serviceName(b.service) : '';
  const del = el('button', { class: 'btn btn-danger small block-del', type: 'button', text: 'Delete' });
  const row = el('li', { class: `block${closed ? ' closed' : ''}` },
    el('div', { class: 'block-time', text: allDay ? 'All day' : `${b.start}–${b.end}` }),
    el('div', { class: 'block-body' },
      el('span', { class: `pill ${closed ? 'off' : 'booked'}`, text: closed ? 'Time off' : 'Booking' }),
      b.name && el('p', { class: 'block-who', text: b.name }),
      b.label && b.label !== b.name && el('p', { class: 'block-note', text: b.label }),
      b.phone && contactRow(b.phone),
      (b.ref || service) && el('p', { class: 'meta', text: [service, b.ref && `Ref ${b.ref}`].filter(Boolean).join(' · ') }),
    ),
    del,
  );
  del.setAttribute('aria-label', `Delete ${closed ? 'time off' : 'booking'}, ${dayShort(b.date)} ${allDay ? 'all day' : `${b.start} to ${b.end}`}`);
  del.addEventListener('click', () => deleteBlock(b, row, del));
  return row;
}

async function deleteBlock(b, row, button) {
  const id = idOf(b);
  if (!id) return;
  const allDay = b.start === '00:00' && b.end === '24:00';
  const what = [dayShort(b.date), allDay ? 'all day' : `${b.start}–${b.end}`, b.name || b.label].filter(Boolean).join(' · ');
  const ok = await askConfirm({
    title: b.kind === 'closed' ? 'Delete this time off?' : 'Delete this booking?',
    message: `${what}. That time becomes free for bookings again.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  await withBusy([button], async () => {
    try {
      await api('DELETE', `/api/admin/blocks/${id}`);
      toast('Deleted from the calendar.');
      loadCalendar();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        loadCalendar();
        return;
      }
      handleError(err);
    }
  });
}

function blockFormMessage(content) {
  const box = $('block-message');
  if (!content) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.replaceChildren(...(Array.isArray(content) ? content : [content]));
  box.hidden = false;
}

function readBlockForm() {
  const form = $('block-form');
  const whole = $('block-whole').checked;
  const kind = form.elements.kind.value === 'closed' ? 'closed' : 'booking';
  const date = $('block-date').value;
  let start = whole ? '00:00' : $('block-start').value;
  let end = whole ? '24:00' : $('block-end').value;
  // "18:00 to 00:00" means until midnight.
  if (!whole && end === '00:00' && start && start !== '00:00') end = '24:00';
  const label = $('block-label').value.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!isDate(date)) return { error: 'Pick a date.' };
  if (!isTime(start) || !isTime(end)) return { error: 'Enter a start and an end time, or tick Whole day.' };
  if (toMinutes(start) % 5 || toMinutes(end) % 5) return { error: 'Use times on 5-minute marks, like 09:00 or 09:05.' };
  if (toMinutes(start) >= toMinutes(end)) return { error: 'The end time has to be after the start time.' };
  return { body: { date, start, end, kind, label: label || undefined } };
}

async function addBlock(force) {
  const { body, error } = readBlockForm();
  if (error) {
    blockFormMessage(el('p', { text: error }));
    return;
  }
  blockFormMessage(null);
  await withBusy([$('block-submit')], async () => {
    try {
      await api('POST', '/api/admin/blocks', force ? { ...body, force: true } : body);
      $('block-start').value = '';
      $('block-end').value = '';
      $('block-label').value = '';
      toast(body.kind === 'closed' ? 'Time off added.' : 'Booking added.');
      state.month = monthOf(body.date);
      loadCalendar();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'overlap') {
        const items = (Array.isArray(err.body.conflicts) ? err.body.conflicts : []).map((b) => el('li', { text: conflictText(b) }));
        const force = el('button', { class: 'btn btn-primary small', type: 'button', text: 'Add anyway' });
        const cancel = el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Cancel' });
        force.addEventListener('click', () => addBlock(true));
        cancel.addEventListener('click', () => blockFormMessage(null));
        blockFormMessage([
          el('p', { text: 'This overlaps something already on the calendar:' }),
          items.length ? el('ul', {}, items) : null,
          el('div', { class: 'actions row-actions' }, force, cancel),
        ].filter(Boolean));
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        blockFormMessage(el('p', { text: err.message }));
        return;
      }
      handleError(err);
    }
  });
}

// ---------------------------------------------------------------- reviews

async function loadReviews() {
  const seq = ++state.seq.reviews;
  const pending = $('reviews-pending');
  const approved = $('reviews-approved');
  loading(pending);
  approved.replaceChildren();
  try {
    const [p, a] = await Promise.all([
      api('GET', '/api/admin/reviews?status=pending'),
      api('GET', '/api/admin/reviews?status=approved'),
    ]);
    if (seq !== state.seq.reviews) return;
    state.loadedAt.reviews = Date.now();
    renderReviews(pending, Array.isArray(p.reviews) ? p.reviews : [], true);
    renderReviews(approved, Array.isArray(a.reviews) ? a.reviews : [], false);
  } catch (err) {
    if (seq === state.seq.reviews) loadFailed(pending, err, loadReviews);
  }
}

function renderReviews(container, reviews, pending) {
  container.replaceChildren(...reviews.filter(idOf).map((r) => reviewCard(r, pending)));
  if (!container.children.length) {
    container.replaceChildren(el('p', { class: 'empty', text: pending ? 'No reviews waiting.' : 'No reviews on the website yet.' }));
  }
}

function reviewCard(r, pending) {
  const rating = Math.min(4, Math.max(1, Math.round(Number(r.rating) || 1)));
  const created = localStamp(r.createdAt);
  const card = el('article', { class: 'card', 'aria-label': `Review by ${r.name}` },
    el('div', { class: 'review-head' },
      el('span', { class: 'stars', role: 'img', 'aria-label': `${rating} out of 4 stars`, text: '★'.repeat(rating) + '☆'.repeat(4 - rating) }),
      created && el('span', { class: 'meta', text: dateMedium(created.date) }),
    ),
    el('p', { class: 'review-name', text: r.name }),
    el('p', { class: 'review-text', text: r.comment }),
  );
  const remove = el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete' });
  remove.addEventListener('click', () => deleteReview(r, card, pending));
  if (pending) {
    const approve = el('button', { class: 'btn btn-primary', type: 'button', text: 'Approve' });
    approve.addEventListener('click', () => approveReview(r, card));
    card.append(el('div', { class: 'actions' }, approve, remove));
  } else {
    card.append(el('div', { class: 'actions one' }, remove));
  }
  return card;
}

async function approveReview(r, card) {
  const id = idOf(r);
  if (!id) return;
  await withBusy(card.querySelectorAll('button'), async () => {
    try {
      await api('POST', `/api/admin/reviews/${id}/approve`, {});
      toast("Approved. It's on the website now.");
      loadReviews();
      refreshCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        loadReviews();
        refreshCounts();
        return;
      }
      handleError(err);
    }
  });
}

async function deleteReview(r, card, pending) {
  const id = idOf(r);
  if (!id) return;
  const ok = await askConfirm({
    title: 'Delete this review?',
    message: pending ? `By ${r.name}. It will not appear on the website.` : `By ${r.name}. It will be taken off the website.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  await withBusy(card.querySelectorAll('button'), async () => {
    try {
      await api('DELETE', `/api/admin/reviews/${id}`);
      toast('Review deleted.');
      loadReviews();
      refreshCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        loadReviews();
        refreshCounts();
        return;
      }
      handleError(err);
    }
  });
}

// ---------------------------------------------------------------- login

function loginError(text) {
  const box = $('login-message');
  box.textContent = text;
  box.hidden = false;
}

async function login(event) {
  event.preventDefault();
  const input = $('password');
  const password = input.value;
  $('login-note').hidden = true;
  if (!password) {
    loginError('Enter the admin password.');
    input.focus();
    return;
  }
  await withBusy([$('login-button')], async () => {
    try {
      await api('POST', '/api/admin/login', { password });
      input.value = '';
      input.type = 'password';
      $('show-password').checked = false;
      $('login-message').hidden = true;
      const session = await api('GET', '/api/admin/session');
      state.tab = 'requests';
      enterApp(session);
    } catch (err) {
      if (!(err instanceof ApiError)) loginError('Something went wrong. Please try again.');
      else if (err.status === 401) loginError("That password isn't right. Please try again.");
      else if (err.status === 429) loginError(`Too many attempts. Please wait ${formatWait(err.retryAfter)} and try again.`);
      else if (err.status === 503) loginError('Admin login is not switched on yet. Whoever looks after the website needs to set the ADMIN_PASSWORD secret (at least 12 characters) first.');
      else loginError(err.message);
      input.select();
    }
  });
}

async function logout() {
  await withBusy([$('logout')], async () => {
    try {
      await api('POST', '/api/admin/logout', {});
      showLogin("You're logged out.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) showLogin("You're logged out.");
      else handleError(err, logout);
    }
  });
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('login-form').addEventListener('submit', login);
  $('show-password').addEventListener('change', (e) => { $('password').type = e.target.checked ? 'text' : 'password'; });
  $('logout').addEventListener('click', logout);

  for (const key of TABS) $(`tab-${key}`).addEventListener('click', () => selectTab(key));
  $('app').querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(state.tab);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(TABS[next]);
    $(`tab-${TABS[next]}`).focus();
  });

  $('banner-close').addEventListener('click', hideBanner);
  $('banner-retry').addEventListener('click', () => {
    const retry = bannerRetry;
    hideBanner();
    if (retry) retry();
  });

  $('refresh-requests').addEventListener('click', () => { $('requests-notice').replaceChildren(); loadRequests(); refreshCounts(); });
  $('refresh-calendar').addEventListener('click', () => loadCalendar());
  $('refresh-reviews').addEventListener('click', () => { loadReviews(); refreshCounts(); });

  $('month-prev').addEventListener('click', () => { state.month = addMonths(state.month, -1); loadCalendar(); });
  $('month-next').addEventListener('click', () => { state.month = addMonths(state.month, 1); loadCalendar(); });

  $('add-block').addEventListener('toggle', () => {
    if (!$('add-block').open) return;
    if (!$('block-date').value) {
      const now = today();
      $('block-date').value = monthOf(now) === state.month ? now : `${state.month}-01`;
    }
  });
  $('block-whole').addEventListener('change', (e) => {
    $('block-start').disabled = e.target.checked;
    $('block-end').disabled = e.target.checked;
  });
  $('block-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addBlock(false);
  });

  // Coming back to the page after a while: refresh what is on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || $('app').hidden) return;
    refreshCounts();
    if (Date.now() - state.loadedAt[state.tab] > 30_000) loaders[state.tab]();
  });
}

async function boot() {
  wire();
  try {
    const session = await api('GET', '/api/admin/session');
    enterApp(session);
  } catch (err) {
    showLogin();
    if (err instanceof ApiError && err.status !== 401) {
      loginError(err.status === 0 ? err.message : 'Something went wrong loading the admin page. Please reload.');
    }
  }
}

boot();
