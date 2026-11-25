// OMG admin: booking requests, the calendar, and reviews.
//
// Everything the server sends back (names, phone numbers, notes, review text)
// was typed by someone else, so it reaches the page only as text: through
// textContent and the el() helper below, never as HTML. Links are built only
// from digits we have checked (tel: and wa.me), never from raw input.

import { toMinutes, toHHMM, addDays, addMonths, daysInMonth, monthOf, nowInZone, isDate, isTime, weekday } from '../js/slots.js';
import { formatDateLong, formatMonth, formatDuration, UTC_OFFSET_MINUTES } from '../js/catalog.js';

const TABS = ['requests', 'calendar', 'reviews', 'website'];
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIGN_OFF = 'OMG – Oh! My Glam';

const $ = (id) => document.getElementById(id);

const state = {
  tab: 'requests',
  month: monthOf(today()),
  loadedAt: { requests: 0, calendar: 0, reviews: 0, website: 0 },
  seq: { requests: 0, calendar: 0, reviews: 0, website: 0 },
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

/** The service's name as the server sent it (it reads the current services), or its id. */
function serviceName(id, fallback) {
  return fallback || String(id ?? '');
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

function contactRow(phone, waText, waLabel = 'WhatsApp') {
  const tel = telHref(phone);
  const wa = waHref(phone, waText);
  // A longer label gets each button a row of its own, so it never wraps.
  const cls = `btn btn-ghost small${waLabel.length > 10 ? ' span' : ''}`;
  return el('div', { class: 'contact' },
    el('span', { class: 'phone', text: phone }),
    tel && el('a', { class: cls, href: tel, text: 'Call' }),
    wa && el('a', { class: cls, href: wa, target: '_blank', rel: 'noopener noreferrer', text: waLabel }),
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
  $('setup-form').hidden = true;
  $('login-form').hidden = false;
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
  setUpAlerts();
}

const loaders = {
  requests: () => loadRequests(),
  calendar: () => { loadCalendar(); loadSync(); },
  reviews: () => loadReviews(),
  website: () => loadWebsite(),
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

// ---------------------------------------------------------------- alerts

// Phone alerts for new booking requests and reviews (Web Push). sw.js shows
// them; this card turns them on and off for the device it is opened on.
const alerts = { registration: null, subscription: null, started: false };

function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Which calendar apps this device can add a calendar link to, so no button is shown that can't work here. */
function calendarDevice() {
  if (isIos()) return 'iphone';
  if (/Macintosh/.test(navigator.userAgent)) return 'mac';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'computer';
}

function fromBase64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function setUpAlerts() {
  if (alerts.started) return;
  alerts.started = true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    renderAlerts(isIos() && !standalone() ? 'ios-home-screen' : 'unsupported');
    return;
  }
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'refresh') {
      refreshCounts();
      loaders[state.tab]();
    }
  });
  try {
    alerts.registration = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
    alerts.subscription = await alerts.registration.pushManager.getSubscription();
  } catch {
    renderAlerts('unsupported');
    return;
  }
  if (alerts.subscription && Notification.permission === 'granted') {
    // Sent again on every visit: harmless if the server has it, and it brings
    // back one the server dropped.
    api('POST', '/api/admin/push/subscribe', { endpoint: alerts.subscription.endpoint }).catch(() => {});
  }
  renderAlerts(currentAlertMode());
}

function currentAlertMode() {
  if (Notification.permission === 'denied') return 'blocked';
  return alerts.subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

function renderAlerts(mode) {
  const box = $('alerts');
  const views = {
    off: () => [
      el('h3', { text: 'Get an alert for every booking' }),
      el('p', { text: 'Turn on alerts and this device tells you the moment someone requests a time or leaves a review.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-primary small', type: 'button', id: 'alerts-on', text: 'Turn on alerts', onclick: (e) => turnOnAlerts(e.currentTarget) })),
    ],
    on: () => [
      el('p', { text: 'Alerts are on for this device.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost small', type: 'button', id: 'alerts-test', text: 'Send a test', onclick: (e) => sendTestAlert(e.currentTarget) }),
        el('button', { class: 'btn btn-ghost small', type: 'button', id: 'alerts-off', text: 'Turn off', onclick: (e) => turnOffAlerts(e.currentTarget) })),
    ],
    blocked: () => [
      el('h3', { text: 'Alerts are blocked on this device' }),
      el('p', { text: "This browser is set to block alerts from this site. Allow notifications for it in the browser's settings, then reload this page." }),
    ],
    'ios-home-screen': () => [
      el('h3', { text: 'Get an alert for every booking' }),
      el('p', { text: 'On iPhone, alerts work from the home screen. Tap Share, then Add to Home Screen. Open OMG Admin from your home screen and turn alerts on there.' }),
    ],
    unsupported: () => [
      el('p', { text: "This browser can't show alerts. To get them, open this page in Chrome, Safari, Edge or Firefox." }),
    ],
  };
  box.className = `alerts${mode === 'on' ? ' is-on' : ''}`;
  box.dataset.mode = mode;
  box.replaceChildren(...views[mode]());
  box.hidden = false;
}

async function turnOnAlerts(button) {
  await withBusy([button], async () => {
    // Asked straight from the tap: browsers only allow the question then.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      renderAlerts(permission === 'denied' ? 'blocked' : 'off');
      return;
    }
    try {
      const { publicKey } = await api('GET', '/api/admin/push/key');
      alerts.subscription = await alerts.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64url(publicKey),
      });
      await api('POST', '/api/admin/push/subscribe', { endpoint: alerts.subscription.endpoint });
      renderAlerts('on');
      toast('Alerts are on. Tap "Send a test" to try one.');
    } catch (err) {
      if (err instanceof ApiError) handleError(err);
      else showBanner("Alerts couldn't be turned on in this browser. Check that it is up to date, then try again.");
    }
  });
}

async function sendTestAlert(button) {
  await withBusy([button], async () => {
    try {
      const result = await api('POST', '/api/admin/push/test');
      toast(result.sent
        ? `Test alert sent to ${result.sent === 1 ? 'your device' : `${result.sent} devices`}. It should arrive in a few seconds.`
        : "The test didn't reach any device. Turn alerts off and on again on this device.");
    } catch (err) {
      handleError(err);
    }
  });
}

async function turnOffAlerts(button) {
  await withBusy([button], async () => {
    const subscription = alerts.subscription;
    try {
      if (subscription) {
        await api('POST', '/api/admin/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe().catch(() => {});
      }
      alerts.subscription = null;
      renderAlerts('off');
      toast('Alerts are off for this device.');
    } catch (err) {
      handleError(err);
    }
  });
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
  const kind = { closed: 'Time off', calendar: 'Busy in your own calendar' }[block?.kind] || 'Booking';
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

/** A reminder for an upcoming booking: cuts no-shows, and frees the slot early if plans changed. */
function reminderMessage(b) {
  const when = b.date === addDays(today(), 1) ? `tomorrow, ${dayLong(b.date)},` : b.date === today() ? 'today' : `on ${dayLong(b.date)}`;
  const service = b.service ? `${serviceName(b.service, b.serviceName)} appointment` : 'appointment';
  return `Hi ${firstName(b.name)}, a friendly reminder of your ${service} ${when} at ${b.start}. Please reply to confirm you're still coming, or let us know if you need to change it. See you then!\n\n${SIGN_OFF}`;
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
    renderBlocks(Array.isArray(data.blocks) ? data.blocks : [], month, externalItems(data.external));
  } catch (err) {
    if (seq === state.seq.calendar) loadFailed(list, err, loadCalendar);
  }
}

/** { date: [[start, end]] } busy in her own calendar → read-only list items. */
function externalItems(external) {
  const items = [];
  if (!external || typeof external !== 'object') return items;
  for (const [date, ranges] of Object.entries(external)) {
    if (!isDate(date) || !Array.isArray(ranges)) continue;
    for (const r of ranges) {
      if (Array.isArray(r) && isTime(r[0]) && isTime(r[1]) && toMinutes(r[1]) > toMinutes(r[0])) items.push({ kind: 'calendar', date, start: r[0], end: r[1] });
    }
  }
  return items;
}

function renderBlocks(blocks, month, external = []) {
  const list = $('blocks-list');
  const byDate = new Map();
  for (const b of [...blocks, ...external]) {
    if ((b.kind !== 'calendar' && !idOf(b)) || !isDate(b.date) || monthOf(b.date) !== month) continue;
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

/** A time that is busy in her own calendar: shown so the day reads true, changed only in that calendar. */
function busyRow(b) {
  const allDay = b.start === '00:00' && b.end === '24:00';
  return el('li', { class: 'block external' },
    el('div', { class: 'block-time', text: allDay ? 'All day' : `${b.start}–${b.end}` }),
    el('div', { class: 'block-body' },
      el('span', { class: 'pill busy', text: 'Busy' }),
      el('p', { class: 'block-note', text: 'From your own calendar' }),
    ),
  );
}

function blockRow(b) {
  if (b.kind === 'calendar') return busyRow(b);
  const allDay = b.start === '00:00' && b.end === '24:00';
  const closed = b.kind === 'closed';
  const service = b.service ? serviceName(b.service, b.serviceName) : '';
  const del = el('button', { class: 'btn btn-danger small block-del', type: 'button', text: 'Delete' });
  const row = el('li', { class: `block${closed ? ' closed' : ''}` },
    el('div', { class: 'block-time', text: allDay ? 'All day' : `${b.start}–${b.end}` }),
    el('div', { class: 'block-body' },
      el('span', { class: `pill ${closed ? 'off' : 'booked'}`, text: closed ? 'Time off' : 'Booking' }),
      b.name && el('p', { class: 'block-who', text: b.name }),
      b.label && b.label !== b.name && el('p', { class: 'block-note', text: b.label }),
      b.phone && (!closed && b.date >= today()
        ? contactRow(b.phone, reminderMessage(b), 'Remind on WhatsApp')
        : contactRow(b.phone)),
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

// ---------------------------------------------------------------- phone calendar

// Both ways between the website and OMG's own calendar: confirmed bookings and
// time off go to her calendar app (a private link it subscribes to), and the
// busy times in her calendar (a private link she pastes here) can't be booked.
const sync = { data: null, seq: 0 };

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago" */
function agoText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

async function loadSync() {
  const seq = ++sync.seq;
  try {
    const data = await api('GET', '/api/admin/calendar-sync');
    if (seq !== sync.seq) return;
    renderSync(data);
  } catch (err) {
    if (seq !== sync.seq) return;
    if (err instanceof ApiError && err.status === 401) {
      sessionEnded();
      return;
    }
    $('sync-body').replaceChildren(el('p', { class: 'bad', text: err instanceof ApiError && err.message ? err.message : "Couldn't load this." }));
  }
}

const safeLink = (value, scheme) => (typeof value === 'string' && value.startsWith(`${scheme}://${location.host}/calendar/`) ? value : null);

function renderSync(data) {
  sync.data = data;
  const feed = data.feed || {};
  const imp = data.import || {};
  const webcal = safeLink(feed.webcal, 'webcal');
  const https = safeLink(feed.https, location.protocol.slice(0, -1));
  const linkedOut = Boolean(feed.seenAt);
  const linkedIn = imp.connected === true;
  const trouble = linkedIn && imp.ok === false;

  const box = $('sync');
  box.classList.toggle('is-linked', linkedOut && linkedIn && !trouble);
  box.classList.toggle('needs-attention', trouble);
  $('sync-summary').textContent = trouble ? "Your calendar couldn't be read"
    : linkedOut && linkedIn ? 'Phone calendar linked both ways'
      : linkedOut || linkedIn ? 'Phone calendar linked one way' : "Link your phone's calendar";

  // Only buttons that work on this device: iPhones and Macs subscribe with a
  // webcal: link, Google Calendar adds a link on a computer, and an Android
  // phone can't subscribe to a calendar link at all, so it gets the link to
  // copy or share instead.
  const device = calendarDevice();
  const google = webcal && `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const primary = (on) => `btn ${on && !linkedOut ? 'btn-primary' : 'btn-ghost'} small`;
  const copy = https && el('button', { class: primary(device === 'android'), type: 'button', id: 'sync-copy', text: 'Copy link', onclick: (e) => copyFeedLink(e.currentTarget, https) });
  const share = https && device === 'android' && typeof navigator.share === 'function'
    && el('button', { class: 'btn btn-ghost small', type: 'button', id: 'sync-share', text: 'Share link', onclick: () => navigator.share({ title: 'OMG bookings calendar', url: https }).catch(() => {}) });
  const apple = webcal && (device === 'iphone' || device === 'mac')
    && el('a', { class: primary(true), id: 'sync-subscribe', href: webcal, text: device === 'iphone' ? 'Add to iPhone Calendar' : 'Add to Apple Calendar' });
  const googleBtn = google && (device === 'mac' || device === 'computer')
    && el('a', { class: primary(device === 'computer'), id: 'sync-google', href: google, target: '_blank', rel: 'noopener noreferrer', text: 'Add to Google Calendar' });
  const hints = {
    iphone: [
      'Tap Add to iPhone Calendar, then Subscribe.',
      'If nothing opens, tap Copy link, then in Settings go to Calendar, Accounts, Add Account, Other, Add Subscribed Calendar, and paste it.',
    ],
    mac: [
      'Apple Calendar: click Add to Apple Calendar, then Subscribe.',
      'Google Calendar: click Add to Google Calendar, then Add.',
    ],
    computer: [
      'Google Calendar: click Add to Google Calendar, then Add.',
      'Outlook: copy the link, then in Outlook choose Add calendar, Subscribe from web, and paste it.',
    ],
    android: [
      "Android phones can't add a calendar link themselves.",
      "For the bookings to show in an iPhone's calendar, open this page on that iPhone and tap Add to iPhone Calendar there.",
      'For Google Calendar, copy or share the link, then on a computer open Google Calendar, choose + next to Other calendars, From URL, and paste it.',
    ],
  }[device];
  const out = el('section', { class: 'sync-part', 'aria-labelledby': 'sync-out-head' },
    el('h4', { id: 'sync-out-head', text: 'Website bookings in your calendar' }),
    linkedOut
      ? el('p', { class: 'ok', text: `Your calendar app last collected them ${agoText(feed.seenAt)}.` })
      : el('p', { text: "Confirmed bookings and time off show in your calendar, next to your other appointments, with each client's number." }),
    el('div', { class: 'row' }, apple, googleBtn, copy, share),
    hints.map((text) => el('p', { class: 'hint', text })),
    el('p', { class: 'hint', text: "Keep the link to yourself: it shows your clients' names and numbers." }),
    el('button', { class: 'link-btn', type: 'button', id: 'sync-reset', text: 'Make a new link', onclick: (e) => resetFeedLink(e.currentTarget) }),
  );

  const inn = el('section', { class: 'sync-part', 'aria-labelledby': 'sync-in-head' },
    el('h4', { id: 'sync-in-head', text: 'Your other appointments on the website' }));
  if (linkedIn) {
    const source = typeof imp.source === 'string' ? imp.source : 'calendar';
    const lines = [];
    if (imp.ok) {
      lines.push(el('p', { class: 'ok', text: `Reading your ${source} calendar. Checked ${agoText(imp.checkedAt)}.` }));
      lines.push(el('p', { text: imp.times ? `Busy times in it can't be booked on the website. Only the times are read, never what your appointments are.` : 'Nothing in it is busy from today on, so nothing is blocked.' }));
    } else {
      lines.push(el('p', { class: 'bad', text: `Your ${source} calendar couldn't be read ${agoText(imp.checkedAt)}. ${imp.error || ''}`.trim() }));
      if (imp.readAt) lines.push(el('p', { text: `The website still blocks the busy times it read ${agoText(imp.readAt)}. It tries again every 15 minutes.` }));
    }
    inn.append(...lines, el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost small', type: 'button', id: 'sync-now', text: 'Check now', onclick: (e) => syncImportNow(e.currentTarget) }),
      el('button', { class: 'btn btn-danger small', type: 'button', id: 'sync-unlink', text: 'Unlink', onclick: (e) => unlinkImport(e.currentTarget, source) }),
    ));
  } else {
    const input = el('input', { id: 'sync-url', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'webcal://… or https://…', 'aria-describedby': 'sync-url-help' });
    const message = el('div', { id: 'sync-message', class: 'form-msg', role: 'alert', hidden: true });
    const submit = el('button', { class: 'btn btn-primary small', type: 'submit', id: 'sync-link', text: 'Link my calendar' });
    const form = el('form', { class: 'sync-form', novalidate: true },
      el('div', { class: 'field' }, el('label', { for: 'sync-url', text: "Your calendar's private link" }), input),
      message,
      el('div', { class: 'row' }, submit),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      linkImport(input, submit, message);
    });
    inn.append(
      el('p', { text: "Times that are busy in your own calendar can't be booked on the website, so nobody books you twice. Only the times are read, never what your appointments are. It's checked every 15 minutes." }),
      form,
      el('div', { id: 'sync-url-help', class: 'sync-help' },
        el('p', { class: 'hint', text: 'Where to find the link on iPhone:' }),
        el('ol', {},
          el('li', { text: 'Open Calendar and tap Calendars.' }),
          el('li', { text: 'Tap ⓘ next to the calendar your appointments are in.' }),
          el('li', { text: 'Turn on Public Calendar, tap Share Link, then Copy.' }),
          el('li', { text: 'Paste it here.' }),
        ),
        device !== 'iphone' && el('p', { class: 'hint', text: "Linking from a different phone? Copy the link on the iPhone, send it to yourself on WhatsApp, and paste it here." }),
        el('p', { class: 'hint', text: "Only someone with the link can see that calendar, and the website keeps it private. In Google Calendar (on a computer), use Settings, your calendar, then Secret address in iCal format. Events marked Free don't block anything." }),
      ),
    );
  }
  $('sync-body').replaceChildren(out, inn);
}

async function copyFeedLink(button, link) {
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied.');
  } catch {
    // No clipboard: show the link so it can be copied by hand.
    const field = el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Calendar link', onfocus: (e) => e.currentTarget.select() });
    button.closest('.sync-part').querySelector('input[readonly]')?.remove();
    button.closest('.row').after(field);
    field.focus();
  }
}

async function resetFeedLink(button) {
  const ok = await askConfirm({
    title: 'Make a new link?',
    message: 'The old link stops working straight away, so any calendar using it stops getting bookings. Add the new link to your calendar again afterwards.',
    confirmLabel: 'Make a new link',
  });
  if (!ok) return;
  await withBusy([button], async () => {
    try {
      const data = await api('POST', '/api/admin/calendar-sync/feed-reset', {});
      renderSync({ ...sync.data, feed: data.feed });
      toast('New link made. Add it to your calendar again.');
    } catch (err) {
      handleError(err);
    }
  });
}

async function linkImport(input, button, message) {
  const url = input.value.trim();
  const say = (text) => {
    message.textContent = text;
    message.hidden = !text;
  };
  if (!/^(?:webcals?|https?):\/\/\S+$/i.test(url)) {
    say('Paste the whole link, starting with webcal:// or https://.');
    input.focus();
    return;
  }
  say('');
  await withBusy([button, input], async () => {
    button.textContent = 'Reading your calendar…';
    try {
      const data = await api('POST', '/api/admin/calendar-sync/import', { url });
      renderSync({ ...sync.data, import: data.import });
      toast('Calendar linked. Its busy times are now blocked on the website.');
      state.loadedAt.calendar = 0;
      loadCalendar();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        say(err.message);
        input.focus();
        return;
      }
      handleError(err);
    } finally {
      button.textContent = 'Link my calendar';
    }
  });
}

async function syncImportNow(button) {
  await withBusy([button], async () => {
    try {
      const data = await api('POST', '/api/admin/calendar-sync/sync', {});
      renderSync({ ...sync.data, import: data.import });
      if (data.import?.ok) toast('Checked. The website is up to date with your calendar.');
      loadCalendar();
    } catch (err) {
      handleError(err);
    }
  });
}

async function unlinkImport(button, source) {
  const ok = await askConfirm({
    title: 'Unlink your calendar?',
    message: `The website stops reading your ${source} calendar, and its busy times are no longer blocked. Bookings still go to your calendar app.`,
    confirmLabel: 'Unlink',
  });
  if (!ok) return;
  await withBusy([button], async () => {
    try {
      const data = await api('DELETE', '/api/admin/calendar-sync/import');
      renderSync({ ...sync.data, import: data.import });
      toast('Unlinked.');
      loadCalendar();
    } catch (err) {
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
  const rating = Math.min(5, Math.max(1, Math.round(Number(r.rating) || 1)));
  const created = localStamp(r.createdAt);
  const card = el('article', { class: 'card', 'aria-label': `Review by ${r.name}` },
    el('div', { class: 'review-head' },
      el('span', { class: 'stars', role: 'img', 'aria-label': `${rating} out of 5 stars`, text: '★'.repeat(rating) + '☆'.repeat(5 - rating) }),
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
      else if (err.status === 503) showSetup('No admin password has been set yet. Enter your setup code, then choose the password.');
      else loginError(err.message);
      input.select();
    }
  });
}

// A new password, set with a one-time setup code (the first one, or a forgotten one).
function showSetup(intro) {
  $('login-form').hidden = true;
  $('setup-form').hidden = false;
  $('setup-message').hidden = true;
  $('setup-intro').textContent = intro || 'Enter your setup code, then choose the admin password.';
  $('setup-code').focus();
}

function showLoginForm() {
  $('setup-form').hidden = true;
  $('login-form').hidden = false;
  $('login-message').hidden = true;
  $('password').focus();
}

function setupError(text, focus) {
  const box = $('setup-message');
  box.textContent = text;
  box.hidden = false;
  if (focus) $(focus).focus();
}

async function setPassword(event) {
  event.preventDefault();
  const code = $('setup-code').value.trim();
  const password = $('new-password').value;
  if (!code) return setupError('Enter the setup code.', 'setup-code');
  if ([...password].length < 12) return setupError('Choose a password of at least 12 characters.', 'new-password');
  if (password !== $('new-password-2').value) return setupError("The two passwords don't match. Type them again.", 'new-password-2');
  return withBusy([$('setup-button')], async () => {
    try {
      await api('POST', '/api/admin/setup', { code, password });
      for (const id of ['setup-code', 'new-password', 'new-password-2']) $(id).value = '';
      $('show-new-password').checked = false;
      for (const id of ['new-password', 'new-password-2']) $(id).type = 'password';
      $('setup-form').hidden = true;
      $('login-form').hidden = false;
      const session = await api('GET', '/api/admin/session');
      state.tab = 'requests';
      enterApp(session);
      toast('Password set. Use it to log in on your other devices.');
    } catch (err) {
      if (!(err instanceof ApiError)) setupError('Something went wrong. Please try again.');
      else if (err.status === 429) setupError(`Too many attempts. Please wait ${formatWait(err.retryAfter)} and try again.`);
      else if (err.status === 400 && err.body.field === 'password') setupError(err.message, 'new-password');
      else if (err.status === 400 || err.status === 403) setupError(err.message, 'setup-code');
      else setupError(err.message || 'Something went wrong. Please try again.');
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

// ---------------------------------------------------------------- website

// The Website tab: services and prices, photos, contact details and text.
// Each change is saved straight to the site, which shows it within seconds
// (src/content.js). An open form is never thrown away by a refresh.

const CARD_ORDER = ['makeup', 'hair', 'package', 'bride', 'bridesmaid'];
const CARD_LABELS = { makeup: 'Makeup', hair: 'Hair', package: 'Bridal package', bride: 'Bride', bridesmaid: 'Bridesmaid' };
const ALBUM_ORDER = ['looks', 'before_after'];
const ALBUM_LABELS = { looks: 'Photos', before_after: 'Before & after' };
const DEFAULT_ALT = { looks: 'Makeup by OMG – Oh! My Glam', before_after: 'Before and after: makeup by OMG – Oh! My Glam' };
const TEXT_FIELDS = ['phone', 'instagram', 'facebook_url', 'facebook_name', 'area', 'tagline', 'home_calls', 'bridal_note'];
const DURATIONS = Array.from({ length: 48 }, (_, i) => (i + 1) * 15);
const site = { data: null, view: 'services', editing: null, describing: null, selected: null, uploading: 0 };

const byOrder = (a, b) => a.sort - b.sort || String(a.id).localeCompare(String(b.id));
const servicesIn = (card) => site.data.services.filter((s) => s.card === card).sort(byOrder);
const photosIn = (album) => site.data.photos.filter((p) => p.album === album).sort(byOrder);

async function loadWebsite() {
  if (site.editing || site.describing || site.uploading) return;
  const seq = ++state.seq.website;
  const body = $('site-body');
  if (!site.data) loading(body);
  try {
    const data = await api('GET', '/api/admin/site');
    if (seq !== state.seq.website) return;
    site.data = { services: data.services || [], photos: data.photos || [], text: data.text || {} };
    state.loadedAt.website = Date.now();
    renderWebsite();
  } catch (err) {
    if (seq === state.seq.website) loadFailed(body, err, loadWebsite);
  }
}

function showSiteView(view) {
  if (site.uploading) return;
  site.view = view;
  site.editing = null;
  site.describing = null;
  site.selected = null;
  renderWebsite();
  if (Date.now() - state.loadedAt.website > 30_000) loadWebsite();
}

function renderWebsite() {
  for (const b of document.querySelectorAll('#panel-website .subnav button')) b.setAttribute('aria-pressed', String(b.dataset.view === site.view));
  if (!site.data) return;
  const body = $('site-body');
  if (site.view === 'photos') body.replaceChildren(...ALBUM_ORDER.map(albumSection));
  else if (site.view === 'text') body.replaceChildren(textForm());
  else body.replaceChildren(...CARD_ORDER.map(cardSection));
}

function siteField(id, label, control, hint) {
  return el('div', { class: 'field' },
    el('label', { for: id, text: label }),
    control,
    hint ? el('p', { class: 'hint', text: hint }) : null,
    el('p', { class: 'field-error', id: `${id}-error`, hidden: true }));
}

function clearFieldErrors(form) {
  for (const node of form.querySelectorAll('.field-error')) {
    node.textContent = '';
    node.hidden = true;
  }
}

/** Shows the server's message next to its field; false when there is no such field. */
function showFieldError(prefix, field, message) {
  const node = $(`${prefix}-${field}-error`);
  if (!node) return false;
  node.textContent = message;
  node.hidden = false;
  $(`${prefix}-${field}`)?.focus();
  return true;
}

function focusLabelled(label) {
  const target = [...$('site-body').querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label && !b.disabled);
  target?.focus();
}

// ---- services

function cardSection(card) {
  const list = servicesIn(card);
  const rows = list.map((s, i) => (site.editing === s.id ? el('li', {}, serviceForm(s)) : serviceRow(s, i, list)));
  if (site.editing === `new:${card}`) {
    rows.push(el('li', {}, serviceForm({ id: null, card, name: '', price: null, minutes: 60, note: null, level: null, details: null, visible: 1 })));
  }
  return el('section', { class: 'site-card', 'aria-labelledby': `card-${card}` },
    el('div', { class: 'site-card-head' },
      el('h3', { class: 'sub', id: `card-${card}`, text: CARD_LABELS[card] }),
      el('button', {
        class: 'btn btn-ghost small', type: 'button', text: 'Add', 'aria-label': `Add a service to ${CARD_LABELS[card]}`,
        disabled: Boolean(site.editing), onclick: () => openServiceForm(`new:${card}`),
      })),
    rows.length
      ? el('ul', { class: 'svc-rows' }, rows)
      : el('p', { class: 'empty', text: 'Nothing here, so this part of the price list is hidden on the website.' }));
}

function serviceRow(s, i, list) {
  const busy = Boolean(site.editing);
  return el('li', { class: `svc-row${s.visible ? '' : ' is-hidden'}` },
    el('div', { class: 'svc-row-main' },
      el('p', { class: 'svc-row-name', text: s.name }),
      el('p', { class: 'meta', text: [`R${s.price}`, formatDuration(s.minutes), s.visible ? null : 'Hidden'].filter(Boolean).join(' · ') })),
    el('div', { class: 'svc-row-actions' },
      el('button', { class: 'icon-btn', type: 'button', text: '↑', 'aria-label': `Move ${s.name} up`, disabled: busy || i === 0, onclick: (e) => moveService(s, -1, e.currentTarget) }),
      el('button', { class: 'icon-btn', type: 'button', text: '↓', 'aria-label': `Move ${s.name} down`, disabled: busy || i === list.length - 1, onclick: (e) => moveService(s, 1, e.currentTarget) }),
      el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Edit', 'aria-label': `Edit ${s.name}`, disabled: busy, onclick: () => openServiceForm(s.id) })));
}

function openServiceForm(key) {
  site.editing = key;
  renderWebsite();
  $('sf-name')?.focus();
}

function serviceForm(s) {
  const isNew = !s.id;
  const name = el('input', { id: 'sf-name', type: 'text', maxlength: 60, autocomplete: 'off', value: s.name });
  const price = el('input', { id: 'sf-price', type: 'number', inputmode: 'numeric', min: 0, max: 100000, step: 1, value: s.price ?? '' });
  const minutes = el('select', { id: 'sf-minutes' }, DURATIONS.map((m) => el('option', { value: m, text: formatDuration(m), selected: m === s.minutes })));
  const note = el('input', { id: 'sf-note', type: 'text', maxlength: 60, autocomplete: 'off', value: s.note ?? '' });
  const level = el('select', { id: 'sf-level' },
    el('option', { value: '', text: 'None' }),
    [1, 2, 3].map((n) => el('option', { value: n, text: `${n} of 3`, selected: s.level === n })));
  const details = el('textarea', { id: 'sf-details', rows: 8, maxlength: 1000 });
  details.value = s.details ?? '';
  const card = el('select', { id: 'sf-card' }, CARD_ORDER.map((c) => el('option', { value: c, text: CARD_LABELS[c], selected: c === s.card })));
  const visible = el('input', { id: 'sf-visible', type: 'checkbox', checked: Boolean(s.visible) });
  const levelField = siteField('sf-level', 'Glam level', level, 'The small 1-to-3 meter beside makeup services.');
  const detailsField = siteField('sf-details', "What's included", details, 'One item per line. A line ending with a colon starts a heading, e.g. "Makeup:".');
  const showFor = () => {
    levelField.hidden = card.value !== 'makeup';
    detailsField.hidden = card.value !== 'package';
  };
  card.addEventListener('change', showFor);
  showFor();
  const save = el('button', { class: 'btn btn-primary', type: 'submit', text: isNew ? 'Add service' : 'Save' });
  const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: () => { site.editing = null; renderWebsite(); } });
  const del = isNew ? null : el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete' });
  if (del) del.addEventListener('click', () => deleteService(s, del));
  const form = el('form', { class: 'edit-form', novalidate: true, 'aria-label': isNew ? `New service in ${CARD_LABELS[s.card]}` : `Edit ${s.name}` },
    siteField('sf-name', 'Name', name),
    el('div', { class: 'row2' }, siteField('sf-price', 'Price (R)', price), siteField('sf-minutes', 'Takes about', minutes)),
    siteField('sf-note', 'Small note (optional)', note, 'Shown under the service, e.g. "Not compulsory".'),
    levelField,
    detailsField,
    siteField('sf-card', 'Listed under', card),
    el('label', { class: 'check' }, visible, 'Shown on the website and bookable'),
    el('div', { class: 'form-buttons' }, save, cancel, del));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveService(s, form, save);
  });
  return form;
}

async function saveService(s, form, button) {
  clearFieldErrors(form);
  const card = $('sf-card').value;
  const priceText = $('sf-price').value.trim();
  const body = {
    card,
    name: $('sf-name').value,
    price: /^\d+$/.test(priceText) ? Number(priceText) : -1,
    minutes: Number($('sf-minutes').value),
    note: $('sf-note').value.trim() || null,
    level: card === 'makeup' && $('sf-level').value ? Number($('sf-level').value) : null,
    details: card === 'package' ? $('sf-details').value : null,
    visible: $('sf-visible').checked,
  };
  await withBusy([button], async () => {
    try {
      const data = s.id
        ? await api('POST', `/api/admin/site/services/${encodeURIComponent(s.id)}`, body)
        : await api('POST', '/api/admin/site/services', body);
      site.data.services = [...site.data.services.filter((x) => x.id !== data.service.id), data.service];
      site.editing = null;
      renderWebsite();
      focusLabelled(`Edit ${data.service.name}`);
      toast(s.id ? 'Saved. The website shows it now.' : 'Added. It is on the website now.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.body.field && showFieldError('sf', err.body.field, err.message)) return;
      if (err instanceof ApiError && err.status === 404) {
        site.editing = null;
        loadWebsite();
      }
      handleError(err);
    }
  });
}

async function deleteService(s, button) {
  const ok = await askConfirm({
    title: `Delete ${s.name}?`,
    message: 'It disappears from the website and can no longer be booked. Requests already made keep their details. To take it off for a while instead, untick "Shown on the website".',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  await withBusy([button], async () => {
    try {
      await api('DELETE', `/api/admin/site/services/${encodeURIComponent(s.id)}`);
      site.data.services = site.data.services.filter((x) => x.id !== s.id);
      site.editing = null;
      renderWebsite();
      toast(`${s.name} deleted.`);
    } catch (err) {
      handleError(err);
    }
  });
}

async function moveService(s, step, button) {
  const list = servicesIn(s.card);
  const i = list.findIndex((x) => x.id === s.id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await withBusy([button], async () => {
    try {
      await api('POST', '/api/admin/site/services-order', { card: s.card, ids: list.map((x) => x.id) });
      list.forEach((x, k) => { x.sort = k + 1; });
      renderWebsite();
      focusLabelled(`Move ${s.name} ${step < 0 ? 'up' : 'down'}`);
    } catch (err) {
      handleError(err);
      loadWebsite();
    }
  });
}

// ---- photos

function albumSection(album) {
  const photos = photosIn(album);
  const busy = site.uploading > 0 || Boolean(site.describing);
  const picker = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, id: `pick-${album}` });
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    addPhotos(album, files);
  });
  const index = photos.findIndex((p) => p.id === site.selected);
  return el('section', { class: 'site-card', 'aria-labelledby': `album-${album}` },
    el('div', { class: 'site-card-head' },
      el('h3', { class: 'sub', id: `album-${album}`, text: ALBUM_LABELS[album] }),
      el('button', {
        class: 'btn btn-primary small', type: 'button', text: 'Add photos', 'aria-label': `Add photos to ${ALBUM_LABELS[album]}`,
        disabled: busy, onclick: () => picker.click(),
      })),
    picker,
    el('p', { class: 'upload-status', id: `upload-status-${album}`, role: 'status', hidden: true }),
    photos.length
      ? el('ul', { class: 'photo-grid' }, photos.map((p, i) => el('li', {},
        el('button', {
          class: 'photo-thumb', type: 'button', 'aria-pressed': String(p.id === site.selected),
          'aria-label': `Photo ${i + 1}: ${p.alt}`, disabled: busy, onclick: () => selectPhoto(p),
        }, el('img', { src: p.src_small, alt: '', width: p.small_width, height: Math.max(1, Math.round((p.height * p.small_width) / p.width)), loading: 'lazy', decoding: 'async' })))))
      : el('p', { class: 'empty', text: 'No photos yet, so this part of "the glam" is hidden on the website.' }),
    index >= 0
      ? photoPanel(photos[index], index, photos)
      : (photos.length ? el('p', { class: 'hint', text: 'Tap a photo to describe, move or delete it.' }) : null));
}

function selectPhoto(p) {
  site.selected = site.selected === p.id ? null : p.id;
  site.describing = null;
  renderWebsite();
  if (site.selected) $('site-body').querySelector('.photo-panel button')?.focus();
}

function photoPanel(p, i, list) {
  if (site.describing === p.id) return el('div', { class: 'photo-panel' }, describeForm(p));
  const del = el('button', { class: 'btn btn-danger small', type: 'button', text: 'Delete', 'aria-label': `Delete photo: ${p.alt}` });
  del.addEventListener('click', () => deletePhoto(p, del));
  return el('div', { class: 'photo-panel', role: 'group', 'aria-label': `Photo ${i + 1} of ${list.length}` },
    el('p', { class: 'photo-alt', text: p.alt }),
    el('div', { class: 'form-buttons' },
      el('button', { class: 'btn btn-ghost small', type: 'button', text: '← Earlier', 'aria-label': `Move earlier: ${p.alt}`, disabled: i === 0, onclick: (e) => movePhoto(p, -1, e.currentTarget) }),
      el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Later →', 'aria-label': `Move later: ${p.alt}`, disabled: i === list.length - 1, onclick: (e) => movePhoto(p, 1, e.currentTarget) }),
      el('button', {
        class: 'btn btn-ghost small', type: 'button', text: 'Describe', 'aria-label': `Describe photo: ${p.alt}`,
        onclick: () => { site.describing = p.id; renderWebsite(); $('pf-alt')?.focus(); },
      }),
      del));
}

function describeForm(p) {
  const input = el('textarea', { id: 'pf-alt', rows: 3, maxlength: 160 });
  input.value = p.alt;
  const save = el('button', { class: 'btn btn-primary small', type: 'submit', text: 'Save' });
  const form = el('form', { class: 'edit-form', novalidate: true },
    siteField('pf-alt', 'What the photo shows', input, 'Read out to people who can’t see it, and used by Google. E.g. "Soft glam with a nude lip".'),
    el('div', { class: 'form-buttons' }, save,
      el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Cancel', onclick: () => { site.describing = null; renderWebsite(); } })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    await withBusy([save], async () => {
      try {
        const data = await api('POST', `/api/admin/site/photos/${p.id}`, { alt: input.value });
        Object.assign(p, data.photo);
        site.describing = null;
        renderWebsite();
        toast('Description saved.');
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && err.body.field && showFieldError('pf', err.body.field, err.message)) return;
        handleError(err);
      }
    });
  });
  return form;
}

async function deletePhoto(p, button) {
  const ok = await askConfirm({ title: 'Delete this photo?', message: 'It disappears from the website.', confirmLabel: 'Delete' });
  if (!ok) return;
  await withBusy([button], async () => {
    try {
      await api('DELETE', `/api/admin/site/photos/${p.id}`);
      site.data.photos = site.data.photos.filter((x) => x.id !== p.id);
      site.selected = null;
      renderWebsite();
      toast('Photo deleted.');
    } catch (err) {
      handleError(err);
    }
  });
}

async function movePhoto(p, step, button) {
  const list = photosIn(p.album);
  const i = list.findIndex((x) => x.id === p.id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await withBusy([button], async () => {
    try {
      await api('POST', '/api/admin/site/photos-order', { album: p.album, ids: list.map((x) => x.id) });
      list.forEach((x, k) => { x.sort = k + 1; });
      renderWebsite();
      focusLabelled(`Move ${step < 0 ? 'earlier' : 'later'}: ${p.alt}`);
    } catch (err) {
      handleError(err);
      loadWebsite();
    }
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** One copy of the photo, no larger than the box, as WebP (or JPEG where WebP can't be made). */
async function encodePhoto(img, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await toBlob('image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.85);
  if (!blob) throw new Error('encode');
  return { blob, width, height, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' };
}

/**
 * Phone photos are big: they are shrunk here, on the phone, to a sharp
 * website size and a small copy for phones, before anything is uploaded.
 * The sizes follow how big each album shows a photo: the Photos grid shows
 * two across on a phone, Before & after one across, so each copy is just
 * sharp on a phone's screen and no heavier.
 * (Read as a data: URL, which the admin page's Content-Security-Policy allows.)
 */
const PHOTO_BOXES = {
  looks: { large: [720, 1100], small: [360, 550] },
  before_after: { large: [1080, 1660], small: [720, 1100] },
};

async function preparePhoto(file, album) {
  if (file.size > 40 * 1024 * 1024) throw new ApiError(413, { message: 'That file is too large. Choose a photo from your gallery.' });
  const img = new Image();
  img.src = await readAsDataUrl(file);
  await img.decode();
  if (img.naturalWidth < 300 || img.naturalHeight < 300) throw new ApiError(400, { message: 'That photo is too small. Choose one at least 300 pixels across.' });
  const box = PHOTO_BOXES[album] || PHOTO_BOXES.before_after;
  return { large: await encodePhoto(img, ...box.large), small: await encodePhoto(img, ...box.small) };
}

async function sendPhoto(album, prepared, alt) {
  const form = new FormData();
  form.append('album', album);
  form.append('alt', alt);
  form.append('width', String(prepared.large.width));
  form.append('height', String(prepared.large.height));
  form.append('small_width', String(prepared.small.width));
  form.append('large', prepared.large.blob, `large.${prepared.large.ext}`);
  form.append('small', prepared.small.blob, `small.${prepared.small.ext}`);
  let res;
  try {
    res = await fetch('/api/admin/site/photos', { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
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
    throw new ApiError(res.status, { ...(data || {}), retryAfter: Number(res.headers.get('retry-after')) || Number(data && data.retryAfter) || 0 });
  }
  return data.photo;
}

async function addPhotos(album, files) {
  if (!files.length) return;
  site.uploading += 1;
  renderWebsite();
  let added = 0;
  try {
    for (const [i, file] of files.entries()) {
      const status = $(`upload-status-${album}`);
      if (status) {
        status.hidden = false;
        status.textContent = files.length > 1 ? `Adding photo ${i + 1} of ${files.length}…` : 'Adding the photo…';
      }
      try {
        const photo = await sendPhoto(album, await preparePhoto(file, album), DEFAULT_ALT[album]);
        site.data.photos.push(photo);
        added += 1;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          sessionEnded();
          return;
        }
        const what = files.length > 1 ? `Photo ${i + 1}: ` : '';
        if (err instanceof ApiError && err.status === 429) showBanner(what + rateLimitText(err));
        else if (err instanceof ApiError) showBanner(what + (err.message || 'That photo could not be added.'));
        else showBanner(`${what}That photo couldn’t be read here. Try a JPEG photo from your gallery.`);
      }
    }
  } finally {
    site.uploading -= 1;
    renderWebsite();
    if (added) toast(added === 1 ? 'Photo added. Tap Describe to say what it shows.' : `${added} photos added. Tap Describe on each to say what it shows.`);
  }
}

// ---- contact and text

function formatPhoneForInput(digits) {
  const d = String(digits || '');
  if (!d) return '';
  return /^27\d{9}$/.test(d) ? `+27 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : `+${d}`;
}

function textForm() {
  const t = site.data.text;
  const input = (id, type, value, attrs = {}) => el('input', { id, type, value: value ?? '', autocomplete: 'off', ...attrs });
  const area = (id, value, max) => {
    const node = el('textarea', { id, rows: 3, maxlength: max });
    node.value = value ?? '';
    return node;
  };
  const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' });
  const form = el('form', { class: 'edit-form', novalidate: true, 'aria-label': 'Contact details and text' },
    el('h3', { class: 'sub', text: 'Contact' }),
    siteField('tf-phone', 'WhatsApp and phone number', input('tf-phone', 'tel', formatPhoneForInput(t.phone), { inputmode: 'tel' }), 'Clients book, chat and call on this number.'),
    siteField('tf-instagram', 'Instagram username', input('tf-instagram', 'text', t.instagram ? `@${t.instagram}` : '', { autocapitalize: 'off', spellcheck: 'false' }), 'Leave empty to hide Instagram.'),
    siteField('tf-facebook_url', 'Facebook page link', input('tf-facebook_url', 'url', t.facebook_url, { autocapitalize: 'off', spellcheck: 'false' }), 'Leave empty to hide Facebook.'),
    siteField('tf-facebook_name', 'Name shown for Facebook', input('tf-facebook_name', 'text', t.facebook_name, { maxlength: 60 })),
    siteField('tf-area', 'Area you work in', input('tf-area', 'text', t.area, { maxlength: 28 }), 'Suburb and city, e.g. Soweto, Johannesburg. Shown in Google’s title and at the top of the page.'),
    el('h3', { class: 'sub', text: 'Text' }),
    siteField('tf-tagline', 'Welcome line (top of the page)', area('tf-tagline', t.tagline, 220)),
    siteField('tf-home_calls', 'Home calls note (under the price list)', area('tf-home_calls', t.home_calls, 300)),
    siteField('tf-bridal_note', 'Bridal note (under the bridal prices)', area('tf-bridal_note', t.bridal_note, 300)),
    el('div', { class: 'form-buttons' }, save));
  form.addEventListener('input', () => { site.editing = 'text'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const body = Object.fromEntries(TEXT_FIELDS.map((k) => [k, $(`tf-${k}`).value]));
    await withBusy([save], async () => {
      try {
        const data = await api('POST', '/api/admin/site/text', body);
        Object.assign(site.data.text, data.text);
        site.editing = null;
        renderWebsite();
        toast('Saved. The website shows it now.');
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && err.body.field && showFieldError('tf', err.body.field, err.message)) return;
        handleError(err);
      }
    });
  });
  return form;
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('login-form').addEventListener('submit', login);
  $('setup-form').addEventListener('submit', setPassword);
  $('use-setup-code').addEventListener('click', () => showSetup());
  $('setup-back').addEventListener('click', showLoginForm);
  $('show-new-password').addEventListener('change', (e) => {
    for (const id of ['new-password', 'new-password-2']) $(id).type = e.target.checked ? 'text' : 'password';
  });
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
  $('refresh-calendar').addEventListener('click', () => { loadCalendar(); loadSync(); });
  $('refresh-reviews').addEventListener('click', () => { loadReviews(); refreshCounts(); });
  for (const b of document.querySelectorAll('#panel-website .subnav button')) b.addEventListener('click', () => showSiteView(b.dataset.view));

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
