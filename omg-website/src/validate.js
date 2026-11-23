// Checks for everything a visitor or the admin sends. Each check either
// returns a clean value or throws a 400 that names the field.

import { isDate, isTime, toMinutes } from '../public/js/slots.js';
import { invalid } from './http.js';

// Control characters, plus invisible and direction-changing characters that
// can disguise text (zero-width spaces, bidi overrides and isolates, BOM).
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁩﻿]/g;

/** Normalises text (NFC), strips hidden characters and tidies whitespace. */
export function clean(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFC').replace(HIDDEN, '');
  if (!multiline) return text.replace(/\s+/g, ' ').trim();
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Length in characters, not UTF-16 units, matching SQLite's length(). */
export const charCount = (text) => [...text].length;

const NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]*[\p{L}\p{M}.])?$/u;
const LINK_RE = /https?:\/\/|www\./i;

/** "Name and Surname" on a booking: two words or more, letters only. */
export function personName(value) {
  const name = clean(value);
  const words = name.split(' ').filter((w) => /\p{L}/u.test(w));
  if (charCount(name) < 3 || charCount(name) > 80 || !NAME_RE.test(name) || words.length < 2) {
    throw invalid('name', 'Please enter your name and surname.');
  }
  return name;
}

/** "Contact Number": 9 to 15 digits, with spaces, + - ( ) allowed. */
export function phoneNumber(value) {
  const phone = clean(value);
  const digits = phone.replace(/\D/g, '').length;
  if (charCount(phone) > 25 || !/^\+?[0-9 ()-]+$/.test(phone) || digits < 9 || digits > 15) {
    throw invalid('phone', 'Please enter a phone number we can reach you on.');
  }
  return phone;
}

/** A service id's shape. Whether it exists, and is shown, is checked against the database. */
export function serviceId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(value)) throw invalid('service', 'Please pick a service.');
  return value;
}

export function dateValue(value, field = 'date') {
  if (!isDate(value)) throw invalid(field, 'Please pick a date.');
  return value;
}

/** A start time from 00:00 to 23:55 (no "24:00"). */
export function startTime(value, field = 'time') {
  if (!isTime(value) || value === '24:00') throw invalid(field, 'Please pick a time.');
  return value;
}

/** A block boundary on a 5-minute mark; "24:00" allowed for the end. */
export function blockTime(value, field) {
  if (!isTime(value) || toMinutes(value) % 5 !== 0) throw invalid(field, 'Use a time on a 5-minute mark.');
  return value;
}

export function reviewName(value) {
  const name = clean(value);
  if (charCount(name) < 2 || charCount(name) > 40 || !NAME_RE.test(name)) {
    throw invalid('name', 'Please enter your name (letters only, up to 40 characters).');
  }
  return name;
}

export function rating(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw invalid('rating', 'Please choose a rating from 1 to 5 stars.');
  }
  return value;
}

export function reviewComment(value) {
  const comment = clean(value, { multiline: true });
  // Short praise ("Amazing!") is a real review: OMG approves each one anyway.
  if (charCount(comment) < 2) throw invalid('comment', 'Please write a few words about your visit.');
  if (charCount(comment) > 500) throw invalid('comment', 'Please keep it to 500 characters.');
  if (LINK_RE.test(comment)) throw invalid('comment', 'Please leave links out of your review.');
  return comment;
}

/** A private admin note: optional, at most 80 characters. */
export function label(value) {
  if (value === undefined || value === null) return null;
  const text = clean(value);
  if (charCount(text) > 80) throw invalid('label', 'Keep the note to 80 characters.');
  return text || null;
}

/**
 * Bots fill the hidden `company` field and submit instantly. Real people
 * leave it empty and take a few seconds.
 */
export function looksAutomated(body) {
  const company = body.company;
  const filled = company !== undefined && company !== null && company !== '' && !(typeof company === 'string' && company.trim() === '');
  const elapsed = body.elapsed;
  return filled || typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 2000;
}
