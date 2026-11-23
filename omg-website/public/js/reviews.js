// Reviews: the approved list with the average out of 5, and the form for a
// new one. New reviews wait for OMG's approval before they show.
//
// Every name and comment is put on the page as text, never as HTML.

import { formatMonth } from './catalog.js';

/** Reviews are rated out of this many stars (the Worker checks the same). */
const MAX_STARS = 5;

const section = document.getElementById('reviews');
if (section) setUp(section);

function setUp(section) {
  document.getElementById('rv-app').hidden = false;
  const $ = (id) => document.getElementById(id);
  const el = {
    summary: $('rv-summary'), list: $('rv-list'), more: $('rv-more'), note: $('rv-list-note'),
    form: $('rv-form'), stars: $('rv-stars'), name: $('rv-name'), comment: $('rv-comment'),
    count: $('rv-count'), company: $('rv-hp'), submit: $('rv-submit'), status: $('rv-status'),
  };
  const startedAt = performance.now();
  let page = 0;
  let loading = false;
  let sending = false;

  const SVG = 'http://www.w3.org/2000/svg';
  function starRow(value, label) {
    const row = document.createElement('span');
    row.className = 'rv-starrow';
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', label);
    for (let i = 1; i <= MAX_STARS; i += 1) {
      const fill = Math.max(0, Math.min(1, value - (i - 1)));
      const star = document.createElementNS(SVG, 'svg');
      star.setAttribute('class', 'rv-star');
      star.setAttribute('viewBox', '0 0 24 24');
      star.setAttribute('aria-hidden', 'true');
      const back = document.createElementNS(SVG, 'use');
      back.setAttribute('href', '#i-star');
      back.setAttribute('class', 'rv-star-back');
      star.append(back);
      if (fill > 0) {
        const id = `rv-clip-${Math.random().toString(36).slice(2)}`;
        const clip = document.createElementNS(SVG, 'clipPath');
        clip.setAttribute('id', id);
        const rect = document.createElementNS(SVG, 'rect');
        rect.setAttribute('width', String(24 * fill));
        rect.setAttribute('height', '24');
        clip.append(rect);
        const front = document.createElementNS(SVG, 'use');
        front.setAttribute('href', '#i-star');
        front.setAttribute('class', 'rv-star-front');
        front.setAttribute('clip-path', `url(#${id})`);
        star.append(clip, front);
      }
      row.append(star);
    }
    return row;
  }

  function renderSummary(data) {
    el.summary.replaceChildren();
    if (!data.count) {
      const empty = document.createElement('p');
      empty.className = 'rv-empty';
      empty.textContent = 'No reviews yet. Had your glam done by OMG? Be the first to leave one.';
      el.summary.append(empty);
      return;
    }
    const score = document.createElement('span');
    score.className = 'rv-score';
    score.textContent = data.average.toFixed(1);
    const out = document.createElement('span');
    out.className = 'rv-outof';
    out.textContent = `out of ${MAX_STARS} · ${data.count} ${data.count === 1 ? 'review' : 'reviews'}`;
    el.summary.append(score, starRow(data.average, `Average ${data.average.toFixed(1)} out of ${MAX_STARS} stars`), out);
  }

  function card(review) {
    const item = document.createElement('li');
    item.className = 'rv-card';
    const head = document.createElement('div');
    head.className = 'rv-card-head';
    const name = document.createElement('strong');
    name.textContent = review.name;
    const when = document.createElement('span');
    when.className = 'rv-date';
    when.textContent = formatMonth(String(review.date).slice(0, 7));
    head.append(name, when);
    const comment = document.createElement('p');
    comment.className = 'rv-comment';
    comment.textContent = review.comment;
    item.append(head, starRow(review.rating, `${review.rating} out of ${MAX_STARS} stars`), comment);
    return item;
  }

  async function loadMore() {
    if (loading) return;
    loading = true;
    el.more.disabled = true;
    el.note.hidden = true;
    try {
      const res = await fetch(`/api/reviews?page=${page + 1}`, { headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) throw new Error((data && data.message) || 'Reviews could not be loaded just now.');
      page = data.page;
      if (page === 1) renderSummary(data);
      el.list.append(...data.reviews.map(card));
      el.more.hidden = !data.hasMore;
    } catch (error) {
      el.note.hidden = false;
      el.note.textContent = error.message;
    } finally {
      loading = false;
      el.more.disabled = false;
    }
  }
  el.more.addEventListener('click', loadMore);

  if ('IntersectionObserver' in window) {
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        watcher.disconnect();
        loadMore();
      }
    }, { rootMargin: '600px 0px' });
    watcher.observe(section);
  } else {
    loadMore();
  }

  // ---- the form ---------------------------------------------------------------
  const ratingInputs = [...el.stars.querySelectorAll('input[name="rating"]')];
  const chosen = () => {
    const input = ratingInputs.find((i) => i.checked);
    return input ? Number(input.value) : 0;
  };
  const paintStars = (value) => { el.stars.dataset.value = String(value); };
  for (const input of ratingInputs) {
    input.addEventListener('change', () => {
      paintStars(chosen());
      fieldError('rating', '');
    });
  }
  el.stars.addEventListener('mouseover', (event) => {
    const label = event.target.closest('label');
    if (label) paintStars(Number(label.dataset.value));
  });
  el.stars.addEventListener('mouseleave', () => paintStars(chosen()));

  const updateCount = () => {
    const length = [...el.comment.value].length;
    el.count.textContent = `${length} / 500`;
    el.count.classList.toggle('is-over', length > 500);
  };
  el.comment.addEventListener('input', () => {
    updateCount();
    fieldError('comment', '');
  });
  el.name.addEventListener('input', () => fieldError('name', ''));
  // A fixed mistake clears the note by the Send button too.
  el.form.addEventListener('input', () => {
    if (el.status.classList.contains('is-bad') && !sending) {
      el.status.className = 'rv-status';
      el.status.textContent = '';
    }
  });
  updateCount();

  function fieldError(field, message) {
    const note = $(`rv-${field}-error`);
    note.textContent = message || '';
    note.hidden = !message;
    const input = field === 'rating' ? el.stars : field === 'name' ? el.name : el.comment;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  const tidy = (value, multiline) => {
    const text = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '');
    return multiline ? text.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s+/g, ' ').trim();
  };
  const NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]*[\p{L}\p{M}.])?$/u;

  el.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    const rating = chosen();
    const name = tidy(el.name.value, false);
    const comment = tidy(el.comment.value, true);
    const errors = {
      rating: rating ? '' : `Please choose 1 to ${MAX_STARS} stars.`,
      name: [...name].length >= 2 && [...name].length <= 40 && NAME_RE.test(name) ? '' : 'Please enter your name (letters only, up to 40 characters).',
      comment: [...comment].length < 2 ? 'Please write a few words about your visit.'
        : [...comment].length > 500 ? 'Please keep it to 500 characters.'
          : /https?:\/\/|www\./i.test(comment) ? 'Please leave links out of your review.' : '',
    };
    for (const [field, message] of Object.entries(errors)) fieldError(field, message);
    const first = Object.keys(errors).find((f) => errors[f]);
    if (first) {
      // Also by the Send button, where the eye is: on a phone the field's own note can be off screen.
      el.status.className = 'rv-status is-bad';
      el.status.textContent = errors[first];
      const field = first === 'rating' ? ratingInputs[0] : first === 'name' ? el.name : el.comment;
      field.focus({ preventScroll: true });
      (first === 'rating' ? el.stars : field).scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    sending = true;
    el.submit.disabled = true;
    el.submit.textContent = 'Sending…';
    el.status.className = 'rv-status';
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name, rating, comment, company: el.company.value, elapsed: Math.round(performance.now() - startedAt) }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 201 && data && data.ok) {
        el.form.reset();
        paintStars(0);
        updateCount();
        el.status.classList.add('is-good');
        el.status.textContent = 'Thank you! Your review will appear once it has been approved.';
      } else if (res.status === 400 && data && ['rating', 'name', 'comment'].includes(data.field)) {
        fieldError(data.field, data.message);
      } else {
        el.status.classList.add('is-bad');
        el.status.textContent = (data && data.message) || 'Your review could not be sent just now. Please try again later.';
      }
    } catch {
      el.status.classList.add('is-bad');
      el.status.textContent = 'Your review could not be sent just now. Please check your connection and try again.';
    } finally {
      sending = false;
      el.submit.disabled = false;
      el.submit.textContent = 'Send review';
    }
  });
}
