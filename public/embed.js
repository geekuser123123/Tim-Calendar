/*
 * Tim Calendar embed.
 *
 * Inline:
 *   <div data-tim-calendar="private-strategy-session"></div>
 *   <script src="https://YOUR-CALENDAR-DOMAIN/embed.js" async></script>
 *
 * Popup button (any element):
 *   <a href="#" data-tim-calendar-popup="work-with-tim">Book a call</a>
 *
 * UTM params, gclid/fbclid and first_name/last_name/name/email/phone on the host page URL
 * are passed through automatically (handy for GHL funnels that forward contact info).
 */
(function () {
  if (window.__timCalendarLoaded) return;
  window.__timCalendarLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  var ORIGIN = new URL(script.src, location.href).origin;
  var PASS = /^(utm_\w+|gclid|fbclid|first_name|last_name|name|email|phone)$/;
  var frames = {};
  var counter = 0;

  function frameUrl(slug, extra) {
    var qs = new URLSearchParams();
    new URLSearchParams(location.search).forEach(function (v, k) { if (PASS.test(k)) qs.set(k, v); });
    Object.keys(extra || {}).forEach(function (k) { if (extra[k]) qs.set(k, extra[k]); });
    qs.set('embed', '1');
    qs.set('src', location.href.split('#')[0]);
    return ORIGIN + '/' + encodeURIComponent(slug) + '?' + qs.toString();
  }

  function makeFrame(slug, extra) {
    var id = 'tc' + (++counter);
    extra = extra || {};
    extra.frame = id;
    var f = document.createElement('iframe');
    f.src = frameUrl(slug, extra);
    f.title = 'Schedule a session';
    f.loading = 'lazy';
    f.allow = 'clipboard-write';
    f.style.cssText = 'width:100%;border:0;min-height:640px;display:block;background:transparent;transition:height .15s';
    frames[id] = f;
    return f;
  }

  function mountInline(el) {
    if (el.__tcMounted) return;
    el.__tcMounted = true;
    var extra = {};
    ['email', 'first_name', 'last_name', 'phone'].forEach(function (k) {
      var v = el.getAttribute('data-' + k.replace('_', '-'));
      if (v) extra[k] = v;
    });
    el.appendChild(makeFrame(el.getAttribute('data-tim-calendar'), extra));
  }

  var overlay;
  function openPopup(slug) {
    closePopup();
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.6);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 12px';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:100%;max-width:1040px;background:#fff;border-radius:14px;overflow:hidden;margin:auto';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    close.style.cssText = 'position:absolute;top:8px;right:10px;z-index:2;width:36px;height:36px;border-radius:50%;border:0;background:#f1f5f9;font-size:24px;line-height:36px;cursor:pointer;color:#334155';
    close.onclick = closePopup;
    box.appendChild(close);
    box.appendChild(makeFrame(slug));
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePopup(); });
    document.addEventListener('keydown', escClose);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
  }
  function escClose(e) { if (e.key === 'Escape') closePopup(); }
  function closePopup() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', escClose);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.source !== 'tim-calendar') return;
    var f = frames[e.data.frame];
    if (!f) return;
    if (e.data.type === 'height' && e.data.height) f.style.height = Math.max(400, e.data.height) + 'px';
    if (e.data.type === 'scroll') {
      var top = f.getBoundingClientRect().top;
      if (top < 0 && !overlay) window.scrollBy({ top: top - 20, behavior: 'smooth' });
    }
    if (e.data.type === 'booked') {
      // Let the host page react (e.g. fire a pixel): window.addEventListener('tim-calendar:booked', ...)
      window.dispatchEvent(new CustomEvent('tim-calendar:booked', { detail: e.data.booking }));
      if (window.dataLayer) window.dataLayer.push({ event: 'tim_calendar_booked', event_type: e.data.booking && e.data.booking.eventType && e.data.booking.eventType.slug });
    }
    if (e.data.type === 'redirect' && /^https?:\/\//.test(e.data.url || '')) window.location.href = e.data.url;
  });

  function scan() {
    document.querySelectorAll('[data-tim-calendar]').forEach(mountInline);
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-tim-calendar-popup]');
    if (!t) return;
    e.preventDefault();
    openPopup(t.getAttribute('data-tim-calendar-popup'));
  });

  window.TimCalendar = { open: openPopup, close: closePopup, scan: scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  // Page builders (Elementor, GHL) sometimes inject content late.
  if ('MutationObserver' in window) new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
})();
