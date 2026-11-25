/* "the glam" slides. Turns the stacked photo, before-and-after and video
   blocks above into tabs, with a sideways swipe on touch screens. A block
   with no pictures or videos gets no tab, so the Videos tab appears on its
   own once the first video is added. */
(function () {
  var looks = document.querySelector('.looks');
  if (!looks) return;
  var track = looks.querySelector('.looks-track');
  var panels = [].filter.call(track.children, function (panel) {
    var filled = !!panel.querySelector('img, video');
    panel.hidden = !filled;
    return filled;
  });
  if (panels.length < 2) return;

  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var active = 0, slide = null, start = null;

  var bar = document.createElement('div');
  bar.className = 'looks-tabs';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'The glam');
  var tabs = panels.map(function (panel, i) {
    var tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'looks-tab';
    tab.id = 'tab-' + panel.id;
    tab.textContent = panel.dataset.tab || panel.querySelector('.looks-heading').textContent;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    tab.setAttribute('aria-selected', i === 0);
    tab.tabIndex = i === 0 ? 0 : -1;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    panel.hidden = i !== 0;
    tab.addEventListener('click', function () { show(i); });
    tab.addEventListener('pointerenter', function () { wake(panel); });
    tab.addEventListener('focus', function () { wake(panel); });
    bar.appendChild(tab);
    return tab;
  });
  looks.insertBefore(bar, track);
  looks.classList.add('is-tabbed');

  /* At the foot of each slide, buttons on to the next slide and back. */
  panels.forEach(function (panel, i) {
    var pager = document.createElement('div');
    pager.className = 'looks-pager';
    [i - 1, i + 1].forEach(function (j) {
      if (!panels[j]) return;
      var step = document.createElement('button'), label = document.createElement('span');
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      step.type = 'button';
      step.className = 'looks-step' + (j < i ? ' is-back' : '');
      step.setAttribute('aria-label', 'Go to ' + tabs[j].textContent);
      label.textContent = tabs[j].textContent;
      icon.setAttribute('class', 'icon');
      icon.setAttribute('aria-hidden', 'true');
      use.setAttribute('href', '#i-arrow');
      icon.appendChild(use);
      step.appendChild(j < i ? icon : label);
      step.appendChild(j < i ? label : icon);
      step.addEventListener('pointerenter', function () { wake(panels[j]); });
      step.addEventListener('click', function () { show(j); tabs[j].focus({ preventScroll: true }); });
      pager.appendChild(step);
    });
    panel.appendChild(pager);
  });

  /* Pictures in a slide that isn't showing are held back to save data.
     Start fetching them as soon as someone reaches for that slide. */
  function wake(panel) {
    if (!panel || panel.awake) return;
    panel.awake = true;
    [].forEach.call(panel.querySelectorAll('img[loading="lazy"]'), function (img) { img.loading = 'eager'; });
  }

  function show(next, instant) {
    if (next === active || !panels[next]) return;
    finish();
    var from = panels[active], to = panels[next], forward = next > active;
    active = next;
    tabs.forEach(function (tab, i) {
      tab.setAttribute('aria-selected', i === next);
      tab.tabIndex = i === next ? 0 : -1;
    });
    [].forEach.call(from.querySelectorAll('video'), function (video) { video.pause(); });
    wake(to);

    /* Part-way down a long slide the tabs have scrolled out of view.
       Start the new slide from its top, tabs showing, not from the same depth. */
    var over = looks.getBoundingClientRect().top - document.querySelector('.topbar').offsetHeight - 9;
    var height = track.offsetHeight, extra = height - from.offsetHeight;
    to.hidden = false;
    if (over < 0) {
      try { window.scrollBy({ top: over, behavior: 'instant' }); } catch (e) { window.scrollBy(0, over); }
    }
    if (instant || calm.matches) { from.hidden = true; return; }

    track.style.height = height + 'px';
    track.classList.add('is-sliding');
    from.classList.add(forward ? 'is-leaving-left' : 'is-leaving-right');
    to.classList.add(forward ? 'is-entering-right' : 'is-entering-left');
    track.offsetHeight;   /* fix the starting height before moving to the new one */
    track.style.height = to.offsetHeight + extra + 'px';
    slide = { from: from, to: to, timer: setTimeout(finish, 400) };
  }

  function finish() {
    if (!slide) return;
    clearTimeout(slide.timer);
    slide.from.hidden = true;
    [slide.from, slide.to].forEach(function (panel) {
      panel.classList.remove('is-leaving-left', 'is-leaving-right', 'is-entering-left', 'is-entering-right');
    });
    track.classList.remove('is-sliding');
    track.style.height = '';
    slide = null;
  }

  bar.addEventListener('keydown', function (e) {
    var i = tabs.indexOf(document.activeElement), n = tabs.length;
    var next = { ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    tabs[next].focus();
    show(next);
  });

  /* Sideways swipe. The listeners are passive, so ordinary scrolling
     and pinch-zoom carry on exactly as before. */
  track.addEventListener('touchstart', function (e) {
    var touch = e.touches[0];
    start = null;
    if (e.touches.length !== 1 || e.target.closest('video')) return;
    if (window.visualViewport && window.visualViewport.scale > 1.01) return;        /* zoomed in: a swipe pans the page */
    if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;      /* the phone's own back gesture */
    start = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  track.addEventListener('touchmove', function (e) {
    if (!start) return;
    if (e.touches.length !== 1) { start = null; return; }
    var dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.5) wake(panels[active + (dx < 0 ? 1 : -1)]);
  }, { passive: true });
  track.addEventListener('touchend', function (e) {
    if (!start) return;
    var touch = e.changedTouches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) show(active + (dx < 0 ? 1 : -1));
  }, { passive: true });
  track.addEventListener('touchcancel', function () { start = null; }, { passive: true });

  /* One video at a time. */
  track.addEventListener('play', function (e) {
    [].forEach.call(track.querySelectorAll('video'), function (video) { if (video !== e.target) video.pause(); });
  }, true);

  /* A link straight to a slide, such as /#before-after, opens that slide. */
  function fromHash() {
    var i = panels.map(function (panel) { return '#' + panel.id; }).indexOf(location.hash);
    if (i < 0) return;
    show(i, true);
    // On first load, wait until the whole page is built: the sections below
    // are still arriving while this script runs, and jumping before they
    // exist lands in the wrong place.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => panels[i].scrollIntoView()), { once: true });
    } else {
      panels[i].scrollIntoView();
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
