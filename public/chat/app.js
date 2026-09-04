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

// ─── State ────────────────────────────────────────────────────────────────────
let _token = null, _me = null, _myKeys = null;
let _meProfile = null;
let _groups = [], _activeGroupId = null;
let _groupKeyCache = {}, _lastMsgId = {};
let _proBadgeCache = {};
let _poll = null;
let _ngMembers = {}; // new-group selected members { username: pubKeyJwk }
let _recorder = null, _recChunks = [], _recTimer = null, _recSecs = 0;
let _attachOpen = false;
let _summaryAiEnabled = false;
let _seenMessageIds = {};
let _pendingMessages = {};

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
    show('chatApp');
    document.getElementById('sidebarMe').textContent = '👤 ' + _me.username;
    if (_meProfile?.isPro) {
        const proStickerItem = document.getElementById('proStickerItem');
        if (proStickerItem) proStickerItem.style.display = '';
    }
    _myKeys = await getOrCreateKeys();
    _summaryAiEnabled = localStorage.getItem('ehoserAiSummary') === '1' && Boolean(_meProfile?.isPro);
    api('/chat/key', 'POST', { publicKey: await exportPub(_myKeys.publicKey) }).catch(() => {});
    await loadGroups();
    _poll = setInterval(pollMessages, 3000);
    document.addEventListener('click', globalClickClose);
    updateAiSummaryToggle();
})();

function show(id) {
    ['loginWall','chatApp'].forEach(i => document.getElementById(i).style.display = i === id ? (id === 'chatApp' ? 'flex' : 'flex') : 'none');
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

// ─── Crypto ───────────────────────────────────────────────────────────────────
async function getOrCreateKeys() {
    const stored = localStorage.getItem('chat_privkey_jwk');
    if (stored) {
        try {
            const jwk = JSON.parse(stored);
            const privateKey = await crypto.subtle.importKey('jwk', jwk, { name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey','deriveBits']);
            const { kty,crv,x,y } = jwk;
            const publicKey = await crypto.subtle.importKey('jwk', { kty,crv,x,y,key_ops:[] }, { name:'ECDH', namedCurve:'P-256' }, true, []);
            return { privateKey, publicKey };
        } catch {}
    }
    const kp = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey','deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    localStorage.setItem('chat_privkey_jwk', JSON.stringify(jwk));
    return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

async function exportPub(k) {
    const { kty,crv,x,y } = await crypto.subtle.exportKey('jwk', k);
    return JSON.stringify({ kty, crv, x, y, key_ops:[] });
}

async function importPub(jwkStr) {
    const j = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr;
    return crypto.subtle.importKey('jwk', { ...j, key_ops:[] }, { name:'ECDH', namedCurve:'P-256' }, true, []);
}

const b64e = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const b64d = s => { const b = atob(s); const u = new Uint8Array(b.length); for (let i=0; i<b.length; i++) u[i]=b.charCodeAt(i); return u.buffer; };

async function deriveWrap(myPriv, theirPub) {
    const bits = await crypto.subtle.deriveBits({ name:'ECDH', public:theirPub }, myPriv, 256);
    const h = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt: new TextEncoder().encode('ehoser-chat-key-wrap-v1'), info: new Uint8Array(0) }, h, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}

async function wrapKey(groupKeyB64, recipPubJwk) {
    const eph = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey','deriveBits']);
    const wk = await deriveWrap(eph.privateKey, await importPub(recipPubJwk));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, wk, new TextEncoder().encode(groupKeyB64));
    const { kty,crv,x,y } = await crypto.subtle.exportKey('jwk', eph.publicKey);
    return JSON.stringify({ eph: JSON.stringify({ kty,crv,x,y,key_ops:[] }), iv: b64e(iv), c: b64e(ct) });
}

async function unwrapKey(wrapped) {
    const { eph, iv, c } = JSON.parse(wrapped);
    const wk = await deriveWrap(_myKeys.privateKey, await importPub(JSON.parse(eph)));
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: new Uint8Array(b64d(iv)) }, wk, b64d(c));
    return new TextDecoder().decode(pt);
}

async function makeGroupKey() { return crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']); }
async function exportKeyB64(k) { return b64e(await crypto.subtle.exportKey('raw', k)); }
async function importKeyB64(b) { return crypto.subtle.importKey('raw', b64d(b), { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']); }

async function encryptMsg(text, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return JSON.stringify({ iv: b64e(iv), c: b64e(ct) });
}

async function decryptMsg(enc, key) {
    const { iv, c } = JSON.parse(enc);
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: new Uint8Array(b64d(iv)) }, key, b64d(c));
    return new TextDecoder().decode(pt);
}

async function getGroupKey(gid) {
    if (_groupKeyCache[gid]) return _groupKeyCache[gid];
    const { encryptedGroupKey } = await api('/chat/groups/' + gid + '/key');
    const k = await importKeyB64(await unwrapKey(encryptedGroupKey));
    _groupKeyCache[gid] = k;
    return k;
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
        const notice = '⚠️ Hinweis: Für die KI-Zusammenfassung wurde die Ende-zu-Ende-Verschlüsselung kurz aufgehoben.';
        appendMessage({ id: 'summary-toggle-' + Date.now(), sender: 'ehoser AI', created_at: new Date().toISOString(), encrypted_content: '' }, JSON.stringify({ t: 'ai_summary', summary: notice + ' Die Zusammenfassung bleibt nur auf diesem Gerät aktiv.' }));
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
    document.getElementById('messagesArea').innerHTML = '<div class="msg-loading">Nachrichten werden entschlüsselt…</div>';
    try { const { members } = await api('/chat/groups/' + gid + '/members'); document.getElementById('topbarMeta').textContent = members.length + ' Mitglied' + (members.length !== 1 ? 'er' : ''); } catch {}
    _lastMsgId[gid] = 0;
    await loadMessages(gid, true);
    document.getElementById('msgInput').focus();
    updateAiSummaryToggle();
}

async function pollMessages() {
    if (_activeGroupId) await loadMessages(_activeGroupId, false);
}

async function loadMessages(gid, initial) {
    try {
        const after = _lastMsgId[gid] || 0;
        const { messages } = await api('/chat/messages/' + gid + '?after=' + after);
        if (!messages.length) {
            if (initial) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#2a5060">Noch keine Nachrichten.</div>';
            return;
        }
        const key = await getGroupKey(gid);
        await fetchProBadges(messages.map((m) => m.sender));
        if (initial) document.getElementById('messagesArea').innerHTML = '';
        for (const m of messages) {
            if (gid !== _activeGroupId) break;
            // Try to find an existing DOM element for this message
            const existingEl = document.querySelector(`[data-msgid="${m.id}"]`);
            let plain = null;
            try { plain = await decryptMsg(m.encrypted_content, key); } catch {}
            if (existingEl) {
                // If encrypted content changed, update DOM silently
                if (existingEl.dataset.enc !== m.encrypted_content) {
                    existingEl.dataset.enc = m.encrypted_content;
                    existingEl.dataset.plain = plain ? encodeURIComponent(plain) : '';
                    const bubble = existingEl.querySelector('.msg-bubble');
                    try {
                        const pj = JSON.parse(plain || 'null');
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
        content = '<span class="decrypt-err">🔒 Konnte nicht entschlüsselt werden</span>';
    } else {
        let parsed;
        try { parsed = JSON.parse(plainJson); } catch { parsed = { t:'txt', v: plainJson }; }
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
        row.dataset.enc = m.encrypted_content || '';
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
                pe.dataset.enc = m.encrypted_content || '';
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
        const pj = JSON.parse(plain || 'null');
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
        const key = await getGroupKey(gid);
        const plainObj = { t: 'txt', v: String(newText) };
        const enc = await encryptMsg(JSON.stringify(plainObj), key);
        await api('/chat/messages/' + msgId, 'PATCH', { encryptedContent: enc });
        // Update DOM silently
        row.dataset.enc = enc;
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
        const key = await getGroupKey(_activeGroupId);
        const summaries = [];
        for (const m of messages.slice(-6)) {
            if (!m?.encrypted_content) continue;
            try {
                const plain = await decryptMsg(m.encrypted_content, key);
                if (!plain) continue;
                const parsed = (() => { try { return JSON.parse(plain); } catch { return { t: 'txt', v: plain }; } })();
                if (parsed?.t === 'txt' && typeof parsed.v === 'string' && parsed.v.trim()) summaries.push(parsed.v.trim());
            } catch {}
        }
        const summaryText = summarizeChatMessages(summaries);
        const warning = '⚠️ Hinweis: Für die KI-Zusammenfassung wurde die Ende-zu-Ende-Verschlüsselung kurz aufgehoben. ' + summaryText;
        appendMessage({ id: 'ai-summary-' + Date.now(), sender: 'ehoser AI', created_at: new Date().toISOString(), encrypted_content: '' }, JSON.stringify({ t: 'ai_summary', summary: warning }));
        const area = document.getElementById('messagesArea'); if (area) area.scrollTop = area.scrollHeight;
    } catch {}
}

async function sendMessage() {
    const inp = document.getElementById('msgInput');
    const text = inp.value.trim();
    if (!text || !_activeGroupId) return;
    inp.value = ''; inp.style.height = ''; inp.disabled = true;
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    appendMessage({ id: tempId, sender: _me.username, created_at: new Date().toISOString(), encrypted_content: '' }, JSON.stringify({ t:'txt', v:text }));
    try {
        const key = await getGroupKey(_activeGroupId);
        const enc = await encryptMsg(JSON.stringify({ t:'txt', v:text }), key);
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, encryptedContent: enc });
        // finalize optimistic message (upgrade pending element or append if missing)
        finalizePendingMessage(tempId, id, created_at, enc, JSON.stringify({ t:'txt', v:text }));
        _lastMsgId[_activeGroupId] = id;
        if (_summaryAiEnabled && _meProfile?.isPro) {
            const warning = '⚠️ Hinweis: Die Ende-zu-Ende-Verschlüsselung wurde für die KI-Zusammenfassung kurz aufgehoben.';
            toast(warning, 'warn');
            setTimeout(() => triggerChatAiSummary(), 300);
        }
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { toast('Fehler: ' + e.message, 'err'); inp.value = text; }
    finally { inp.disabled = false; inp.focus(); }
}

async function sendMediaMessage(payload) {
    if (!_activeGroupId) return;
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    appendMessage({ id: tempId, sender: _me.username, created_at: new Date().toISOString(), encrypted_content: '' }, JSON.stringify(payload));
    try {
        const key = await getGroupKey(_activeGroupId);
        const enc = await encryptMsg(JSON.stringify(payload), key);
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, encryptedContent: enc });
        finalizePendingMessage(tempId, id, created_at, enc, JSON.stringify(payload));
        _lastMsgId[_activeGroupId] = id;
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { const el = document.querySelector(`[data-tempid="${tempId}"]`); if (el) el.classList.add('send-failed'); toast('Senden fehlgeschlagen: ' + e.message, 'err'); }
}

function finalizePendingMessage(tempId, realId, created_at, encrypted_content, plainJson) {
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
        appendMessage({ id: realId, sender: _me.username, created_at, encrypted_content }, plainJson);
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
    else {
        try {
            const { publicKey } = await api('/chat/key/' + username);
            _ngMembers[username] = publicKey;
        } catch { toast(username + ' hat noch keinen Chat-Schlüssel', 'err'); return; }
    }
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
        const myPub = await exportPub(_myKeys.publicKey);
        const gk = await makeGroupKey();
        const gkB64 = await exportKeyB64(gk);
        const memberKeys = {};
        memberKeys[_me.username] = await wrapKey(gkB64, myPub);
        for (const [u, pub] of Object.entries(_ngMembers)) memberKeys[u] = await wrapKey(gkB64, pub);
        const { id, name: gname } = await api('/chat/groups', 'POST', { name, memberKeys });
        _groupKeyCache[id] = gk;
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
        const { publicKey } = await api('/chat/key/' + username);
        const gk = await getGroupKey(_activeGroupId);
        const gkB64 = await exportKeyB64(gk);
        const encKey = await wrapKey(gkB64, publicKey);
        await api('/chat/groups/' + _activeGroupId + '/members', 'POST', { username, encryptedGroupKey: encKey });
        st.textContent = '✓ ' + username + ' hinzugefügt';
        const { members } = await api('/chat/groups/' + _activeGroupId + '/members');
        document.getElementById('topbarMeta').textContent = members.length + ' Mitglieder';
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
