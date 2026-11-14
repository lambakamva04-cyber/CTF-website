// The booking catalogue: what can be booked, how long each service takes, the
// opening hours, and the WhatsApp message a booking sends.
//
// This one file is loaded by the website (to draw the calendar) and bundled
// into the Worker (to check every booking request), so the two can never
// disagree. Change a price, a duration or the hours here and both follow.

/** OMG's WhatsApp number, international format without the plus. */
export const WHATSAPP_NUMBER = '27785767604';

/** South Africa does not change its clocks, so SAST is always UTC+2. */
export const UTC_OFFSET_MINUTES = 120;

/**
 * Opening hours, every day. `open` is the earliest start; every appointment
 * must be finished by `close`. Days off and other gaps are blocked from the
 * admin page, not here.
 */
export const HOURS = {
  open: '06:00',
  close: '18:00',
  /** Minutes between the start times a client can pick. */
  step: 30,
};

export const BOOKING_WINDOW = {
  /** The earliest bookable start is this long after now. */
  minNoticeMinutes: 180,
  /** How far ahead the calendar goes. Weddings get booked a long way out. */
  maxDaysAhead: 365,
};

/**
 * Everything a client can book. `minutes` is how long the appointment blocks
 * the calendar. The durations are starting estimates: set them to the real
 * times. Prices match the price list on the page.
 */
export const SERVICES = [
  { id: 'soft-glam', group: 'Makeup', name: 'Soft Glam', price: 750, minutes: 90 },
  { id: 'full-glam', group: 'Makeup', name: 'Full Glam', price: 850, minutes: 90 },
  { id: 'bold-dramatic', group: 'Makeup', name: 'Bold / Dramatic', price: 950, minutes: 120 },
  { id: 'basic-installation', group: 'Hair', name: 'Basic Installation', price: 400, minutes: 90 },
  { id: 'curling-long-weave', group: 'Hair', name: 'Curling Long Weave', price: 450, minutes: 90 },
  { id: 'bridal-package', group: 'Bridal', name: 'Bridal Package', price: 4500, minutes: 300 },
  { id: 'bridal-makeup-leave', group: 'Bridal', name: 'Bridal makeup & leave immediately', price: 1800, minutes: 120 },
  { id: 'bridal-makeup-install-style', group: 'Bridal', name: 'Bridal makeup, installation + style & leave', price: 2900, minutes: 210 },
  { id: 'bridal-natural-hairstyle', group: 'Bridal', name: 'Bridal natural hairstyle', price: 850, minutes: 90 },
  { id: 'bridal-trial', group: 'Bridal', name: 'Bridal trial makeup', price: 750, minutes: 90 },
  { id: 'bridesmaid-strip-lashes', group: 'Bridesmaid', name: 'Bridesmaid full glam with strip lashes', price: 850, minutes: 90 },
  { id: 'bridesmaid-cut-crease', group: 'Bridesmaid', name: 'Bridesmaid full glam with cut crease', price: 950, minutes: 120 },
];

/** The groups, in the order the booking form lists them. */
export const SERVICE_GROUPS = ['Makeup', 'Hair', 'Bridal', 'Bridesmaid'];

/** @returns {typeof SERVICES[number] | undefined} */
export function findService(id) {
  return SERVICES.find((s) => s.id === id);
}

/** "Full Glam (R850)" */
export function serviceLabel(service) {
  return `${service.name} (R${service.price})`;
}

/** "1 h 30 min", "2 h", "45 min" */
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-12-12" → "Saturday 12 December 2026". Expects a valid date. */
export function formatDateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-12" → "December 2026" */
export function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * The WhatsApp message a booking request sends to OMG. The four details are
 * labelled exactly as OMG asked for them. `ref` links the message to the
 * request on the admin page; it is left out when there is none.
 */
export function bookingMessage({ name, phone, service, date, time, ref }) {
  const lines = [
    "Hi OMG! I'd like to book an appointment.",
    '',
    `Name and Surname: ${name}`,
    `Contact Number: ${phone}`,
    `Service: ${serviceLabel(service)}`,
    `Date and Time: ${formatDateLong(date)} at ${time}`,
  ];
  if (ref) lines.push('', `Ref: ${ref}`);
  return lines.join('\n');
}

/** A wa.me link that opens a chat with OMG with `text` already typed in. */
export function whatsappUrl(text) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}
