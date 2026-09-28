'use strict';
const API_ORIGIN = window.location.protocol === 'file:' ? 'https://ehoser.de' : window.location.origin;
const API = API_ORIGIN + '/api';

// Robust date parser: server may return UTC timestamps without timezone
function parseServerDate(s) {
    if (!s) return new Date();
    if (typeof s === 'number') return new Date(s);
    let str = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) {
        str = str.replace(' ', 'T');
    }
    const date = new Date(str);
    if (Number.isNaN(date.valueOf())) return new Date();
    date.setHours(date.getHours() + 2);
    return date;
}

function safeJsonParse(value, fallback = null) {
    if (typeof value !== 'string') {
        return value && typeof value === 'object' ? value : fallback;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'plain' || trimmed === 'null') return fallback;
    try {
        return JSON.parse(trimmed);
    } catch {
        return fallback;
    }
}

// ─── State ────────────────────────────────────────────────────────────────────
let _token = null, _me = null;
let _meProfile = null;
let _groups = [], _activeGroupId = null;
let _lastMsgId = {};
let _proBadgeCache = {};
let _poll = null;
let _ngMembers = {}; // selected members for a new group
let _recorder = null, _recChunks = [], _recTimer = null, _recSecs = 0;
let _attachOpen = false;
let _summaryAiEnabled = false;
let _seenMessageIds = {};
let _pendingMessages = {};
let _messageNotificationCursor = 0;
let _chatStarted = false;
let _activeMembers = [];
let _callPoll = null;
let _incomingCall = null;
let _currentCall = null;
let _peerConnection = null;
let _localCallStream = null;
let _remoteCallStream = null;
let _queuedIceCandidates = [];
let _pendingLocalIce = [];
let _lastCallSignalId = 0;
let _callTimerTick = null;
let _callStartedAt = null;
let _ringTimer = null;
let _ringAudioContext = null;
let _notifiedIncomingCallId = null;
let _finishingCall = false;
let _callPollBusy = false;
let _chatServiceWorkerReady = null;

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 4
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
    _token = localStorage.getItem('token');
    if (!_token) { show('loginWall'); return; }
    try {
        // Raw fetch statt api() – wir brauchen den genauen Status-Code
        const resp = await fetch(API + '/verify-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token }
        });
        if (resp.status === 401) {
            // Token abgelaufen → einmalig neu anmelden nötig (nur 1x, dann 10 Jahre gültig)
            localStorage.removeItem('proStatus');
            const wall = document.getElementById('loginWall');
            wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">🔑</div><h2>Erneut anmelden</h2><p style="color:#a88">Deine Sitzung ist abgelaufen. Melde dich neu an.</p><a href="/" class="btn-primary" style="margin-top:8px;display:block;text-align:center">Zur Anmeldung</a></div>`;
            show('loginWall');
            return;
        }
        if (!resp.ok) {
            // Server-Fehler: Token behalten, Retry anbieten
            const wall = document.getElementById('loginWall');
            wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">⚠️</div><h2>Verbindungsfehler</h2><p>Der Server antwortet nicht. Bitte versuche es erneut.</p><button class="btn-primary" onclick="location.reload()">Neu laden</button><a href="/" class="btn-secondary" style="margin-top:8px;display:block">Zurück zur Anmeldung</a></div>`;
            show('loginWall');
            return;
        }
        const r = await resp.json();
        _me = r.user;
        if (r.token) {
            _token = r.token;
            localStorage.setItem('token', r.token);
        }
        _meProfile = r.profile || null;
        // 🔥 Pro-Status in localStorage speichern
        localStorage.setItem('proStatus', _meProfile?.isPro ? '1' : '0');
        if (!_meProfile) {
            try {
                const meData = await api('/me');
                _meProfile = meData.profile || null;
                localStorage.setItem('proStatus', _meProfile?.isPro ? '1' : '0');
            } catch {
                _meProfile = null;
                // 🔥 Fallback zu localStorage cached value
                const cached = localStorage.getItem('proStatus');
                if (cached === '1') {
                    _meProfile = { isPro: true };
                }
            }
        }
    } catch {
        // Netzwerkfehler: Token behalten, Retry anbieten
        const wall = document.getElementById('loginWall');
        wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">⚠️</div><h2>Keine Verbindung</h2><p>Netzwerkfehler. Bitte überprüfe deine Verbindung.</p><button class="btn-primary" onclick="location.reload()">Neu laden</button><a href="/" class="btn-secondary" style="margin-top:8px;display:block">Zurück zur Anmeldung</a></div>`;
        show('loginWall');
        return;
    }
    if (!('Notification' in window)) {
        showNotificationWall('Dein Browser unterstützt keine Benachrichtigungen. Öffne den Chat bitte in Chrome, Edge oder Firefox.');
        return;
    }
    if (Notification.permission !== 'granted') {
        showNotificationWall(window.Notification?.permission === 'denied'
            ? 'Benachrichtigungen sind blockiert. Erlaube sie in den Website-Einstellungen und lade die Seite neu.'
            : '');
        return;
    }
    await finishChatBoot();
})();

async function finishChatBoot() {
    if (_chatStarted) return;
    _chatStarted = true;
    show('chatApp');
    document.getElementById('sidebarMe').textContent = '👤 ' + _me.username;
    if (_meProfile?.isPro) {
        const proStickerItem = document.getElementById('proStickerItem');
        if (proStickerItem) proStickerItem.style.display = '';
    }
    _summaryAiEnabled = localStorage.getItem('ehoserAiSummary') === '1' && Boolean(_meProfile?.isPro);
    if ('serviceWorker' in navigator) {
        _chatServiceWorkerReady = navigator.serviceWorker.register('service-worker.js')
            .then(() => navigator.serviceWorker.ready)
            .catch(() => null);
    }
    await loadGroups();
    await pollMessageNotifications(true);
    _poll = setInterval(pollMessages, 3000);
    _callPoll = setInterval(pollCalls, 1500);
    pollCalls();
    document.addEventListener('click', globalClickClose);
    updateAiSummaryToggle();
}

function showNotificationWall(message = '') {
    show('notificationWall');
    const help = document.getElementById('notificationHelp');
    const button = document.getElementById('notificationEnableBtn');
    if (help) help.textContent = message;
    if (button) {
        const unsupported = !('Notification' in window);
        button.disabled = unsupported;
        button.textContent = window.Notification?.permission === 'denied' ? 'Erneut prüfen' : 'Benachrichtigungen erlauben';
    }
}

async function enableChatNotifications() {
    const help = document.getElementById('notificationHelp');
    if (!('Notification' in window)) {
        if (help) help.textContent = 'Benachrichtigungen werden von diesem Browser nicht unterstützt.';
        return;
    }
    if (Notification.permission === 'denied') {
        if (help) help.textContent = 'Öffne die Website-Einstellungen, erlaube Benachrichtigungen und lade die Seite neu.';
        return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        if (help) help.textContent = 'Ohne Benachrichtigungen kann ehoser Chat nicht geöffnet werden.';
        return;
    }
    if (help) help.textContent = '';
    if (_chatStarted) show('chatApp');
    else await finishChatBoot();
}

function enforceNotificationPermission() {
    const allowed = 'Notification' in window && Notification.permission === 'granted';
    if (!allowed && _me) {
        showNotificationWall(window.Notification?.permission === 'denied'
            ? 'Benachrichtigungen sind blockiert. Erlaube sie in den Website-Einstellungen und lade die Seite neu.'
            : 'Aktiviere Benachrichtigungen, um weiter zu chatten.');
    }
    return allowed;
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _chatStarted) enforceNotificationPermission();
});

function notifyChat(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, tag, icon: '/favicon.svg', badge: '/favicon.svg' };
    if (_chatServiceWorkerReady) {
        _chatServiceWorkerReady.then((registration) => {
            if (registration) return registration.showNotification(title, options);
            try { new Notification(title, options); } catch {}
        }).catch(() => {});
        return;
    }
    try {
        const notification = new Notification(title, options);
        notification.onclick = () => { window.focus(); notification.close(); };
    } catch {}
}

function show(id) {
    ['loginWall','notificationWall','chatApp'].forEach(i => {
        const el = document.getElementById(i);
        if (el) el.style.display = i === id ? 'flex' : 'none';
    });
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(API + path, opts);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
}

async function uploadFile(file, onLabel) {
    if (onLabel) document.getElementById('uploadLabel').textContent = onLabel;
    const ov = document.getElementById('uploadOverlay');
    ov.style.display = 'flex';
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(API + '/chat/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + _token },
        body: fd
    });
    ov.style.display = 'none';
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Upload fehlgeschlagen'); }
    return r.json();
}

// New chat messages are stored as ordinary JSON text. Older encrypted records
// cannot be decoded after encryption is disabled and are shown as legacy items.
function readStoredMessage(value) {
    const parsed = safeJsonParse(value, null);
    if (parsed && typeof parsed === 'object' && parsed.iv && parsed.c) return null;
    return typeof value === 'string' ? value : JSON.stringify(value || '');
}

// ─── Groups ───────────────────────────────────────────────────────────────────
async function loadGroups() {
    try {
        const { groups } = await api('/chat/groups');
        _groups = groups || [];
        renderGroupList();
    } catch (e) { toast('Fehler: ' + e.message, 'err'); }
}

function renderGroupList() {
    const el = document.getElementById('groupList');
    if (!_groups.length) { el.innerHTML = '<p class="empty-hint">Keine Gruppen.<br>Erstelle eine neue!</p>'; return; }
    el.innerHTML = _groups.map(g => `
        <div class="group-item${_activeGroupId === g.id ? ' active' : ''}" onclick="selectGroup('${g.id}')">
            <div class="gi-avatar">👥</div>
            <div class="gi-info">
                <div class="gi-name">${esc(g.name)}</div>
                <div class="gi-sub">von ${esc(g.created_by)}</div>
            </div>
        </div>`).join('');
}

function updateAiSummaryToggle() {
    const btn = document.getElementById('chatAiSummaryToggle');
    if (!btn) return;
    const enabled = _summaryAiEnabled && Boolean(_meProfile?.isPro);
    btn.classList.toggle('active', enabled);
    btn.textContent = enabled ? '🤖 ehoser AI • AN' : '🤖 ehoser AI';
    btn.title = enabled
        ? 'ehoser AI ist aktiv und fasst die letzten Nachrichten zusammen.'
        : _meProfile?.isPro ? 'ehoser AI für die Gruppen-Zusammenfassung aktivieren' : 'Nur für PRO-Nutzer verfügbar';
}

function ensureSummaryAccess() {
    if (!_meProfile?.isPro) {
        toast('ehoser AI-Zusammenfassung ist nur für PRO-Nutzer verfügbar.', 'err');
        return false;
    }
    return true;
}

async function toggleEhoserAiSummary() {
    if (!ensureSummaryAccess()) return;
    _summaryAiEnabled = !_summaryAiEnabled;
    localStorage.setItem('ehoserAiSummary', _summaryAiEnabled ? '1' : '0');
    updateAiSummaryToggle();
    if (_summaryAiEnabled && _activeGroupId) {
        appendMessage({ id: 'summary-toggle-' + Date.now(), sender: 'ehoser AI', created_at: new Date().toISOString(), content: '' }, JSON.stringify({ t: 'ai_summary', summary: 'Die KI-Zusammenfassung ist für diesen Chat aktiviert.' }));
        const a = document.getElementById('messagesArea'); if (a) a.scrollTop = a.scrollHeight;
    }
}

function markMessageSeen(gid, id) {
    if (!gid || !id) return;
    if (!_seenMessageIds[gid]) _seenMessageIds[gid] = new Set();
    _seenMessageIds[gid].add(String(id));
}

function isMessageSeen(gid, id) {
    if (!gid || !id) return false;
    return Boolean(_seenMessageIds[gid]?.has(String(id)));
}

async function selectGroup(gid) {
    _activeGroupId = gid;
    renderGroupList();
    const g = _groups.find(x => x.id === gid);
    if (!g) return;
    _seenMessageIds[gid] = new Set();
    document.getElementById('noGroup').style.display = 'none';
    const ac = document.getElementById('activeChat');
    ac.style.display = 'flex';
    document.getElementById('topbarName').textContent = g.name;
    document.getElementById('topbarMeta').textContent = 'Mitglieder werden geladen…';
    document.getElementById('messagesArea').innerHTML = '<div class="msg-loading">Nachrichten werden geladen…</div>';
    _activeMembers = [];
    updateCallButtons();
    try {
        const { members } = await api('/chat/groups/' + gid + '/members');
        _activeMembers = members || [];
        document.getElementById('topbarMeta').textContent = _activeMembers.length + ' Mitglied' + (_activeMembers.length !== 1 ? 'er' : '');
    } catch {}
    updateCallButtons();
    _lastMsgId[gid] = 0;
    await loadMessages(gid, true);
    document.getElementById('msgInput').focus();
    updateAiSummaryToggle();
}

function updateCallButtons() {
    const supported = Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
    const canCall = supported && _activeMembers.length === 2 && !_currentCall && !_incomingCall;
    const reason = !supported
        ? 'Anrufe werden von diesem Browser nicht unterstützt'
        : _activeMembers.length !== 2
            ? 'Anrufe sind in Chats mit genau 2 Mitgliedern verfügbar'
            : _currentCall || _incomingCall ? 'Du bist bereits in einem Anruf' : '';
    ['audioCallBtn', 'videoCallBtn'].forEach((id) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = !canCall;
        if (reason) button.title = reason;
        else button.title = id === 'audioCallBtn' ? 'Audioanruf starten' : 'Videoanruf starten';
    });
}

async function pollMessages() {
    if (_activeGroupId) await loadMessages(_activeGroupId, false);
    await pollMessageNotifications(false);
}

async function pollMessageNotifications(initial = false) {
    try {
        const data = await api('/chat/notifications?after=' + (initial ? 0 : _messageNotificationCursor));
        _messageNotificationCursor = Math.max(_messageNotificationCursor, Number(data.cursor) || 0);
        if (initial) return;
        for (const message of data.messages || []) {
            if (message.sender === _me?.username) continue;
            const chatVisible = !document.hidden && message.group_id === _activeGroupId;
            if (chatVisible) continue;
            const groupName = _groups.find((group) => group.id === message.group_id)?.name || 'ehoser Chat';
            notifyChat(groupName, 'Neue Nachricht von ' + (message.sender || 'jemandem'), 'chat-message-' + message.group_id);
        }
    } catch {
        // Notifications must never stop chat polling.
    }
}

async function loadMessages(gid, initial) {
    try {
        const after = _lastMsgId[gid] || 0;
        const { messages } = await api('/chat/messages/' + gid + '?after=' + after);
        if (!messages.length) {
            if (initial) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#2a5060">Noch keine Nachrichten.</div>';
            return;
        }
        await fetchProBadges(messages.map((m) => m.sender));
        if (initial) document.getElementById('messagesArea').innerHTML = '';
        for (const m of messages) {
            if (gid !== _activeGroupId) break;
            // Try to find an existing DOM element for this message
            const existingEl = document.querySelector(`[data-msgid="${m.id}"]`);
            const plain = readStoredMessage(m.content);
            if (existingEl) {
                // If stored content changed, update DOM silently
                if (existingEl.dataset.stored !== m.content) {
                    existingEl.dataset.stored = m.content;
                    existingEl.dataset.plain = plain ? encodeURIComponent(plain) : '';
                    const bubble = existingEl.querySelector('.msg-bubble');
                    try {
                        const pj = safeJsonParse(plain, { t: 'txt', v: String(plain || '') });
                        if (pj && pj.t === 'txt') bubble.innerHTML = esc(pj.v || '').replace(/\n/g, '<br>');
                        else bubble.innerHTML = renderContent(pj);
                    } catch (e) {
                        bubble.innerHTML = plain || '';
                    }
                }
                markMessageSeen(gid, m.id);
                _lastMsgId[gid] = Math.max(_lastMsgId[gid] || 0, Number(m.id) || 0);
                continue;
            }
            if (isMessageSeen(gid, m.id)) continue;
            appendMessage(m, plain);
            markMessageSeen(gid, m.id);
            _lastMsgId[gid] = Math.max(_lastMsgId[gid] || 0, Number(m.id) || 0);
        }
        if (gid === _activeGroupId) { const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight; }
    } catch (e) {
        if (initial) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#c05050">Fehler: ' + esc(e.message) + '</div>';
    }
}

function appendMessage(m, plainJson) {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    if (m?.id && _activeGroupId && isMessageSeen(_activeGroupId, m.id)) return;
    const own = m.sender === _me?.username;
    const ts = parseServerDate(m.created_at || Date.now());
    const dateStr = ts.toLocaleDateString('de-DE');
    const timeStr = ts.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const time = dateStr + ' ' + timeStr;
    let content = '';
    if (plainJson === null) {
        content = '<span class="decrypt-err">Alte verschlüsselte Nachricht</span>';
    } else {
        const parsed = safeJsonParse(plainJson, { t: 'txt', v: String(plainJson || '') });
        content = renderContent(parsed);
    }
    const row = document.createElement('div');
    row.className = 'msg-row' + (own ? ' own' : '');
    const senderName = m.sender || 'ehoser AI';
    const isSenderPro = senderName !== 'ehoser AI' && _proBadgeCache[senderName]?.isPro;
    const senderBadge = isSenderPro ? '<span class="msg-pro-badge">⭐ PRO</span>' : '';
    const senderClass = isSenderPro ? 'msg-sender pro-sender' : 'msg-sender';
    const avatarClass = isSenderPro && !own ? 'msg-avatar pro-av' : 'msg-avatar';
    const avatarText = senderName === 'ehoser AI' ? 'AI' : esc(senderName.substring(0,2).toUpperCase());
    row.innerHTML = `
        <div class="${avatarClass}">${avatarText}</div>
        <div class="msg-body">
            ${(!own && senderName !== 'ehoser AI') ? '<span class="' + senderClass + '">' + esc(senderName) + senderBadge + '</span>' : ''}
            <div class="msg-bubble">${content}</div>
            <span class="msg-time">${time}</span>
        </div>`;
    // attach metadata for future updates
    if (m?.id && !String(m.id).startsWith('tmp-')) {
        row.dataset.msgid = String(m.id);
        row.dataset.stored = m.content || '';
        row.dataset.plain = plainJson ? encodeURIComponent(plainJson) : '';
    }
    // temp-id handling: if message id looks like a client-temp id, mark element as pending
    if (String(m.id || '').startsWith('tmp-')) {
        row.dataset.tempid = m.id;
        row.classList.add('pending');
        // store pending meta for potential matching
        _pendingMessages[m.id] = { sender: senderName, content };
        area.appendChild(row);
        return;
    }

    // If there is an existing pending element that matches this content and sender (optimistic), upgrade it
    const pendingEls = area.querySelectorAll('[data-tempid]');
    for (const pe of pendingEls) {
        try {
            const pb = pe.querySelector('.msg-bubble')?.innerHTML || '';
            const pSenderOwn = pe.classList.contains('own');
            if (pb === content && pSenderOwn === own) {
                // upgrade pending element
                const tempKey = pe.getAttribute('data-tempid');
                pe.dataset.msgid = String(m.id);
                pe.dataset.stored = m.content || '';
                pe.dataset.plain = plainJson ? encodeURIComponent(plainJson) : '';
                pe.removeAttribute('data-tempid');
                pe.classList.remove('pending');
                // update time (include date)
                const timeEl = pe.querySelector('.msg-time'); if (timeEl) timeEl.textContent = time;
                if (_activeGroupId && m.id) markMessageSeen(_activeGroupId, m.id);
                if (tempKey) delete _pendingMessages[tempKey];
                return;
            }
        } catch {}
    }
    // If the special editor user, add an edit button
    try {
        const debugEdit = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug_edit') === '1';
        if ((_me && _me.username === 'meisterlool_707') || debugEdit) {
            const btn = document.createElement('button');
            btn.className = 'msg-edit-btn';
            btn.textContent = 'Bearbeiten';
            btn.onclick = () => startEditMessage(row);
            const body = row.querySelector('.msg-body'); if (body) body.appendChild(btn);
        }
    } catch (e) {}
    area.appendChild(row);
    if (m?.id && _activeGroupId) markMessageSeen(_activeGroupId, m.id);
}

function renderContent(p) {
    if (!p || typeof p !== 'object') return esc(String(p));
    switch (p.t) {
        case 'txt': return esc(p.v || '').replace(/\n/g, '<br>');
        case 'img': return `<img class="msg-img" src="${esc(p.url)}" alt="${esc(p.name||'Bild')}" loading="lazy" onclick="viewImg(this.src)">`;
        case 'vid': return `<video class="msg-video" src="${esc(p.url)}" controls preload="metadata"></video>`;
        case 'aud': return renderAudio(p);
        case 'fw':  return `<img class="msg-img" src="${esc(p.url)}" alt="Face Warp" loading="lazy" onclick="viewImg(this.src)"><div class="msg-fw-label">🎭 Face Warp</div>`;
        case 'pro_sticker': return renderProSticker(p);
        case 'file': return renderFile(p);
        case 'ai_summary': return `<div class="ai-summary-card"><div class="ai-summary-header">🤖 ehoser AI</div><div>${esc(p.summary || '').replace(/\n/g, '<br>')}</div></div>`;
        default: return esc(JSON.stringify(p));
    }
}

function renderProSticker(p) {
    const label = p?.label || 'ehoser PRO';
    return `<div class="pro-sticker"><span class="pro-sticker-logo">E</span><span>${esc(label)}</span></div>`;
}

function renderAudio(p) {
    const bars = Array.from({length:18}, (_,i) => {
        const h = 6 + Math.round(Math.abs(Math.sin(i * 0.7)) * 16);
        return `<div class="wave-bar" style="height:${h}px"></div>`;
    }).join('');
    const dur = p.dur ? fmtTime(p.dur) : '';
    return `<div class="msg-audio-player">
        <button class="msg-audio-play" onclick="playAudio('${esc(p.url)}', this)">▶</button>
        <div class="msg-audio-wave">${bars}</div>
        <span class="msg-audio-dur">${dur}</span>
    </div>`;
}

function renderFile(p) {
    const icons = { pdf:'📄', zip:'🗜️', txt:'📃', doc:'📝', docx:'📝' };
    const ext = (p.name||'').split('.').pop().toLowerCase();
    const icon = icons[ext] || '📎';
    const size = p.size ? fmtSize(p.size) : '';
    return `<div class="msg-file">
        <div class="msg-file-icon">${icon}</div>
        <div class="msg-file-info">
            <span class="msg-file-name">${esc(p.name||'Datei')}</span>
            ${size ? '<span class="msg-file-size">' + size + '</span>' : ''}
            <a class="msg-file-dl" href="${esc(p.url)}" target="_blank" download="${esc(p.name||'file')}">⬇ Herunterladen</a>
        </div>
    </div>`;
}

// Context menu handler for message edit (right-click) — attach globally to document
function initMessageContextMenu() {
    if (window._ehoserCtxAttached) return;

    function showCtxMenuForRow(row, x, y) {
        try {
            const existing = document.getElementById('ehoser-ctx-menu'); if (existing) existing.remove();
            const menu = document.createElement('div');
            menu.id = 'ehoser-ctx-menu';
            menu.style.position = 'fixed';
            menu.style.left = (x + 4) + 'px';
            menu.style.top = (y + 4) + 'px';
            menu.style.background = '#0f1724';
            menu.style.color = '#e6eef6';
            menu.style.padding = '6px 8px';
            menu.style.border = '1px solid rgba(255,255,255,0.06)';
            menu.style.borderRadius = '6px';
            menu.style.zIndex = 999999;
            menu.style.boxShadow = '0 6px 18px rgba(2,6,23,0.6)';
            menu.style.fontSize = '0.95rem';
            menu.style.cursor = 'default';
            const it = document.createElement('div');
            it.textContent = 'Bearbeiten';
            it.style.padding = '6px 10px';
            it.style.borderRadius = '4px';
            it.onmouseenter = () => it.style.background = 'rgba(255,255,255,0.03)';
            it.onmouseleave = () => it.style.background = 'transparent';
            it.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); menu.remove(); startEditMessage(row); };
            menu.appendChild(it);
            document.body.appendChild(menu);
            const closer = () => { menu.remove(); document.removeEventListener('click', closer); window.removeEventListener('scroll', closer, true); };
            document.addEventListener('click', closer);
            window.addEventListener('scroll', closer, true);
        } catch (err) { }
    }

    // handle contextmenu and mousedown to reliably catch right-clicks across browsers
    const onCtx = function(e) {
        try {
            const row = e.target.closest('.msg-row');
            if (!row) return;
            const msgId = row.dataset.msgid;
            if (!msgId) return;
            const debugEdit = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug_edit') === '1';
            const canEdit = (window._me && window._me.username === 'meisterlool_707') || debugEdit;
            if (!canEdit) return;
            e.preventDefault();
            showCtxMenuForRow(row, e.clientX, e.clientY);
        } catch (err) {}
    };

    const onMouseDown = function(e) {
        try {
            if (e.button !== 2) return; // right button
            const row = e.target.closest('.msg-row');
            if (!row) return;
            const msgId = row.dataset.msgid; if (!msgId) return;
            const debugEdit = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug_edit') === '1';
            const canEdit = (window._me && window._me.username === 'meisterlool_707') || debugEdit;
            if (!canEdit) return;
            // prevent native menu from appearing
            e.preventDefault();
            showCtxMenuForRow(row, e.clientX, e.clientY);
        } catch (err) {}
    };

    document.addEventListener('contextmenu', onCtx);
    document.addEventListener('mousedown', onMouseDown, true);
    window._ehoserCtxAttached = true;
}

// Initialize immediately
initMessageContextMenu();

// --- Message editing (client) -------------------------------------------------
async function startEditMessage(row) {
    if (!row) return;
    const msgId = row.dataset.msgid;
    if (!msgId) return alert('Keine editierbare Nachricht');
    const plainEnc = row.dataset.plain || '';
    const plain = plainEnc ? decodeURIComponent(plainEnc) : null;
    let currText = '';
    try {
        const pj = safeJsonParse(plain, null);
        if (!pj || pj.t !== 'txt') return alert('Nur Textnachrichten können bearbeitet werden');
        currText = pj.v || '';
    } catch (e) { return alert('Fehler beim Lesen der Nachricht'); }
    const newText = prompt('Bearbeite Nachricht:', currText);
    if (newText === null) return; // Abgebrochen
    await editMessage(msgId, newText, row);
}

async function editMessage(msgId, newText, row) {
    try {
        const gid = _activeGroupId;
        if (!gid) throw new Error('Keine Gruppe aktiv');
        const plainObj = { t: 'txt', v: String(newText) };
        const storedContent = JSON.stringify(plainObj);
        await api('/chat/messages/' + msgId, 'PATCH', { content: storedContent });
        // Update DOM silently
        row.dataset.stored = storedContent;
        row.dataset.plain = encodeURIComponent(JSON.stringify(plainObj));
        const bubble = row.querySelector('.msg-bubble'); if (bubble) bubble.innerHTML = esc(plainObj.v).replace(/\n/g, '<br>');
    } catch (e) { toast('Bearbeiten fehlgeschlagen: ' + e.message, 'err'); }
}

// ─── Send ─────────────────────────────────────────────────────────────────────
function summarizeChatMessages(messages) {
    const clean = (messages || [])
        .map((msg) => {
            if (!msg || typeof msg !== 'string') return '';
            return msg.replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean)
        .slice(-6);
    if (!clean.length) return 'Keine neuen Inhalte in der Gruppe.';
    const core = clean.slice(0, 3).join(' • ');
    return clean.length > 3 ? `Kürzliche Themen: ${core}.` : `Letzte Meldungen: ${core}.`;
}

async function triggerChatAiSummary() {
    if (!_activeGroupId || !_summaryAiEnabled || !_meProfile?.isPro) return;
    try {
        const after = _lastMsgId[_activeGroupId] || 0;
        const { messages } = await api('/chat/messages/' + _activeGroupId + '?after=' + after);
        if (!messages.length) return;
        const summaries = [];
        for (const m of messages.slice(-6)) {
            if (!m?.content) continue;
            try {
                const plain = readStoredMessage(m.content);
                if (!plain) continue;
                const parsed = safeJsonParse(plain, { t: 'txt', v: String(plain || '') });
                if (parsed?.t === 'txt' && typeof parsed.v === 'string' && parsed.v.trim()) summaries.push(parsed.v.trim());
            } catch {}
        }
        const summaryText = summarizeChatMessages(summaries);
        appendMessage({ id: 'ai-summary-' + Date.now(), sender: 'ehoser AI', created_at: new Date().toISOString(), content: '' }, JSON.stringify({ t: 'ai_summary', summary: summaryText }));
        const area = document.getElementById('messagesArea'); if (area) area.scrollTop = area.scrollHeight;
    } catch {}
}

async function sendMessage() {
    if (!enforceNotificationPermission()) return;
    const inp = document.getElementById('msgInput');
    const text = inp.value.trim();
    if (!text || !_activeGroupId) return;
    inp.value = ''; inp.style.height = ''; inp.disabled = true;
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    appendMessage({ id: tempId, sender: _me.username, created_at: new Date().toISOString(), content: '' }, JSON.stringify({ t:'txt', v:text }));
    try {
        const storedContent = JSON.stringify({ t:'txt', v:text });
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, content: storedContent });
        // finalize optimistic message (upgrade pending element or append if missing)
        finalizePendingMessage(tempId, id, created_at, storedContent, storedContent);
        _lastMsgId[_activeGroupId] = id;
        if (_summaryAiEnabled && _meProfile?.isPro) {
            setTimeout(() => triggerChatAiSummary(), 300);
        }
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { toast('Fehler: ' + e.message, 'err'); inp.value = text; }
    finally { inp.disabled = false; inp.focus(); }
}

async function sendMediaMessage(payload) {
    if (!enforceNotificationPermission()) return;
    if (!_activeGroupId) return;
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    appendMessage({ id: tempId, sender: _me.username, created_at: new Date().toISOString(), content: '' }, JSON.stringify(payload));
    try {
        const storedContent = JSON.stringify(payload);
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, content: storedContent });
        finalizePendingMessage(tempId, id, created_at, storedContent, storedContent);
        _lastMsgId[_activeGroupId] = id;
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { const el = document.querySelector(`[data-tempid="${tempId}"]`); if (el) el.classList.add('send-failed'); toast('Senden fehlgeschlagen: ' + e.message, 'err'); }
}

function finalizePendingMessage(tempId, realId, created_at, content, plainJson) {
    try {
        const area = document.getElementById('messagesArea'); if (!area) return;
        const el = area.querySelector(`[data-tempid="${tempId}"]`);
        if (el) {
            el.dataset.msgid = String(realId);
            el.removeAttribute('data-tempid');
            el.classList.remove('pending');
            const ts2 = parseServerDate(created_at || Date.now());
            const dateStr2 = ts2.toLocaleDateString('de-DE');
            const timeStr2 = ts2.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
            const timeFull = dateStr2 + ' ' + timeStr2;
            const timeEl = el.querySelector('.msg-time'); if (timeEl) timeEl.textContent = timeFull;
            if (_activeGroupId && realId) markMessageSeen(_activeGroupId, realId);
            delete _pendingMessages[tempId];
            return;
        }
        // fallback: append server message if pending element not present
        appendMessage({ id: realId, sender: _me.username, created_at, content }, plainJson);
        if (_activeGroupId && realId) markMessageSeen(_activeGroupId, realId);
    } catch (e) { console.error('finalizePendingMessage error', e); }
}

function handleMsgKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ─── File Attach ──────────────────────────────────────────────────────────────
function toggleAttachMenu() {
    const m = document.getElementById('attachMenu');
    _attachOpen = !_attachOpen;
    m.style.display = _attachOpen ? 'block' : 'none';
    document.getElementById('attachBtn').classList.toggle('active', _attachOpen);
}

function globalClickClose(e) {
    if (!document.getElementById('attachWrap').contains(e.target)) {
        document.getElementById('attachMenu').style.display = 'none';
        document.getElementById('attachBtn').classList.remove('active');
        _attachOpen = false;
    }
}

async function handleFilePick(input, kind) {
    toggleAttachMenu();
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        const res = await uploadFile(file, 'Wird hochgeladen… ' + file.name);
        let payload;
        const mime = res.mime || '';
        if (mime.startsWith('image/'))      payload = { t:'img',  url:res.url, name:res.name, size:res.size };
        else if (mime.startsWith('video/')) payload = { t:'vid',  url:res.url, name:res.name, size:res.size };
        else                                payload = { t:'file', url:res.url, name:res.name, size:res.size };
        await sendMediaMessage(payload);
    } catch (e) { toast('Upload: ' + e.message, 'err'); }
}

// ─── Voice ────────────────────────────────────────────────────────────────────
async function toggleVoice() {
    if (_recorder && _recorder.state === 'recording') {
        stopVoice();
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            _recChunks = []; _recSecs = 0;
            _recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg' });
            _recorder.ondataavailable = e => { if (e.data.size > 0) _recChunks.push(e.data); };
            _recorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                const blob = new Blob(_recChunks, { type: _recorder.mimeType });
                const dur = _recSecs;
                clearInterval(_recTimer);
                document.getElementById('voiceUI').style.display = 'none';
                document.getElementById('micBtn').classList.remove('active');
                if (!_cancelled) {
                    try {
                        const file = new File([blob], 'voice.' + (_recorder.mimeType.includes('webm') ? 'webm' : 'ogg'), { type: _recorder.mimeType });
                        const res = await uploadFile(file, 'Sprachnachricht wird hochgeladen…');
                        await sendMediaMessage({ t:'aud', url:res.url, dur });
                    } catch(e) { toast('Fehler: ' + e.message, 'err'); }
                }
            };
            _cancelled = false;
            _recorder.start();
            document.getElementById('voiceUI').style.display = 'flex';
            document.getElementById('msgInput').style.display = 'none';
            document.getElementById('sendBtnWrap') && (document.getElementById('sendBtnWrap').style.display = 'none');
            document.getElementById('micBtn').classList.add('active');
            _recTimer = setInterval(() => {
                _recSecs++;
                const m = Math.floor(_recSecs/60), s = _recSecs % 60;
                document.getElementById('recTimer').textContent = m + ':' + String(s).padStart(2,'0');
            }, 1000);
        } catch(e) { toast('Mikrofon: ' + e.message, 'err'); }
    }
}

let _cancelled = false;

function cancelVoice() {
    _cancelled = true;
    if (_recorder) _recorder.stop();
    clearInterval(_recTimer);
    document.getElementById('voiceUI').style.display = 'none';
    document.getElementById('msgInput').style.display = '';
    document.getElementById('micBtn').classList.remove('active');
}

function stopVoice() {
    _cancelled = false;
    if (_recorder) _recorder.stop();
    document.getElementById('voiceUI').style.display = 'none';
    document.getElementById('msgInput').style.display = '';
}

function playAudio(url, btn) {
    const audio = new Audio(url);
    btn.textContent = '⏸';
    audio.play();
    audio.onended = () => btn.textContent = '▶';
}

// ─── Audio & video calls ─────────────────────────────────────────────────────
function activeCallPeer() {
    return _activeMembers.find((member) => member.username !== _me?.username)?.username || null;
}

function callInitials(username) {
    return String(username || '?').slice(0, 2).toUpperCase();
}

function parseRtcValue(value) {
    return typeof value === 'string' ? safeJsonParse(value, null) : value;
}

function openCallUi(peerName, status, withLocalVideo = false) {
    const overlay = document.getElementById('callOverlay');
    document.getElementById('callPeerName').textContent = peerName || 'Anruf';
    document.getElementById('callAvatar').textContent = callInitials(peerName);
    document.getElementById('callStatus').textContent = status || 'Verbindung wird aufgebaut…';
    document.getElementById('callTimer').textContent = '';
    overlay.classList.remove('video-active');
    overlay.style.display = 'flex';
    document.getElementById('localVideo').classList.toggle('visible', withLocalVideo);
    updateCallControlState();
}

function setCallStatus(text) {
    const status = document.getElementById('callStatus');
    if (status) status.textContent = text;
}

function updateCallControlState() {
    const audioTrack = _localCallStream?.getAudioTracks?.()[0];
    const videoTrack = _localCallStream?.getVideoTracks?.()[0];
    const muteButton = document.getElementById('muteCallBtn');
    const cameraButton = document.getElementById('cameraCallBtn');
    if (muteButton) {
        const muted = Boolean(audioTrack && !audioTrack.enabled);
        muteButton.classList.toggle('active', muted);
        const label = muteButton.querySelector('small');
        if (label) label.textContent = muted ? 'Mikro an' : 'Stumm';
    }
    if (cameraButton) {
        const enabled = Boolean(videoTrack?.enabled);
        cameraButton.classList.toggle('active', enabled);
        const label = cameraButton.querySelector('small');
        if (label) label.textContent = enabled ? 'Kamera aus' : 'Kamera';
    }
    const localVideo = document.getElementById('localVideo');
    if (localVideo) localVideo.classList.toggle('visible', Boolean(videoTrack?.enabled));
}

function updateRemoteVideoState() {
    const remoteVideoTrack = _remoteCallStream?.getVideoTracks?.()[0];
    const enabled = Boolean(remoteVideoTrack && remoteVideoTrack.readyState === 'live' && _currentCall?.remoteVideoEnabled !== false);
    document.getElementById('callOverlay')?.classList.toggle('video-active', enabled);
}

function startCallTimer() {
    if (_callTimerTick) return;
    _callStartedAt = _callStartedAt || Date.now();
    const render = () => {
        const seconds = Math.max(0, Math.floor((Date.now() - _callStartedAt) / 1000));
        const minutes = Math.floor(seconds / 60);
        const label = minutes + ':' + String(seconds % 60).padStart(2, '0');
        const timer = document.getElementById('callTimer');
        if (timer) timer.textContent = label;
    };
    render();
    _callTimerTick = setInterval(render, 1000);
}

async function getCallMedia(withVideo) {
    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: withVideo ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false
    });
}

function createPeerConnection() {
    if (_peerConnection) {
        try { _peerConnection.close(); } catch {}
    }
    _remoteCallStream = new MediaStream();
    _peerConnection = new RTCPeerConnection(RTC_CONFIG);
    _peerConnection.onicecandidate = (event) => {
        if (!event.candidate) return;
        const payload = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
        if (_currentCall?.id) postCallSignal('ice', payload).catch(() => {});
        else _pendingLocalIce.push(payload);
    };
    _peerConnection.ontrack = (event) => {
        const tracks = event.streams?.[0]?.getTracks?.() || [event.track];
        for (const track of tracks) {
            if (!_remoteCallStream.getTracks().some((current) => current.id === track.id)) _remoteCallStream.addTrack(track);
            if (track.kind === 'video') {
                _currentCall && (_currentCall.remoteVideoEnabled = true);
                track.onmute = updateRemoteVideoState;
                track.onunmute = () => {
                    if (_currentCall) _currentCall.remoteVideoEnabled = true;
                    updateRemoteVideoState();
                };
            }
        }
        const remoteVideo = document.getElementById('remoteVideo');
        const remoteAudio = document.getElementById('remoteAudio');
        remoteVideo.muted = true;
        remoteVideo.srcObject = _remoteCallStream;
        remoteAudio.srcObject = _remoteCallStream;
        remoteVideo.play().catch(() => {});
        remoteAudio.play().catch(() => {});
        updateRemoteVideoState();
    };
    _peerConnection.onconnectionstatechange = () => {
        if (!_peerConnection || _finishingCall) return;
        if (_peerConnection.connectionState === 'connected') {
            setCallStatus('Verbunden');
            startCallTimer();
        } else if (_peerConnection.connectionState === 'failed') {
            hangUpCall('Verbindung fehlgeschlagen');
        } else if (_peerConnection.connectionState === 'disconnected') {
            setCallStatus('Verbindung wird wiederhergestellt…');
        }
    };
    return _peerConnection;
}

async function flushLocalIce() {
    if (!_currentCall?.id || !_pendingLocalIce.length) return;
    const candidates = _pendingLocalIce.splice(0);
    for (const candidate of candidates) await postCallSignal('ice', candidate).catch(() => {});
}

async function flushRemoteIce() {
    if (!_peerConnection?.remoteDescription || !_queuedIceCandidates.length) return;
    const candidates = _queuedIceCandidates.splice(0);
    for (const candidate of candidates) {
        try { await _peerConnection.addIceCandidate(candidate); } catch {}
    }
}

async function postCallSignal(kind, payload) {
    if (!_currentCall?.id) return;
    return api('/chat/calls/' + _currentCall.id + '/signals', 'POST', { kind, payload });
}

async function startCall(mediaType = 'audio') {
    if (_currentCall || _incomingCall) return;
    const peerName = activeCallPeer();
    if (!_activeGroupId || !peerName || _activeMembers.length !== 2) {
        toast('Anrufe gehen nur in Chats mit genau 2 Mitgliedern.', 'err');
        return;
    }
    _currentCall = { id: null, role: 'caller', peerName, mediaType, remoteVideoEnabled: mediaType === 'video' };
    updateCallButtons();
    openCallUi(peerName, mediaType === 'video' ? 'Kamera und Mikrofon werden gestartet…' : 'Mikrofon wird gestartet…', mediaType === 'video');
    try {
        _localCallStream = await getCallMedia(mediaType === 'video');
        document.getElementById('localVideo').srcObject = _localCallStream;
        const peer = createPeerConnection();
        _localCallStream.getTracks().forEach((track) => peer.addTrack(track, _localCallStream));
        updateCallControlState();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const created = await api('/chat/calls', 'POST', {
            groupId: _activeGroupId,
            callee: peerName,
            mediaType,
            offer: peer.localDescription.toJSON ? peer.localDescription.toJSON() : peer.localDescription
        });
        _currentCall = { ...created.call, role: 'caller', peerName, mediaType, remoteVideoEnabled: mediaType === 'video' };
        _lastCallSignalId = 0;
        _finishingCall = false;
        setCallStatus('Es klingelt bei ' + peerName + ' …');
        await flushLocalIce();
        updateCallButtons();
    } catch (error) {
        const message = error?.name === 'NotAllowedError'
            ? 'Mikrofon oder Kamera wurde nicht erlaubt.'
            : (error?.message || 'Anruf konnte nicht gestartet werden.');
        toast(message, 'err');
        await endCallLocally(message);
    }
}

function showIncomingCall(call) {
    _incomingCall = call;
    const caller = call.caller || 'Unbekannt';
    document.getElementById('incomingCallName').textContent = caller;
    document.getElementById('incomingCallAvatar').textContent = callInitials(caller);
    document.getElementById('incomingCallKind').textContent = call.media_type === 'video' ? 'Eingehender Videoanruf' : 'Eingehender Audioanruf';
    document.getElementById('incomingCallOverlay').style.display = 'flex';
    if (_notifiedIncomingCallId !== call.id) {
        _notifiedIncomingCallId = call.id;
        notifyChat('Eingehender ' + (call.media_type === 'video' ? 'Videoanruf' : 'Anruf'), caller + ' ruft dich an', 'chat-call-' + call.id);
    }
    startRingtone();
    updateCallButtons();
}

function startRingtone() {
    if (_ringTimer) return;
    const pulse = () => {
        try { navigator.vibrate?.([260, 220, 260]); } catch {}
        try {
            _ringAudioContext = _ringAudioContext || new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = _ringAudioContext.createOscillator();
            const gain = _ringAudioContext.createGain();
            oscillator.frequency.value = 740;
            gain.gain.setValueAtTime(.0001, _ringAudioContext.currentTime);
            gain.gain.exponentialRampToValueAtTime(.07, _ringAudioContext.currentTime + .02);
            gain.gain.exponentialRampToValueAtTime(.0001, _ringAudioContext.currentTime + .22);
            oscillator.connect(gain).connect(_ringAudioContext.destination);
            oscillator.start();
            oscillator.stop(_ringAudioContext.currentTime + .24);
        } catch {}
    };
    pulse();
    _ringTimer = setInterval(pulse, 1600);
}

function stopRingtone() {
    clearInterval(_ringTimer);
    _ringTimer = null;
    try { navigator.vibrate?.(0); } catch {}
}

async function rejectIncomingCall() {
    const call = _incomingCall;
    if (!call) return;
    stopRingtone();
    document.getElementById('incomingCallOverlay').style.display = 'none';
    _incomingCall = null;
    updateCallButtons();
    try { await api('/chat/calls/' + call.id + '/reject', 'POST'); } catch {}
}

async function acceptIncomingCall() {
    const call = _incomingCall;
    if (!call || _currentCall) return;
    stopRingtone();
    document.getElementById('incomingCallOverlay').style.display = 'none';
    _incomingCall = null;
    const withVideo = call.media_type === 'video';
    openCallUi(call.caller, withVideo ? 'Kamera und Mikrofon werden gestartet…' : 'Mikrofon wird gestartet…', withVideo);
    try {
        _localCallStream = await getCallMedia(withVideo);
        document.getElementById('localVideo').srcObject = _localCallStream;
        _currentCall = { ...call, role: 'callee', peerName: call.caller, mediaType: call.media_type, remoteVideoEnabled: withVideo };
        _lastCallSignalId = 0;
        _finishingCall = false;
        const peer = createPeerConnection();
        _localCallStream.getTracks().forEach((track) => peer.addTrack(track, _localCallStream));
        updateCallControlState();
        await peer.setRemoteDescription(parseRtcValue(call.offer));
        await flushRemoteIce();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await api('/chat/calls/' + call.id + '/answer', 'POST', {
            answer: peer.localDescription.toJSON ? peer.localDescription.toJSON() : peer.localDescription
        });
        await flushLocalIce();
        setCallStatus('Verbindung wird aufgebaut…');
        updateCallButtons();
    } catch (error) {
        try { await api('/chat/calls/' + call.id + '/reject', 'POST'); } catch {}
        const message = error?.name === 'NotAllowedError'
            ? 'Mikrofon oder Kamera wurde nicht erlaubt.'
            : (error?.message || 'Anruf konnte nicht angenommen werden.');
        toast(message, 'err');
        await endCallLocally(message);
    }
}

async function pollCalls() {
    if (!_chatStarted || _callPollBusy) return;
    _callPollBusy = true;
    try {
        if (_currentCall?.id) {
            await pollCurrentCall();
            return;
        }
        if (_currentCall) return;
        const { call } = await api('/chat/calls/pending');
        if (call) {
            if (!_incomingCall || _incomingCall.id !== call.id) showIncomingCall(call);
        } else if (_incomingCall) {
            stopRingtone();
            document.getElementById('incomingCallOverlay').style.display = 'none';
            _incomingCall = null;
            updateCallButtons();
        }
    } catch {
        // Call polling is non-fatal; chat continues to work.
    } finally {
        _callPollBusy = false;
    }
}

async function pollCurrentCall() {
    if (!_currentCall?.id || _finishingCall) return;
    const data = await api('/chat/calls/' + _currentCall.id + '?after=' + _lastCallSignalId);
    const call = data.call;
    if (!call) return;
    if (['rejected', 'missed', 'ended'].includes(call.status)) {
        const labels = { rejected: 'Anruf wurde abgelehnt.', missed: 'Keine Antwort.', ended: 'Anruf beendet.' };
        await endCallLocally(labels[call.status]);
        return;
    }
    if (_currentCall.role === 'caller' && call.status === 'accepted' && !_peerConnection?.remoteDescription) {
        const answer = parseRtcValue(call.answer);
        if (answer) {
            await _peerConnection.setRemoteDescription(answer);
            await flushRemoteIce();
            setCallStatus('Verbindung wird aufgebaut…');
        }
    }
    for (const signal of data.signals || []) {
        _lastCallSignalId = Math.max(_lastCallSignalId, Number(signal.id) || 0);
        if (signal.sender === _me?.username) continue;
        await handleCallSignal(signal);
    }
}

async function handleCallSignal(signal) {
    if (!_peerConnection || _finishingCall) return;
    const payload = parseRtcValue(signal.payload);
    if (signal.kind === 'ice') {
        if (!_peerConnection.remoteDescription) _queuedIceCandidates.push(payload);
        else {
            try { await _peerConnection.addIceCandidate(payload); } catch {}
        }
        return;
    }
    if (signal.kind === 'offer' && payload) {
        await _peerConnection.setRemoteDescription(payload);
        await flushRemoteIce();
        const answer = await _peerConnection.createAnswer();
        await _peerConnection.setLocalDescription(answer);
        await postCallSignal('answer', _peerConnection.localDescription.toJSON ? _peerConnection.localDescription.toJSON() : _peerConnection.localDescription);
        return;
    }
    if (signal.kind === 'answer' && payload && _peerConnection.signalingState === 'have-local-offer') {
        await _peerConnection.setRemoteDescription(payload);
        await flushRemoteIce();
        return;
    }
    if (signal.kind === 'media') {
        if (_currentCall) _currentCall.remoteVideoEnabled = Boolean(payload?.video);
        updateRemoteVideoState();
    }
}

function toggleCallMute() {
    const track = _localCallStream?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    updateCallControlState();
}

async function toggleCallVideo() {
    if (!_currentCall || !_peerConnection) return;
    let track = _localCallStream?.getVideoTracks?.()[0];
    try {
        if (!track) {
            const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            track = cameraStream.getVideoTracks()[0];
            _localCallStream.addTrack(track);
            _peerConnection.addTrack(track, _localCallStream);
            document.getElementById('localVideo').srcObject = _localCallStream;
            const offer = await _peerConnection.createOffer();
            await _peerConnection.setLocalDescription(offer);
            await postCallSignal('offer', _peerConnection.localDescription.toJSON ? _peerConnection.localDescription.toJSON() : _peerConnection.localDescription);
        } else {
            track.enabled = !track.enabled;
        }
        await postCallSignal('media', { video: Boolean(track.enabled) });
        updateCallControlState();
    } catch (error) {
        toast(error?.name === 'NotAllowedError' ? 'Kamera wurde nicht erlaubt.' : 'Kamera konnte nicht gestartet werden.', 'err');
    }
}

async function hangUpCall(message = 'Anruf beendet.') {
    const callId = _currentCall?.id;
    if (callId && !_finishingCall) {
        try { await api('/chat/calls/' + callId + '/end', 'POST'); } catch {}
    }
    await endCallLocally(message);
}

async function endCallLocally(message = 'Anruf beendet.') {
    if (_finishingCall) return;
    _finishingCall = true;
    stopRingtone();
    clearInterval(_callTimerTick);
    _callTimerTick = null;
    _callStartedAt = null;
    if (_localCallStream) _localCallStream.getTracks().forEach((track) => track.stop());
    if (_remoteCallStream) _remoteCallStream.getTracks().forEach((track) => track.stop());
    try { _peerConnection?.close(); } catch {}
    _peerConnection = null;
    _localCallStream = null;
    _remoteCallStream = null;
    _queuedIceCandidates = [];
    _pendingLocalIce = [];
    _lastCallSignalId = 0;
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
    document.getElementById('remoteAudio').srcObject = null;
    document.getElementById('callOverlay').classList.remove('video-active');
    setCallStatus(message);
    await new Promise((resolve) => setTimeout(resolve, 900));
    document.getElementById('callOverlay').style.display = 'none';
    _currentCall = null;
    _finishingCall = false;
    updateCallControlState();
    updateCallButtons();
}

// ─── FaceWarp Picker ──────────────────────────────────────────────────────────
function openFacewarpPicker() {
    document.getElementById('attachMenu').style.display = 'none';
    _attachOpen = false;
    document.getElementById('attachBtn').classList.remove('active');
    const saved = getSavedFacewarps();
    const grid = document.getElementById('fwGrid');
    if (!saved.length) {
        grid.innerHTML = '<div class="fw-empty">Noch keine gespeicherten Bilder.<br>Erstelle eines im Face Warp Editor.</div>';
    } else {
        grid.innerHTML = saved.map((u,i) => `<img class="fw-grid-img" src="${esc(u)}" onclick="sendFwImage('${esc(u)}')">`).join('');
    }
    openModal('fwModal');
}

async function sendFwImage(url) {
    closeModal('fwModal');
    await sendMediaMessage({ t:'fw', url });
}

function openFacewarpEditor() {
    closeModal('fwModal');
    localStorage.setItem('faceWarpReturnToChat', '1');
    const tier = _meProfile?.isPro ? 'pro' : 'basic';
    window.open('/facewarp/?tier=' + tier, '_blank');
}

function getSavedFacewarps() {
    try { return JSON.parse(localStorage.getItem('chatSavedFacewarps') || '[]'); } catch { return []; }
}

async function fetchProBadges(usernames) {
    const unique = [...new Set((usernames || []).filter(Boolean))].filter((u) => !_proBadgeCache[u]);
    if (!unique.length) return;
    try {
        const data = await api('/users/pro-badges?usernames=' + encodeURIComponent(unique.join(',')));
        const users = data?.users || {};
        Object.keys(users).forEach((username) => {
            _proBadgeCache[username] = users[username];
        });
    } catch {
        // non-fatal
    }
}

async function sendProSticker() {
    toggleAttachMenu();
    if (!_meProfile?.isPro) {
        toast('Nur mit PRO verfügbar.', 'err');
        return;
    }
    await sendMediaMessage({ t: 'pro_sticker', label: 'ehoser PRO Sticker' });
}

// ─── Groups: New ─────────────────────────────────────────────────────────────
function openNewGroupModal() {
    _ngMembers = {};
    document.getElementById('ngName').value = '';
    document.getElementById('ngSearch').value = '';
    document.getElementById('ngResults').style.display = 'none';
    document.getElementById('ngChips').innerHTML = '';
    openModal('newGroupModal');
}

async function toggleNgMember(username) {
    if (_ngMembers[username]) { delete _ngMembers[username]; }
    else _ngMembers[username] = true;
    renderNgChips();
    searchUsers(document.getElementById('ngSearch').value, 'ngResults');
}

function renderNgChips() {
    document.getElementById('ngChips').innerHTML = Object.keys(_ngMembers).map(u =>
        `<div class="chip">${esc(u)}<button class="chip-x" onclick="removeNgMember('${esc(u)}')">✕</button></div>`
    ).join('');
}

function removeNgMember(u) { delete _ngMembers[u]; renderNgChips(); }

async function createGroup() {
    const name = document.getElementById('ngName').value.trim();
    if (!name) { toast('Bitte einen Namen eingeben', 'err'); return; }
    try {
        const members = Object.keys(_ngMembers);
        const { id, name: gname } = await api('/chat/groups', 'POST', { name, members });
        closeModal('newGroupModal');
        toast('Gruppe "' + gname + '" erstellt', 'ok');
        await loadGroups();
        selectGroup(id);
    } catch (e) { toast('Fehler: ' + e.message, 'err'); }
}

// ─── Groups: Add Member ───────────────────────────────────────────────────────
function openAddMemberModal() {
    document.getElementById('amSearch').value = '';
    document.getElementById('amResults').style.display = 'none';
    document.getElementById('amStatus').textContent = '';
    document.getElementById('amStatus').className = 'status-msg';
    openModal('addMemberModal');
}

async function addMember(username) {
    const st = document.getElementById('amStatus');
    document.getElementById('amResults').style.display = 'none';
    st.textContent = username + ' wird hinzugefügt…';
    try {
        await api('/chat/groups/' + _activeGroupId + '/members', 'POST', { username });
        st.textContent = '✓ ' + username + ' hinzugefügt';
        const { members } = await api('/chat/groups/' + _activeGroupId + '/members');
        _activeMembers = members || [];
        document.getElementById('topbarMeta').textContent = members.length + ' Mitglieder';
        updateCallButtons();
        toast(username + ' zur Gruppe hinzugefügt', 'ok');
    } catch (e) { st.textContent = 'Fehler: ' + e.message; st.className = 'status-msg error'; }
}

// ─── Members List ─────────────────────────────────────────────────────────────
async function openMembersModal() {
    document.getElementById('membersList').innerHTML = '<li style="color:var(--muted);padding:10px">Lade…</li>';
    openModal('membersModal');
    try {
        const { members } = await api('/chat/groups/' + _activeGroupId + '/members');
        const g = _groups.find(x => x.id === _activeGroupId);
        document.getElementById('membersList').innerHTML = members.map(m =>
            `<li><div class="member-av">${esc(m.username.substring(0,2).toUpperCase())}</div><span>${esc(m.username)}</span>${g?.created_by === m.username ? '<span class="creator-badge">Ersteller</span>' : ''}</li>`
        ).join('') || '<li style="color:var(--muted)">Keine Mitglieder</li>';
    } catch { document.getElementById('membersList').innerHTML = '<li style="color:#c05050">Fehler</li>'; }
}

// ─── User Search ──────────────────────────────────────────────────────────────
let _searchT = null;
function searchUsers(q, resultsId) {
    const c = document.getElementById(resultsId);
    clearTimeout(_searchT);
    if (!q || q.length < 2) { c.innerHTML = ''; c.style.display = 'none'; return; }
    _searchT = setTimeout(async () => {
        try {
            const { users } = await api('/chat/users/search?q=' + encodeURIComponent(q));
            if (!users.length) { c.innerHTML = '<div class="sd-item" style="color:var(--muted)">Keine Treffer</div>'; c.style.display = 'block'; return; }
            c.style.display = 'block';
            if (resultsId === 'ngResults') {
                c.innerHTML = users.map(u => `<div class="sd-item" onclick="toggleNgMember('${esc(u)}')">${esc(u)}<span class="sd-add">${_ngMembers[u] ? '✓' : '+'}</span></div>`).join('');
            } else if (resultsId === 'amResults') {
                c.innerHTML = users.map(u => `<div class="sd-item" onclick="addMember('${esc(u)}')">${esc(u)}<span class="sd-add">+ Hinzufügen</span></div>`).join('');
            }
        } catch { c.style.display = 'none'; }
    }, 280);
}

// ─── Modal Helpers ────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function closeIfOverlay(e, id) { if (e.target === e.currentTarget) closeModal(id); }

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastT = null;
function toast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '') + ' show';
    clearTimeout(_toastT);
    _toastT = setTimeout(() => t.classList.remove('show'), 3500);
}

// ─── Image Viewer ─────────────────────────────────────────────────────────────
function viewImg(src) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    ov.onclick = () => ov.remove();
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.8)';
    ov.appendChild(img);
    document.body.appendChild(ov);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(secs) { const m=Math.floor(secs/60),s=Math.round(secs%60); return m+':'+String(s).padStart(2,'0'); }
function fmtSize(bytes) { if (bytes<1024) return bytes+'B'; if (bytes<1024*1024) return Math.round(bytes/1024)+'KB'; return (bytes/(1024*1024)).toFixed(1)+'MB'; }
