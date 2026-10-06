/*
 * CTF accessibility menu.
 *
 * One file, loaded the same way on www.cutthroughfaster.com, the demo pages and
 * the client dashboard. There are three identical copies, one per site —
 * ctf-website/public, demo/public and app/public — because each site deploys
 * on its own. Change all three together.
 *
 * A small round button in the bottom-left corner, showing only the
 * accessibility icon so it covers as little of the page as possible, opens a
 * panel with:
 *   - Text size: normal, larger, largest.
 *   - High contrast: every piece of text becomes pure black on a light
 *     background or pure white on a dark one, without changing the layout.
 *   - A short account of what is built into the site: screen reader support,
 *     keyboard navigation, alt text, colour contrast, captions and transcripts.
 *
 * Choices are remembered in this browser (localStorage) and applied again on
 * the next visit. Nothing is sent anywhere.
 *
 * Plain script, no dependencies, no inline <style> — the dashboard's content
 * security policy allows scripts and styles from its own origin, and CSSOM
 * changes like element.style, which is all this does.
 */
(function () {
  'use strict';

  if (window.__ctfA11y) return;
  window.__ctfA11y = true;

  // Which site this is, from the tag that loaded the script (data-site="www",
  // "demo" or "app"), falling back on the address. Only the captions line differs.
  var script = document.currentScript;
  var host = location.hostname;
  var site =
    (script && script.getAttribute('data-site')) ||
    (host.indexOf('app.') === 0 ? 'app' : host.indexOf('demo.') === 0 ? 'demo' : 'www');

  var KEY = 'ctf-a11y';
  var SIZES = [1, 1.15, 1.3];
  var SIZE_LABELS = ['Normal', 'Larger', 'Largest'];
  var root = document.documentElement;

  // ---- preferences ------------------------------------------------------------
  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        size: saved.size === 1 || saved.size === 2 ? saved.size : 0,
        contrast: saved.contrast === true,
      };
    } catch (error) {
      return { size: 0, contrast: false };
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (error) {
      // Private browsing or blocked storage: the choice still applies to this page.
    }
  }

  var state = load();

  // ---- text size ----------------------------------------------------------------
  // `zoom` on the root reflows the page at the larger size, like the browser's
  // own zoom, so nothing is cut off or scrolls sideways. Browsers without it
  // get a larger root font size, which enlarges everything sized in rem.
  var supportsZoom = 'zoom' in root.style;
  var menuEl = null;

  function applySize() {
    var scale = SIZES[state.size];
    if (supportsZoom) {
      root.style.zoom = scale === 1 ? '' : String(scale);
      // The menu itself stays the same size: grown with the page, its top —
      // where the text size buttons are — would leave a phone screen, and
      // there would be no way back to Normal.
      if (menuEl) menuEl.style.zoom = scale === 1 ? '' : String(1 / scale);
    } else {
      root.style.fontSize = scale === 1 ? '' : scale * 100 + '%';
    }
  }

  // ---- high contrast ----------------------------------------------------------
  // Each element that holds text is given pure black or pure white, whichever
  // stands out against the background actually behind it — so dark sections
  // stay dark and light ones light, and only the text changes. The original
  // inline values are kept and put back when it is switched off.
  var saved = [];
  var observer = null;

  function parseColor(value) {
    var match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    var parts = match[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function luminance(color) {
    function channel(v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function backgroundBehind(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a >= 0.5) return color;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function holdsText(el) {
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return true;
    for (var child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 && child.nodeValue.trim()) return true;
    }
    return false;
  }

  function force(el, property, value) {
    saved.push([el, property, el.style.getPropertyValue(property), el.style.getPropertyPriority(property)]);
    el.style.setProperty(property, value, 'important');
  }

  function contrastSubtree(start) {
    if (!start || start.nodeType !== 1) return;
    var nodes = [start].concat(Array.prototype.slice.call(start.querySelectorAll('*')));
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest('.ctf-a11y') || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
      if (el.hasAttribute('data-ctf-a11y-contrast') || !holdsText(el)) continue;
      el.setAttribute('data-ctf-a11y-contrast', '');
      var ink = luminance(backgroundBehind(el)) > 0.35 ? '#000000' : '#ffffff';
      force(el, 'color', ink);
      if (parseFloat(getComputedStyle(el).opacity) < 1) force(el, 'opacity', '1');
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) force(el, 'border-color', ink);
    }
  }

  function applyContrast() {
    root.classList.toggle('ctf-a11y-contrast', state.contrast);
    if (state.contrast) {
      contrastSubtree(document.body);
      // React pages add and replace elements as they go (a call starting,
      // a row opening); give new ones the same treatment.
      if (!observer && 'MutationObserver' in window) {
        var pending = [];
        var scheduled = false;
        observer = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            for (var j = 0; j < records[i].addedNodes.length; j++) pending.push(records[i].addedNodes[j]);
            if (records[i].type === 'characterData' && records[i].target.parentElement) {
              pending.push(records[i].target.parentElement);
            }
          }
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(function () {
            scheduled = false;
            var batch = pending;
            pending = [];
            for (var k = 0; k < batch.length; k++) {
              var node = batch[k];
              if (node.nodeType === 3) node = node.parentElement;
              contrastSubtree(node);
            }
          });
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    } else {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      for (var i = saved.length - 1; i >= 0; i--) {
        var entry = saved[i];
        if (entry[2]) entry[0].style.setProperty(entry[1], entry[2], entry[3]);
        else entry[0].style.removeProperty(entry[1]);
        // Leave no empty style="" behind where there was none.
        if (!entry[0].style.length) entry[0].removeAttribute('style');
      }
      saved = [];
      var marked = document.querySelectorAll('[data-ctf-a11y-contrast]');
      for (var m = 0; m < marked.length; m++) marked[m].removeAttribute('data-ctf-a11y-contrast');
    }
  }

  // Size applies straight away, before the menu is drawn, so the page does
  // not jump once it appears.
  applySize();

  // ---- the menu ---------------------------------------------------------------
  function captionsText() {
    if (site === 'app') {
      return 'Every call in your history has “Read the transcript” beside its recording, and a live call shows the conversation as it happens.';
    }
    if (site === 'demo') {
      return 'Live captions appear under the timer while you talk to Hope, and the whole transcript is there to read when the call ends.';
    }
    return 'When you phone Hope from this site, live captions appear as you talk, and the transcript is there to read afterwards.';
  }

  function keyboardText() {
    var skip = document.querySelector('.skip-link')
      ? ' The first stop, “Skip to content”, jumps straight past the menu.'
      : '';
    return 'Tab moves forward, Shift + Tab moves back, and Enter or Space chooses.' + skip;
  }

  var ICON =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="7.2" r="1.4" fill="currentColor" stroke="none"/>' +
    '<path d="M7.2 9.9 12 11l4.8-1.1"/><path d="M12 11v3.3l-2.3 4.4M12 14.3l2.3 4.4"/></svg>';

  function build() {
    var wrapper = document.createElement('div');
    wrapper.className = 'ctf-a11y';

    var sizeButtons = '';
    for (var i = 0; i < SIZES.length; i++) {
      sizeButtons +=
        '<button type="button" class="ctf-a11y-option" data-size="' + i + '" aria-pressed="false">' +
        SIZE_LABELS[i] + '</button>';
    }

    wrapper.innerHTML =
      // Icon only: the name screen readers announce, and the tooltip on hover,
      // both come from aria-label and title.
      '<button type="button" class="ctf-a11y-toggle" aria-label="Accessibility" title="Accessibility" ' +
        'aria-expanded="false" aria-controls="ctf-a11y-panel">' + ICON + '</button>' +
      '<div class="ctf-a11y-panel" id="ctf-a11y-panel" role="dialog" aria-labelledby="ctf-a11y-title" hidden>' +
        '<div class="ctf-a11y-head">' +
          '<h2 class="ctf-a11y-title" id="ctf-a11y-title" tabindex="-1">Accessibility</h2>' +
          '<button type="button" class="ctf-a11y-close" aria-label="Close the accessibility menu">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
          '</button>' +
        '</div>' +
        '<p class="ctf-a11y-label" id="ctf-a11y-size-label">Text size</p>' +
        '<div class="ctf-a11y-options" role="group" aria-labelledby="ctf-a11y-size-label">' + sizeButtons + '</div>' +
        '<button type="button" class="ctf-a11y-switch" role="switch" aria-checked="false">' +
          '<span>High contrast</span><span class="ctf-a11y-track" aria-hidden="true"><span class="ctf-a11y-thumb"></span></span>' +
        '</button>' +
        '<h3 class="ctf-a11y-subtitle">Built into this site</h3>' +
        '<ul class="ctf-a11y-list">' +
          '<li><strong>Screen reader support.</strong> Headings, labels and descriptions are in place for screen readers such as NVDA, JAWS, VoiceOver and Narrator.</li>' +
          '<li><strong>Keyboard navigation.</strong> <span data-ctf-a11y="keyboard"></span></li>' +
          '<li><strong>Alt text for images.</strong> Every picture has a written description that a screen reader reads out.</li>' +
          '<li><strong>Colour contrast.</strong> Text meets the WCAG AA contrast standard. High contrast, above, goes further.</li>' +
          '<li><strong>Captions and transcripts.</strong> <span data-ctf-a11y="captions"></span></li>' +
        '</ul>' +
        '<button type="button" class="ctf-a11y-reset">Reset to default</button>' +
      '</div>';

    wrapper.querySelector('[data-ctf-a11y="keyboard"]').textContent = keyboardText();
    wrapper.querySelector('[data-ctf-a11y="captions"]').textContent = captionsText();
    document.body.appendChild(wrapper);
    menuEl = wrapper;
    applySize();

    var toggle = wrapper.querySelector('.ctf-a11y-toggle');
    var panel = wrapper.querySelector('.ctf-a11y-panel');
    var title = wrapper.querySelector('.ctf-a11y-title');
    var options = wrapper.querySelectorAll('.ctf-a11y-option');
    var contrastSwitch = wrapper.querySelector('.ctf-a11y-switch');

    function render() {
      for (var i = 0; i < options.length; i++) {
        options[i].setAttribute('aria-pressed', String(Number(options[i].getAttribute('data-size')) === state.size));
      }
      contrastSwitch.setAttribute('aria-checked', String(state.contrast));
    }

    function open() {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      title.focus();
    }

    function close(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) toggle.focus();
    }

    toggle.addEventListener('click', function () {
      if (panel.hidden) open();
      else close(true);
    });
    wrapper.querySelector('.ctf-a11y-close').addEventListener('click', function () {
      close(true);
    });

    for (var j = 0; j < options.length; j++) {
      options[j].addEventListener('click', function (event) {
        state.size = Number(event.currentTarget.getAttribute('data-size'));
        applySize();
        save();
        render();
      });
    }

    contrastSwitch.addEventListener('click', function () {
      state.contrast = !state.contrast;
      applyContrast();
      save();
      render();
    });

    wrapper.querySelector('.ctf-a11y-reset').addEventListener('click', function () {
      state = { size: 0, contrast: false };
      applySize();
      applyContrast();
      save();
      render();
    });

    // Escape closes it from anywhere inside; a click outside closes it too.
    wrapper.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) {
        event.stopPropagation();
        close(true);
      }
    });
    document.addEventListener('mousedown', function (event) {
      if (!panel.hidden && !wrapper.contains(event.target)) close(false);
    });

    render();
    if (state.contrast) applyContrast();
  }

  function start() {
    // The stylesheet sits next to this script, on the same origin.
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/a11y.css';
    var built = false;
    function once() {
      if (built) return;
      built = true;
      build();
    }
    link.onload = once;
    link.onerror = once;
    document.head.appendChild(link);
    setTimeout(once, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
