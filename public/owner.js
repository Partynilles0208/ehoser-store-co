'use strict';

const OWNER_API_ORIGIN = window.__EHOSER_DESKTOP__
  ? (window.__EHOSER_API_ORIGIN__ || 'https://ehoser.de')
  : window.location.origin;
const OWNER_API = `${OWNER_API_ORIGIN}/api/owner`;
let ownerConsoleData = null;

function ownerToken() { return localStorage.getItem('token') || ''; }
function ownerHeaders(json = false) {
  const token = ownerToken();
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
function ownerEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function ownerSetStatus(id, message = '', type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `owner-status ${type}`;
}
function ownerShowDenied(message) {
  const app = document.getElementById('ownerApp');
  app.innerHTML = `<section class="owner-access"><div class="owner-brand" style="justify-content:center;margin-bottom:18px"><span class="owner-brand-mark">E</span><span>ehoser</span></div><h1>Eigentümerzugang geschützt</h1><p>${ownerEscape(message || 'Melde dich mit dem Account meisterlool_707 an, um diese Konsole zu öffnen.')}</p><a class="owner-link" href="/chat/">Zum Chat</a></section>`;
}
function ownerFormatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'unbekannt' : date.toLocaleString('de-DE', { dateStyle:'medium', timeStyle:'short' });
}

async function ownerRefresh() {
  try {
    const response = await fetch(`${OWNER_API}/console`, { headers: ownerHeaders(), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) return ownerShowDenied(data.error);
    if (!response.ok) throw new Error(data.error || 'Konsole konnte nicht geladen werden.');
    ownerConsoleData = data;
    ownerRender();
  } catch (error) {
    ownerSetStatus('maintenanceStatus', error.message || 'Verbindung fehlgeschlagen.', 'error');
  }
}

function ownerRender() {
  const data = ownerConsoleData || {};
  const maintenance = data.maintenance || {};
  const stats = data.stats || {};
  document.getElementById('maintenanceEnabled').checked = Boolean(maintenance.enabled);
  document.getElementById('maintenanceTitle').value = maintenance.title || '';
  document.getElementById('maintenanceMessage').value = maintenance.message || '';
  document.getElementById('ownerStatUsers').textContent = Number(stats.totalUsers || 0).toLocaleString('de-DE');
  document.getElementById('ownerStatOnline').textContent = Number(stats.onlineUsers || 0).toLocaleString('de-DE');
  document.getElementById('ownerStatToday').textContent = Number(stats.activeToday || 0).toLocaleString('de-DE');
  ownerRenderNotices(data.notices || []);
}

function ownerRenderNotices(notices) {
  const list = document.getElementById('ownerNoticeList');
  if (!notices.length) {
    list.innerHTML = '<p class="owner-empty">Noch keine Mitteilungen gesendet.</p>';
    return;
  }
  list.innerHTML = notices.map((notice) => {
    const target = notice.audience === 'user' ? `an ${ownerEscape(notice.targetUsername)}` : 'an alle Nutzer';
    const kind = notice.kind === 'notification' ? '🔔 Benachrichtigung' : '📣 Anzeige';
    const state = notice.active ? 'Aktiv' : 'Pausiert';
    const expires = notice.expiresAt ? ` · bis ${ownerFormatDate(notice.expiresAt)}` : '';
    return `<article class="owner-notice"><div class="owner-notice-head"><div><div class="owner-notice-title">${ownerEscape(notice.title)}</div><div class="owner-notice-meta">${kind} · ${target} · ${state}${expires}</div></div></div><div class="owner-notice-text">${ownerEscape(notice.message)}</div><div class="owner-notice-actions"><button class="owner-btn small" type="button" onclick="ownerToggleNotice('${ownerEscape(notice.id)}')">${notice.active ? 'Pausieren' : 'Wieder einschalten'}</button><button class="owner-btn danger small" type="button" onclick="ownerDeleteNotice('${ownerEscape(notice.id)}')">Löschen</button></div></article>`;
  }).join('');
}

function ownerToggleRecipient() {
  const audience = document.getElementById('noticeAudience').value;
  document.getElementById('noticeRecipientWrap').classList.toggle('owner-hidden', audience !== 'user');
}

async function ownerSaveMaintenance() {
  ownerSetStatus('maintenanceStatus', 'Speichere …');
  try {
    const body = {
      enabled: document.getElementById('maintenanceEnabled').checked,
      title: document.getElementById('maintenanceTitle').value.trim(),
      message: document.getElementById('maintenanceMessage').value.trim()
    };
    const response = await fetch(`${OWNER_API}/maintenance`, { method:'PUT', headers:ownerHeaders(true), body:JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Wartungsmodus konnte nicht gespeichert werden.');
    ownerSetStatus('maintenanceStatus', body.enabled ? 'Wartungsmodus ist jetzt aktiv. Andere Nutzer sehen die Wartungsseite.' : 'Wartungsmodus deaktiviert. Die Seite ist wieder offen.', 'success');
    await ownerRefresh();
  } catch (error) {
    ownerSetStatus('maintenanceStatus', error.message, 'error');
  }
}

async function ownerCreateNotice() {
  ownerSetStatus('noticeStatus', 'Wird gesendet …');
  try {
    const audience = document.getElementById('noticeAudience').value;
    const expiresInput = document.getElementById('noticeExpiresAt').value;
    const body = {
      kind: document.getElementById('noticeKind').value,
      audience,
      targetUsername: audience === 'user' ? document.getElementById('noticeRecipient').value.trim() : '',
      title: document.getElementById('noticeTitle').value.trim(),
      message: document.getElementById('noticeMessage').value.trim(),
      expiresAt: expiresInput ? new Date(expiresInput).toISOString() : null
    };
    const response = await fetch(`${OWNER_API}/notices`, { method:'POST', headers:ownerHeaders(true), body:JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Mitteilung konnte nicht gesendet werden.');
    document.getElementById('noticeTitle').value = '';
    document.getElementById('noticeMessage').value = '';
    document.getElementById('noticeRecipient').value = '';
    document.getElementById('noticeExpiresAt').value = '';
    ownerSetStatus('noticeStatus', 'Mitteilung wurde gesendet.', 'success');
    await ownerRefresh();
  } catch (error) {
    ownerSetStatus('noticeStatus', error.message, 'error');
  }
}

async function ownerToggleNotice(id) {
  try {
    const response = await fetch(`${OWNER_API}/notices/${encodeURIComponent(id)}/toggle`, { method:'POST', headers:ownerHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Mitteilung konnte nicht geändert werden.');
    await ownerRefresh();
  } catch (error) {
    ownerSetStatus('noticeStatus', error.message, 'error');
  }
}

async function ownerDeleteNotice(id) {
  if (!window.confirm('Diese Mitteilung wirklich endgültig löschen?')) return;
  try {
    const response = await fetch(`${OWNER_API}/notices/${encodeURIComponent(id)}`, { method:'DELETE', headers:ownerHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Mitteilung konnte nicht gelöscht werden.');
    await ownerRefresh();
  } catch (error) {
    ownerSetStatus('noticeStatus', error.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', ownerRefresh);
