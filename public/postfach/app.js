'use strict';

const API = window.location.origin + '/api';
const DRAFT_KEY = 'ehoserMailboxDraft';
let token = localStorage.getItem('token') || '';
let currentUser = null;
let mailbox = null;
let messages = [];
let activeFilter = 'inbox';
let activeMessageId = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

async function api(path, method = 'GET', body = null) {
  const response = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    throw new Error(response.ok ? 'Der Server hat eine ungültige Antwort geschickt.' : 'Serverfehler (HTTP ' + response.status + ').');
  }
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 3500);
}

function suggestion() {
  return String(currentUser?.username || '')
    .toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 32);
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function longTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
}

function statusLabel(message) {
  if (message.direction === 'inbound') return 'Empfangen';
  return ({ queued: 'Wird gesendet', sent: 'Gesendet', delivered: 'Zugestellt', failed: 'Fehlgeschlagen', bounced: 'Nicht zustellbar' })[message.status] || 'Gesendet';
}

function displayPerson(message) {
  return message.direction === 'inbound'
    ? (message.sender_address || 'Unbekannter Absender')
    : ('An: ' + (message.recipient_address || 'Unbekannt'));
}

function filteredMessages() {
  const query = $('mailSearch').value.trim().toLowerCase();
  return messages.filter((message) => {
    const matchesFolder = activeFilter === 'all'
      || (activeFilter === 'inbox' && message.direction === 'inbound')
      || (activeFilter === 'sent' && message.direction === 'outbound');
    if (!matchesFolder) return false;
    if (!query) return true;
    return [message.sender_address, message.recipient_address, message.subject, message.text_body]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
}

function setFolderHeading() {
  const labels = {
    inbox: ['Posteingang', 'Neue E-Mails erscheinen hier.'],
    sent: ['Gesendet', 'Deine über Resend verschickten E-Mails.'],
    all: ['Alle E-Mails', 'Posteingang und gesendete E-Mails zusammen.']
  };
  $('folderTitle').textContent = labels[activeFilter][0];
  $('folderSubtitle').textContent = labels[activeFilter][1];
}

function renderFolders() {
  const unread = messages.filter((message) => message.direction === 'inbound' && !message.read_at).length;
  $('inboxCount').textContent = unread > 99 ? '99+' : String(unread);
  $('mailTotalCount').textContent = messages.length + ' E-Mail' + (messages.length === 1 ? '' : 's');
  document.querySelectorAll('.folder-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
  });
  setFolderHeading();
}

function renderMailList() {
  const list = $('mailList');
  list.replaceChildren();
  const visible = filteredMessages();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = $('mailSearch').value.trim() ? 'Keine passende E-Mail gefunden.' : 'In diesem Ordner sind noch keine E-Mails.';
    list.appendChild(empty);
    return;
  }
  for (const message of visible) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mail-list-item' + (message.direction === 'inbound' && !message.read_at ? ' unread' : '') + (Number(message.id) === Number(activeMessageId) ? ' active' : '');
    const top = document.createElement('div');
    top.className = 'list-line';
    const sender = document.createElement('span');
    sender.className = 'list-sender';
    sender.textContent = displayPerson(message);
    const time = document.createElement('time');
    time.className = 'list-time';
    time.dateTime = message.created_at || '';
    time.textContent = shortTime(message.created_at);
    top.append(sender, time);
    const subject = document.createElement('div');
    subject.className = 'list-subject';
    subject.textContent = message.subject || '(ohne Betreff)';
    const preview = document.createElement('div');
    preview.className = 'list-preview';
    preview.textContent = String(message.text_body || '').replace(/\s+/g, ' ');
    item.append(top, subject, preview);
    if (message.direction === 'outbound') {
      const status = document.createElement('small');
      status.className = 'list-status';
      status.textContent = statusLabel(message);
      item.appendChild(status);
    }
    item.addEventListener('click', () => openMessage(message.id));
    list.appendChild(item);
  }
}

function renderDetail(message) {
  if (!message) {
    $('mailDetail').hidden = true;
    $('mailEmptyDetail').hidden = false;
    return;
  }
  $('mailEmptyDetail').hidden = true;
  $('mailDetail').hidden = false;
  $('detailStatus').textContent = statusLabel(message);
  $('detailTime').textContent = longTime(message.created_at);
  $('detailTime').dateTime = message.created_at || '';
  $('detailSubject').textContent = message.subject || '(ohne Betreff)';
  const incoming = message.direction === 'inbound';
  const address = incoming ? (message.sender_address || '') : (message.recipient_address || '');
  $('detailPerson').textContent = incoming ? address : ('An: ' + address);
  $('detailAddress').textContent = incoming ? ('an ' + (mailbox?.address || '@ehoser.de')) : ('von ' + (mailbox?.address || '@ehoser.de'));
  $('detailAvatar').textContent = (address.slice(0, 2) || 'E').toUpperCase();
  $('detailBody').textContent = message.text_body || 'Diese E-Mail enthält keinen lesbaren Textinhalt.';
  $('replyButton').hidden = !incoming;
  $('detailActions').hidden = false;
}

async function openMessage(messageId) {
  const message = messages.find((item) => Number(item.id) === Number(messageId));
  if (!message) return;
  activeMessageId = message.id;
  renderDetail(message);
  renderMailList();
  $('mailboxShell').classList.add('detail-open');
  if (message.direction === 'inbound' && !message.read_at) {
    message.read_at = new Date().toISOString();
    renderFolders();
    renderMailList();
    try { await api('/mailbox/messages/' + encodeURIComponent(message.id) + '/read', 'POST'); } catch { /* server will retry next refresh */ }
  }
}

async function loadMailbox(showLoading = false) {
  const button = $('refreshButton');
  if (showLoading) { button.disabled = true; button.textContent = '…'; }
  try {
    const data = await api('/mailbox');
    mailbox = data.mailbox || null;
    messages = Array.isArray(data.messages) ? data.messages : [];
    if (!mailbox?.configured) {
      $('mailboxShell').hidden = true;
      $('mailboxSetup').hidden = false;
      $('composeFab').hidden = true;
      $('mailboxLocalPart').value = suggestion();
      return data;
    }
    $('mailboxSetup').hidden = true;
    $('mailboxShell').hidden = false;
    $('composeFab').hidden = false;
    $('mailAddress').textContent = mailbox.address;
    $('copyAddressButton').disabled = false;
    renderFolders();
    renderMailList();
    const currentlyOpen = messages.find((message) => Number(message.id) === Number(activeMessageId));
    renderDetail(currentlyOpen || null);
    return data;
  } finally {
    if (showLoading) { button.disabled = false; button.textContent = '↻'; }
  }
}

function openCompose(options = {}) {
  if (!mailbox?.configured) return;
  const draft = readDraft();
  $('composeTo').value = options.to ?? draft?.to ?? '';
  $('composeSubject').value = options.subject ?? draft?.subject ?? '';
  $('composeText').value = options.text ?? draft?.text ?? '';
  $('composeStatus').textContent = '';
  $('composeStatus').classList.remove('error');
  $('composeOverlay').hidden = false;
  setTimeout(() => $('composeTo').focus(), 30);
}

function closeCompose() {
  $('composeOverlay').hidden = true;
}

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY + ':' + (currentUser?.username || '')) || 'null'); } catch { return null; }
}

function saveDraft(showToast = true) {
  const draft = { to: $('composeTo').value.trim(), subject: $('composeSubject').value.trim(), text: $('composeText').value.trim() };
  localStorage.setItem(DRAFT_KEY + ':' + (currentUser?.username || ''), JSON.stringify(draft));
  if (showToast) toast('Entwurf auf diesem Gerät gespeichert.');
}

async function sendMessage(event) {
  event.preventDefault();
  const status = $('composeStatus');
  const button = $('sendMailButton');
  const payload = { to: $('composeTo').value.trim(), subject: $('composeSubject').value.trim(), text: $('composeText').value.trim() };
  button.disabled = true;
  button.textContent = 'Wird gesendet…';
  status.textContent = '';
  status.classList.remove('error');
  try {
    const data = await api('/mailbox/messages', 'POST', payload);
    if (data.message) messages.unshift(data.message);
    localStorage.removeItem(DRAFT_KEY + ':' + (currentUser?.username || ''));
    renderFolders();
    renderMailList();
    closeCompose();
    toast('E-Mail wurde an Resend übergeben.');
  } catch (error) {
    status.textContent = error?.message || 'E-Mail konnte nicht gesendet werden.';
    status.classList.add('error');
  } finally {
    button.disabled = false;
    button.textContent = 'Senden ↗';
  }
}

async function claimMailbox(event) {
  event.preventDefault();
  const status = $('claimStatus');
  const button = $('claimMailboxButton');
  button.disabled = true;
  button.textContent = 'Wird angelegt…';
  status.textContent = '';
  status.classList.remove('error');
  try {
    await api('/mailbox/claim', 'POST', { localPart: $('mailboxLocalPart').value.trim().toLowerCase() });
    await loadMailbox();
    toast('Dein Postfach ist bereit.');
  } catch (error) {
    status.textContent = error?.message || 'Adresse konnte nicht angelegt werden.';
    status.classList.add('error');
  } finally {
    button.disabled = false;
    button.textContent = 'Postfach anlegen';
  }
}

async function copyAddress() {
  if (!mailbox?.address) return;
  try { await navigator.clipboard.writeText(mailbox.address); toast('E-Mail-Adresse kopiert.'); }
  catch { toast('Kopieren wurde vom Browser blockiert.', true); }
}

async function copyMessageText() {
  const message = messages.find((item) => Number(item.id) === Number(activeMessageId));
  if (!message) return;
  try { await navigator.clipboard.writeText((message.subject || '') + '\n\n' + (message.text_body || '')); toast('E-Mail-Text kopiert.'); }
  catch { toast('Kopieren wurde vom Browser blockiert.', true); }
}

async function boot() {
  if (!token) { window.location.replace('/chat/'); return; }
  try {
    const verified = await api('/verify-token', 'POST');
    currentUser = verified.user || null;
    if (verified.token) { token = verified.token; localStorage.setItem('token', token); }
    $('mailApp').hidden = false;
    await loadMailbox();
  } catch {
    localStorage.removeItem('token');
    window.location.replace('/chat/');
  }
}

$('claimMailboxForm').addEventListener('submit', claimMailbox);
$('refreshButton').addEventListener('click', async () => { try { await loadMailbox(true); toast('Postfach aktualisiert.'); } catch (error) { toast(error.message || 'Postfach konnte nicht geladen werden.', true); } });
$('copyAddressButton').addEventListener('click', copyAddress);
$('copyAddressTextButton').addEventListener('click', copyAddress);
$('mailSearch').addEventListener('input', renderMailList);
document.querySelectorAll('.folder-button').forEach((button) => button.addEventListener('click', () => { activeFilter = button.dataset.filter; activeMessageId = null; renderFolders(); renderMailList(); renderDetail(null); $('mailboxShell').classList.remove('detail-open', 'folders-open'); }));
$('composeFab').addEventListener('click', () => openCompose());
$('closeComposeButton').addEventListener('click', closeCompose);
$('composeOverlay').addEventListener('click', (event) => { if (event.target === $('composeOverlay')) closeCompose(); });
$('composeForm').addEventListener('submit', sendMessage);
$('saveDraftButton').addEventListener('click', () => saveDraft(true));
$('replyButton').addEventListener('click', () => { const message = messages.find((item) => Number(item.id) === Number(activeMessageId)); if (message) openCompose({ to: message.sender_address || '', subject: /^re:/i.test(message.subject || '') ? message.subject : 'Re: ' + (message.subject || '') }); });
$('copyMessageButton').addEventListener('click', copyMessageText);
$('mobileFoldersButton').addEventListener('click', () => $('mailboxShell').classList.toggle('folders-open'));
$('mobileBackToList').addEventListener('click', () => $('mailboxShell').classList.remove('detail-open'));
setInterval(() => { loadMailbox(false).catch(() => {}); }, 15000);
boot();
