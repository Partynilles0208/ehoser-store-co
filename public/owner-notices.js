/* ehoser Eigentümer-Hinweise
 * Läuft bewusst ohne Framework auf der Startseite und im Chat. Der Server
 * filtert persönliche Nachrichten per Login-Token; im Browser wird nichts
 * allein anhand eines Benutzernamens freigeschaltet.
 */
(function () {
  'use strict';

  const apiOrigin = window.__EHOSER_DESKTOP__
    ? (window.__EHOSER_API_ORIGIN__ || 'https://ehoser.de')
    : window.location.origin;
  const statusUrl = `${apiOrigin}/api/owner/status`;
  const pollMs = 30_000;
  let maintenanceLocked = false;
  let lastNoticeSignature = '';

  function currentToken() {
    try { return localStorage.getItem('token') || ''; } catch { return ''; }
  }

  function buildHeader() {
    const token = currentToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function noticeSeenKey(notice) {
    let username = 'guest';
    try {
      const tokenPart = currentToken().split('.')[1];
      if (tokenPart) username = JSON.parse(atob(tokenPart.replace(/-/g, '+').replace(/_/g, '/'))).username || username;
    } catch {}
    return `ehoser-owner-notice-seen:${String(username).toLowerCase()}:${notice.id}`;
  }

  function ensureNoticeRegion() {
    let region = document.getElementById('ehoserOwnerNoticeRegion');
    if (region) return region;
    region = document.createElement('aside');
    region.id = 'ehoserOwnerNoticeRegion';
    region.setAttribute('aria-live', 'polite');
    region.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
      'display:flex', 'width:min(390px,calc(100vw - 32px))', 'flex-direction:column',
      'gap:10px', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(region);
    return region;
  }

  function renderNotices(notices) {
    if (maintenanceLocked || !document.body) return;
    const signature = JSON.stringify((notices || []).map((notice) => [notice.id, notice.active, notice.message]));
    if (signature === lastNoticeSignature) return;
    lastNoticeSignature = signature;

    const region = ensureNoticeRegion();
    region.replaceChildren();
    (notices || []).forEach((notice) => {
      const card = document.createElement('article');
      const isNotification = notice.kind === 'notification';
      card.style.cssText = [
        'pointer-events:auto', 'padding:14px 15px', 'border-radius:15px',
        `border:1px solid ${isNotification ? 'rgba(77,159,255,.62)' : 'rgba(14,240,208,.42)'}`,
        `background:${isNotification ? 'linear-gradient(135deg,rgba(19,45,86,.97),rgba(10,28,56,.97))' : 'linear-gradient(135deg,rgba(8,61,73,.97),rgba(12,35,61,.97))'}`,
        'box-shadow:0 18px 45px rgba(0,0,0,.36)', 'color:#f8fbff',
        'font-family:Outfit,system-ui,sans-serif'
      ].join(';');
      const label = document.createElement('div');
      label.textContent = isNotification ? '🔔 Nachricht vom ehoser Eigentümer' : '📣 ehoser Anzeige';
      label.style.cssText = 'font-size:.72rem;letter-spacing:.07em;text-transform:uppercase;color:#8edfff;font-weight:800;margin-bottom:5px;';
      const title = document.createElement('strong');
      title.textContent = notice.title;
      title.style.cssText = 'display:block;font-size:1rem;margin-bottom:5px;';
      const message = document.createElement('div');
      message.textContent = notice.message;
      message.style.cssText = 'font-size:.92rem;line-height:1.42;color:#d8e8f4;white-space:pre-wrap;';
      card.append(label, title, message);
      region.appendChild(card);

      const key = noticeSeenKey(notice);
      let alreadySeen = false;
      try { alreadySeen = localStorage.getItem(key) === '1'; } catch {}
      if (isNotification && !alreadySeen) {
        try { localStorage.setItem(key, '1'); } catch {}
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification(notice.title, { body: notice.message, tag: `ehoser-owner-${notice.id}` });
          } catch {}
        }
      }
    });
  }

  function showMaintenance(maintenance) {
    if (maintenanceLocked) return;
    maintenanceLocked = true;
    const title = maintenance?.title || 'Wir sind gleich wieder da';
    const message = maintenance?.message || 'Die Webseite ist vorübergehend wegen Update, Programmierung oder sonstigen Gründen nicht verfügbar.';
    document.title = `ehoser – ${title}`;
    document.documentElement.style.background = '#061525';
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:radial-gradient(circle at 18% 16%,#12436d 0,transparent 34%),radial-gradient(circle at 88% 78%,#0c736f 0,transparent 30%),#061525;color:#f8fbff;font-family:Outfit,system-ui,sans-serif;';
    const card = document.createElement('main');
    card.style.cssText = 'max-width:560px;width:100%;box-sizing:border-box;padding:34px 28px;border:1px solid rgba(126,220,255,.3);border-radius:24px;background:rgba(5,24,43,.82);box-shadow:0 28px 80px rgba(0,0,0,.42);text-align:center;';
    const logo = document.createElement('div');
    logo.textContent = 'E';
    logo.style.cssText = 'width:58px;height:58px;border-radius:18px;display:grid;place-items:center;margin:0 auto 20px;background:linear-gradient(135deg,#0ef0d0,#4d9fff);color:#042039;font-weight:900;font-size:2rem;box-shadow:0 12px 30px rgba(14,240,208,.25);';
    const heading = document.createElement('h1');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 14px;font-size:clamp(1.65rem,6vw,2.4rem);letter-spacing:-.04em;';
    const text = document.createElement('p');
    text.textContent = message;
    text.style.cssText = 'margin:0;color:#b9d5e6;font-size:1rem;line-height:1.65;white-space:pre-wrap;';
    const hint = document.createElement('p');
    hint.textContent = 'Bitte schau später noch einmal vorbei.';
    hint.style.cssText = 'margin:24px 0 0;color:#78bddb;font-size:.9rem;';
    card.append(logo, heading, text, hint);
    document.body.appendChild(card);
  }

  async function refreshOwnerStatus() {
    if (maintenanceLocked) return;
    try {
      const response = await fetch(statusUrl, { headers: buildHeader(), cache: 'no-store' });
      if (!response.ok) return;
      const status = await response.json();
      if (status.maintenance?.enabled && !status.isOwner) {
        showMaintenance(status.maintenance);
        return;
      }
      renderNotices(status.notices || []);
    } catch {}
  }

  function start() {
    refreshOwnerStatus();
    window.setInterval(refreshOwnerStatus, pollMs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

/* Loads the mobile Sites launcher without changing the Control Center markup. */
(function loadEhoserControlTools() {
  if (!/Control Center/i.test(document.title) || document.getElementById('ehoserExtrasLoader')) return;
  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = '/ehoser-extras.css?v=1';
  document.head.appendChild(styles);
  const script = document.createElement('script');
  script.id = 'ehoserExtrasLoader';
  script.src = '/ehoser-extras.js?v=1';
  script.defer = true;
  document.head.appendChild(script);
})();
