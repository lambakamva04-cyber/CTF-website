// The booking calendar: pick a service, a day and a free time, then send the
// request. It is saved for OMG to confirm on the admin page and goes to her on
// WhatsApp with the four details she asked for.
//
// Slot maths and the booking rules come from the same modules the Worker
// uses, and the services from the same rows it checks bookings against (a
// JSON block it writes into the page), so the page can never offer a time
// the server would refuse.

import {
  BOOKING_WINDOW, HOURS, SERVICE_GROUPS, UTC_OFFSET_MINUTES, WHATSAPP_NUMBER,
  bookingMessage, formatDateLong, formatDuration, formatMonth, whatsappUrl,
} from './catalog.js';
import {
  addDays, addMonths, datesInMonth, monthOf, notBeforeFor, nowInZone,
  parseRanges, startTimes, toHHMM, toMinutes, weekday,
} from './slots.js';

/** The services on offer and OMG's WhatsApp number, as the Worker wrote them. */
function readCatalog() {
  try {
    const data = JSON.parse(document.getElementById('omg-catalog')?.textContent || '{}');
    const services = Array.isArray(data.services) ? data.services.filter((s) =>
      s && typeof s.id === 'string' && typeof s.name === 'string' && SERVICE_GROUPS.includes(s.group)
      && Number.isInteger(s.price) && Number.isInteger(s.minutes) && s.minutes > 0) : [];
    const phone = typeof data.phone === 'string' && /^\d{9,15}$/.test(data.phone) ? data.phone : WHATSAPP_NUMBER;
    return { services, phone };
  } catch {
    return { services: [], phone: WHATSAPP_NUMBER };
  }
}

const root = document.getElementById('booker');
const CATALOG = readCatalog();
// With nothing bookable (or the block missing), the calendar stays hidden and
// the WhatsApp links on the page do the booking.
if (root && CATALOG.services.length) setUp(root);

function setUp(root) {
  const SERVICES = CATALOG.services;
  const findService = (id) => SERVICES.find((s) => s.id === id);
  root.hidden = false;
  const $ = (id) => document.getElementById(id);
  const el = {
    service: $('bk-service'), serviceInfo: $('bk-service-info'),
    month: $('bk-month'), prev: $('bk-prev'), next: $('bk-next'), days: $('bk-days'), calNote: $('bk-cal-note'),
    timesStep: $('bk-times-step'), timesTitle: $('bk-times-title'), times: $('bk-times'), timesNote: $('bk-times-note'),
    form: $('bk-form'), summary: $('bk-summary'), name: $('bk-name'), phone: $('bk-phone'), company: $('bk-hp'),
    submit: $('bk-submit'), formNote: $('bk-form-note'), done: $('bk-done'), status: $('bk-status'),
  };
  const OPEN = toMinutes(HOURS.open);
  const CLOSE = toMinutes(HOURS.close);
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const startedAt = performance.now();

  const state = {
    service: SERVICES[0],
    clock: nowInZone(UTC_OFFSET_MINUTES), // replaced by the server's clock on the first load
    month: null,
    date: null,
    time: null,
    cache: new Map(),
    started: false,
    sending: false,
  };
  state.month = monthOf(state.clock.date);

  // ---- service picker ---------------------------------------------------------
  for (const group of SERVICE_GROUPS) {
    const inGroup = SERVICES.filter((x) => x.group === group);
    if (!inGroup.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const s of inGroup) optgroup.append(new Option(`${s.name} · R${s.price}`, s.id));
    el.service.append(optgroup);
  }
  el.service.addEventListener('change', () => chooseService(el.service.value));

  function chooseService(id, { announce = false } = {}) {
    const service = findService(id);
    if (!service) return;
    state.service = service;
    el.service.value = service.id;
    el.serviceInfo.textContent = `Takes about ${formatDuration(service.minutes)} · R${service.price}`;
    state.time = null;
    renderMonth();
    renderTimes();
    renderForm();
    if (announce) say(`${service.name} selected. Pick a day.`);
  }

  // ---- loading availability ---------------------------------------------------
  async function load(month, { fresh = false } = {}) {
    if (!fresh && state.cache.has(month)) return;
    const res = await fetch(`/api/availability?month=${encodeURIComponent(month)}`, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      const error = new Error('availability');
      error.message = (data && data.message) || 'We could not load the calendar just now.';
      throw error;
    }
    state.clock = { date: data.today, minutes: toMinutes(data.now) };
    state.cache.set(month, data.busy || {});
  }

  async function showMonth(month, { fresh = false } = {}) {
    state.month = month;
    renderMonth();
    if (state.cache.has(month) && !fresh) return;
    el.days.setAttribute('aria-busy', 'true');
    el.calNote.hidden = true;
    try {
      await load(month, { fresh });
      if (state.month === month) renderMonth();
    } catch (error) {
      if (state.month === month) showCalendarError(error.message);
    } finally {
      el.days.removeAttribute('aria-busy');
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    chooseService(el.service.value || SERVICES[0].id);
    showMonth(state.month);
  }

  // Load only when the calendar is about to be seen.
  if ('IntersectionObserver' in window) {
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        watcher.disconnect();
        start();
      }
    }, { rootMargin: '600px 0px' });
    watcher.observe(root);
  } else {
    start();
  }

  // ---- the month grid ---------------------------------------------------------
  const lastDay = () => addDays(state.clock.date, BOOKING_WINDOW.maxDaysAhead);
  const inWindow = (date) => date >= state.clock.date && date <= lastDay();

  function slotsFor(date) {
    const busy = parseRanges((state.cache.get(monthOf(date)) || {})[date] || []);
    const notBefore = notBeforeFor(date, state.clock, BOOKING_WINDOW.minNoticeMinutes);
    const slots = startTimes({ busy, minutes: state.service.minutes, open: OPEN, close: CLOSE, step: HOURS.step, notBefore });
    return slots.filter((s) => s.start >= notBefore); // too-soon times are left out, not shown as booked
  }

  const shortDate = (date) => formatDateLong(date).replace(/ \d{4}$/, '');

  function renderMonth() {
    const firstMonth = monthOf(state.clock.date);
    el.month.textContent = formatMonth(state.month);
    el.prev.disabled = state.month <= firstMonth;
    el.next.disabled = state.month >= monthOf(lastDay()) || state.month >= addMonths(firstMonth, 12);
    const loaded = state.cache.get(state.month);
    const dates = datesInMonth(state.month);
    const cells = [];
    for (let i = 0; i < weekday(dates[0]); i += 1) {
      const blank = document.createElement('span');
      blank.className = 'bk-blank';
      blank.setAttribute('aria-hidden', 'true');
      cells.push(blank);
    }
    for (const date of dates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bk-day';
      button.dataset.date = date;
      const number = document.createElement('span');
      number.textContent = String(Number(date.slice(8)));
      button.append(number);
      let label = shortDate(date);
      if (!loaded) {
        button.disabled = true;
        button.classList.add('is-loading');
      } else if (!inWindow(date)) {
        button.disabled = true;
        button.classList.add('is-off');
        label += ', not available';
      } else {
        const slots = slotsFor(date);
        const free = slots.filter((s) => s.free).length;
        if (free) {
          button.classList.add('is-free');
          label += `, ${free} ${free === 1 ? 'time' : 'times'} free`;
        } else if (!slots.length) {
          // Nothing left that is far enough ahead (late today): not "booked".
          button.disabled = true;
          button.classList.add('is-off');
          label += ', no times left';
        } else {
          button.disabled = true;
          button.classList.add('is-full');
          label += ', fully booked';
        }
      }
      if (date === state.clock.date) button.classList.add('is-today');
      const selected = date === state.date;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', label);
      cells.push(button);
    }
    el.days.replaceChildren(...cells);
    if (loaded) el.calNote.hidden = true;
  }

  function showCalendarError(message) {
    el.calNote.hidden = false;
    el.calNote.replaceChildren();
    const text = document.createElement('p');
    text.textContent = `${message} You can try again, or book on WhatsApp instead.`;
    const actions = document.createElement('div');
    actions.className = 'bk-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-ghost';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => showMonth(state.month, { fresh: true }));
    actions.append(retry, whatsappLink('Book on WhatsApp', `Hi OMG! I'd like to book ${state.service.name}.`));
    el.calNote.append(text, actions);
  }

  el.prev.addEventListener('click', () => showMonth(addMonths(state.month, -1)));
  el.next.addEventListener('click', () => showMonth(addMonths(state.month, 1)));

  el.days.addEventListener('click', (event) => {
    const button = event.target.closest('button.bk-day');
    if (!button || button.disabled) return;
    state.date = button.dataset.date;
    state.time = null;
    renderMonth();
    renderTimes();
    renderForm();
    const free = slotsFor(state.date).filter((s) => s.free).length;
    say(`${shortDate(state.date)}: ${free} ${free === 1 ? 'time' : 'times'} free. Pick a time.`);
    reveal(el.timesStep);
  });

  // ---- the times --------------------------------------------------------------
  function renderTimes() {
    if (!state.date) {
      el.timesStep.hidden = true;
      return;
    }
    el.timesStep.hidden = false;
    el.timesTitle.textContent = formatDateLong(state.date);
    const slots = slotsFor(state.date);
    const buttons = slots.map(({ start, free }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bk-time';
      button.dataset.time = toHHMM(start);
      button.textContent = toHHMM(start);
      if (free) {
        button.setAttribute('aria-label', `${toHHMM(start)} to ${toHHMM(start + state.service.minutes)}`);
      } else {
        button.disabled = true;
        button.classList.add('is-taken');
        button.setAttribute('aria-label', `${toHHMM(start)}, booked`);
      }
      const selected = button.dataset.time === state.time;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      return button;
    });
    el.times.replaceChildren(...buttons);
    const anyFree = slots.some((s) => s.free);
    el.timesNote.hidden = anyFree;
    if (!anyFree) el.timesNote.textContent = 'No free times for this service on that day. Try another day.';
  }

  el.times.addEventListener('click', (event) => {
    const button = event.target.closest('button.bk-time');
    if (!button || button.disabled) return;
    state.time = button.dataset.time;
    renderTimes();
    renderForm();
    reveal(el.form);
  });

  // ---- details and sending ----------------------------------------------------
  const endTime = () => toHHMM(toMinutes(state.time) + state.service.minutes);

  function renderForm() {
    const ready = Boolean(state.date && state.time);
    el.form.hidden = !ready;
    if (!ready) return;
    el.summary.textContent = `${state.service.name} (R${state.service.price}) · ${formatDateLong(state.date)} · ${state.time}–${endTime()}`;
    el.done.hidden = true;
  }

  const NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]*[\p{L}\p{M}.])?$/u;
  const tidy = (value) => value.normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();

  function fieldError(input, message) {
    const note = document.getElementById(`${input.id}-error`);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    note.textContent = message || '';
    note.hidden = !message;
  }

  function checkFields() {
    const name = tidy(el.name.value);
    const phone = tidy(el.phone.value);
    const words = name.split(' ').filter((w) => /\p{L}/u.test(w)).length;
    const digits = phone.replace(/\D/g, '').length;
    const nameError = name.length < 3 || name.length > 80 || !NAME_RE.test(name) || words < 2 ? 'Please enter your name and surname.' : '';
    const phoneError = phone.length > 25 || !/^\+?[0-9 ()-]+$/.test(phone) || digits < 9 || digits > 15 ? 'Please enter a phone number we can reach you on.' : '';
    fieldError(el.name, nameError);
    fieldError(el.phone, phoneError);
    if (nameError) el.name.focus();
    else if (phoneError) el.phone.focus();
    return nameError || phoneError ? null : { name, phone };
  }

  el.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.sending) return;
    el.formNote.hidden = true;
    const details = checkFields();
    if (!details) return;
    const request = { ...details, service: state.service.id, date: state.date, time: state.time };
    state.sending = true;
    el.submit.disabled = true;
    el.submit.textContent = 'Sending…';
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...request, company: el.company.value, elapsed: Math.round(performance.now() - startedAt) }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 201 && data && data.ok) {
        showDone(data);
      } else if (res.status === 409) {
        state.time = null;
        await showMonth(state.month, { fresh: true });
        renderTimes();
        renderForm();
        say('Sorry, that time has just been booked. Please pick another.');
        reveal(el.timesStep);
      } else if (res.status === 400 && data && (data.field === 'name' || data.field === 'phone')) {
        fieldError(data.field === 'name' ? el.name : el.phone, data.message);
      } else {
        showFallback(request, data && data.message);
      }
    } catch {
      showFallback(request);
    } finally {
      state.sending = false;
      el.submit.disabled = false;
      el.submit.textContent = 'Request this time';
    }
  });

  for (const input of [el.name, el.phone]) input.addEventListener('input', () => fieldError(input, ''));

  function whatsappLink(text, message) {
    const link = document.createElement('a');
    link.className = 'btn btn-gold';
    link.href = whatsappUrl(message, CATALOG.phone);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = text;
    return link;
  }

  function showFallback(request, message) {
    el.formNote.hidden = false;
    el.formNote.replaceChildren();
    const text = document.createElement('p');
    text.textContent = `${message || 'We could not send your request just now.'} Send it on WhatsApp instead and OMG will confirm your time there.`;
    const link = whatsappLink('Send on WhatsApp', bookingMessage({ ...request, service: state.service }));
    el.formNote.append(text, link);
    link.focus();
  }

  function showDone(data) {
    el.form.hidden = true;
    el.done.hidden = false;
    el.done.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'Almost done: send it on WhatsApp';
    const lead = document.createElement('p');
    lead.textContent = 'Tap the button to send your request to OMG. Your time is confirmed once OMG replies.';
    const list = document.createElement('dl');
    for (const [term, value] of [
      ['Name and Surname', data.summary.name],
      ['Contact Number', data.summary.phone],
      ['Service', data.summary.service],
      ['Date and Time', data.summary.when],
      ['Reference', data.ref],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    const send = document.createElement('a');
    send.className = 'btn btn-gold bk-send';
    send.href = data.whatsappUrl;
    send.target = '_blank';
    send.rel = 'noopener';
    send.textContent = 'Send on WhatsApp';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-ghost';
    again.textContent = 'Book another time';
    again.addEventListener('click', () => {
      state.date = null;
      state.time = null;
      el.done.hidden = true;
      renderMonth();
      renderTimes();
      renderForm();
      root.scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' });
    });
    const actions = document.createElement('div');
    actions.className = 'bk-actions';
    actions.append(send, again);
    el.done.append(title, lead, list, actions);
    say('Request ready. Send it on WhatsApp to finish.');
    reveal(el.done);
    send.focus({ preventScroll: true });
  }

  // ---- helpers ----------------------------------------------------------------
  function say(message) {
    el.status.textContent = '';
    requestAnimationFrame(() => { el.status.textContent = message; });
  }

  // On a phone the next step can be below the fold: bring it into view.
  function reveal(target) {
    const box = target.getBoundingClientRect();
    if (box.top < 70 || box.bottom > innerHeight) {
      target.scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'nearest' });
    }
  }

  // "Book" links on the price lists open the calendar with their service chosen.
  // Without this script they still work: they open WhatsApp.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-service]');
    if (!link || !findService(link.dataset.service)) return;
    event.preventDefault();
    start();
    chooseService(link.dataset.service, { announce: true });
    document.getElementById('book').scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' });
  });

  // Links to #book just scroll there; make sure the calendar is loading.
  document.addEventListener('click', (event) => {
    if (event.target.closest('a[href="#book"]')) start();
  });
}
