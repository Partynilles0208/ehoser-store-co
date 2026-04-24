'use strict';
const API = window.location.origin + '/api';

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
            wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">🔑</div><h2>Erneut anmelden</h2><p style="color:#a88">Deine Sitzung ist abgelaufen. Melde dich einmal im Store neu an – danach bleibst du dauerhaft angemeldet.</p><a href="/" class="btn-primary" style="margin-top:8px;display:block;text-align:center">Im Store anmelden</a></div>`;
            show('loginWall');
            return;
        }
        if (!resp.ok) {
            // Server-Fehler: Token behalten, Retry anbieten
            const wall = document.getElementById('loginWall');
            wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">⚠️</div><h2>Verbindungsfehler</h2><p>Der Server antwortet nicht. Bitte versuche es erneut.</p><button class="btn-primary" onclick="location.reload()">Neu laden</button><a href="/" class="btn-secondary" style="margin-top:8px;display:block">Zurück zum Store</a></div>`;
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
        wall.innerHTML = `<div class="login-wall-box"><div class="lw-brand"><div class="lw-logo">E</div><span class="lw-name">ehoser</span></div><div class="lw-icon">⚠️</div><h2>Keine Verbindung</h2><p>Netzwerkfehler. Bitte überprüfe deine Verbindung.</p><button class="btn-primary" onclick="location.reload()">Neu laden</button><a href="/" class="btn-secondary" style="margin-top:8px;display:block">Zurück zum Store</a></div>`;
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
    api('/chat/key', 'POST', { publicKey: await exportPub(_myKeys.publicKey) }).catch(() => {});
    await loadGroups();
    _poll = setInterval(pollMessages, 3000);
    document.addEventListener('click', globalClickClose);
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

async function selectGroup(gid) {
    _activeGroupId = gid;
    renderGroupList();
    const g = _groups.find(x => x.id === gid);
    if (!g) return;
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
            let plain = null;
            try { plain = await decryptMsg(m.encrypted_content, key); } catch {}
            appendMessage(m, plain);
            _lastMsgId[gid] = m.id;
        }
        if (gid === _activeGroupId) { const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight; }
    } catch (e) {
        if (initial) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#c05050">Fehler: ' + esc(e.message) + '</div>';
    }
}

function appendMessage(m, plainJson) {
    const area = document.getElementById('messagesArea');
    const own = m.sender === _me?.username;
    const time = new Date(m.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
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
    const isSenderPro = _proBadgeCache[m.sender]?.isPro;
    const senderBadge = isSenderPro ? '<span class="msg-pro-badge">⭐ PRO</span>' : '';
    const senderClass = isSenderPro ? 'msg-sender pro-sender' : 'msg-sender';
    const avatarClass = isSenderPro && !own ? 'msg-avatar pro-av' : 'msg-avatar';
    row.innerHTML = `
        <div class="${avatarClass}">${esc(m.sender.substring(0,2).toUpperCase())}</div>
        <div class="msg-body">
            ${!own ? '<span class="' + senderClass + '">' + esc(m.sender) + senderBadge + '</span>' : ''}
            <div class="msg-bubble">${content}</div>
            <span class="msg-time">${time}</span>
        </div>`;
    area.appendChild(row);
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

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendMessage() {
    const inp = document.getElementById('msgInput');
    const text = inp.value.trim();
    if (!text || !_activeGroupId) return;
    inp.value = ''; inp.style.height = ''; inp.disabled = true;
    try {
        const key = await getGroupKey(_activeGroupId);
        const enc = await encryptMsg(JSON.stringify({ t:'txt', v:text }), key);
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, encryptedContent: enc });
        appendMessage({ id, sender: _me.username, created_at, encrypted_content: enc }, JSON.stringify({ t:'txt', v:text }));
        _lastMsgId[_activeGroupId] = id;
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { toast('Fehler: ' + e.message, 'err'); inp.value = text; }
    finally { inp.disabled = false; inp.focus(); }
}

async function sendMediaMessage(payload) {
    if (!_activeGroupId) return;
    try {
        const key = await getGroupKey(_activeGroupId);
        const enc = await encryptMsg(JSON.stringify(payload), key);
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, encryptedContent: enc });
        appendMessage({ id, sender: _me.username, created_at, encrypted_content: enc }, JSON.stringify(payload));
        _lastMsgId[_activeGroupId] = id;
        const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
    } catch (e) { toast('Senden fehlgeschlagen: ' + e.message, 'err'); }
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
