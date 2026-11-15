// OMG Admin: shows the phone alert for a new booking request or review.
//
// The push itself carries nothing. This asks the server what to say, with
// OMG's own sign-in, so no client's details ever pass through the browser's
// push service. If the sign-in has run out, the alert still arrives, just
// without the details.

const ICON = '/img/icon-192.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(showAlert());
});

async function showAlert() {
  let alert = { title: 'OMG – Oh! My Glam', body: 'Something new came in. Open the admin page to see it.', tag: 'waiting' };
  try {
    const res = await fetch('/api/admin/push/latest', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && typeof data.title === 'string' && typeof data.body === 'string') alert = data;
    } else if (res.status === 401) {
      alert = { ...alert, body: 'Something new came in. Sign in to the admin page to see it.' };
    }
  } catch {
    // Offline or the server is busy: the general alert still goes out.
  }
  await self.registration.showNotification(String(alert.title).slice(0, 80), {
    body: String(alert.body).slice(0, 240),
    tag: `omg-${String(alert.tag || 'alert').replace(/[^\w-]/g, '').slice(0, 40)}`,
    renotify: true,
    icon: ICON,
    badge: ICON,
    data: { url: '/admin/' },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname.startsWith('/admin/')) {
        await client.focus();
        client.postMessage({ type: 'refresh' });
        return;
      }
    }
    await self.clients.openWindow('/admin/');
  })());
});

// Browsers occasionally replace a subscription. Tell the server about the new
// one (the sign-in cookie goes with it), so alerts keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const fresh = event.newSubscription
      || (event.oldSubscription && await self.registration.pushManager.subscribe(event.oldSubscription.options));
    if (!fresh) return;
    const post = (path, endpoint) => fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    await post('/api/admin/push/subscribe', fresh.endpoint);
    if (event.oldSubscription && event.oldSubscription.endpoint !== fresh.endpoint) {
      await post('/api/admin/push/unsubscribe', event.oldSubscription.endpoint);
    }
  })().catch(() => {}));
});
