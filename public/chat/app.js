'use strict';

const API = window.location.origin + '/api';

// ─── State ────────────────────────────────────────────────────────────────────
let _token = null;
let _me = null;
let _myKeys = null;          // { privateKey, publicKey }
let _groups = [];            // [{ id, name, created_by }]
let _activeGroupId = null;
let _groupKeyCache = {};     // groupId → CryptoKey (AES-GCM)
let _lastMsgId = {};         // groupId → number
let _pollInterval = null;
let _selectedNewMembers = {};  // username → publicKeyJwk string (für neue Gruppe)

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async function init() {
    _token = localStorage.getItem('token');
    if (!_token) {
        document.getElementById('loginWall').style.display = 'flex';
        return;
    }

    // Token validieren
    try {
        const r = await apiFetch('/verify-token', { method: 'POST' });
        _me = r.user;
    } catch {
        document.getElementById('loginWall').style.display = 'flex';
        return;
    }

    document.getElementById('chatApp').style.display = 'flex';

    // Eigenes ECDH-Keypair laden oder erstellen
    _myKeys = await getOrCreateUserKeys();
    const pubJwk = await exportPublicKey(_myKeys.publicKey);
    // Public Key auf Server hochladen/aktualisieren (fire-and-forget)
    apiFetch('/chat/key', { method: 'POST', body: { publicKey: pubJwk } }).catch(() => {});

    await loadGroups();
    startPolling();
})();

// ─── API-Helper ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
    const res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_token}`
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ─── Kryptographie (ECDH P-256 + AES-GCM) ────────────────────────────────────

async function getOrCreateUserKeys() {
    const stored = localStorage.getItem('chat_privkey_jwk');
    if (stored) {
        try {
            const jwk = JSON.parse(stored);
            const privateKey = await crypto.subtle.importKey(
                'jwk', jwk,
                { name: 'ECDH', namedCurve: 'P-256' },
                true, ['deriveKey', 'deriveBits']
            );
            // Public Key aus Private Key-JWK ableiten
            const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, key_ops: [] };
            const publicKey = await crypto.subtle.importKey(
                'jwk', pubJwk,
                { name: 'ECDH', namedCurve: 'P-256' },
                true, []
            );
            return { privateKey, publicKey };
        } catch { /* Schlüssel beschädigt → neu generieren */ }
    }

    const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    localStorage.setItem('chat_privkey_jwk', JSON.stringify(jwk));
    return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

async function exportPublicKey(publicKey) {
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    // Nur den öffentlichen Teil (kein 'd')
    const { kty, crv, x, y } = jwk;
    return JSON.stringify({ kty, crv, x, y, key_ops: [] });
}

async function importPublicKey(jwkStr) {
    const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr;
    return crypto.subtle.importKey(
        'jwk', { ...jwk, key_ops: [] },
        { name: 'ECDH', namedCurve: 'P-256' },
        true, []
    );
}

function b64enc(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64dec(str) {
    const bin = atob(str);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

// Leitet AES-Wrap-Schlüssel via ECDH + HKDF ab
async function deriveWrapKey(myPriv, theirPub) {
    const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: theirPub }, myPriv, 256
    );
    const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF', hash: 'SHA-256',
            salt: new TextEncoder().encode('ehoser-chat-key-wrap-v1'),
            info: new Uint8Array(0)
        },
        hkdf,
        { name: 'AES-GCM', length: 256 },
        false, ['encrypt', 'decrypt']
    );
}

// Gruppenkey (raw AES-256 als base64) für einen Empfänger verpacken
async function wrapGroupKeyForMember(groupKeyB64, recipientPubJwk) {
    // Ephemeral ECDH-Keypair
    const eph = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
    const theirPub = await importPublicKey(recipientPubJwk);
    const wrapKey = await deriveWrapKey(eph.privateKey, theirPub);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(groupKeyB64);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, plain);

    const ephPubJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
    const { kty, crv, x, y } = ephPubJwk;

    return JSON.stringify({
        eph: JSON.stringify({ kty, crv, x, y, key_ops: [] }),
        iv: b64enc(iv),
        c: b64enc(cipher)
    });
}

// Verpackten Gruppenkey mit eigenem Private Key entschlüsseln
async function unwrapGroupKey(wrappedJson) {
    const { eph, iv, c } = JSON.parse(wrappedJson);
    const ephPub = await importPublicKey(JSON.parse(eph));
    const wrapKey = await deriveWrapKey(_myKeys.privateKey, ephPub);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(b64dec(iv)) },
        wrapKey, b64dec(c)
    );
    return new TextDecoder().decode(plain); // → groupKeyB64
}

async function generateGroupKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function exportGroupKeyB64(groupKey) {
    return b64enc(await crypto.subtle.exportKey('raw', groupKey));
}

async function importGroupKeyB64(b64) {
    return crypto.subtle.importKey('raw', b64dec(b64), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptMessage(text, groupKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, groupKey, new TextEncoder().encode(text)
    );
    return JSON.stringify({ iv: b64enc(iv), c: b64enc(cipher) });
}

async function decryptMessage(encJson, groupKey) {
    const { iv, c } = JSON.parse(encJson);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(b64dec(iv)) },
        groupKey, b64dec(c)
    );
    return new TextDecoder().decode(plain);
}

// Gruppenkey für aktive Gruppe holen (cached)
async function getGroupKey(groupId) {
    if (_groupKeyCache[groupId]) return _groupKeyCache[groupId];
    const { encryptedGroupKey } = await apiFetch(`/chat/groups/${groupId}/key`);
    const keyB64 = await unwrapGroupKey(encryptedGroupKey);
    const key = await importGroupKeyB64(keyB64);
    _groupKeyCache[groupId] = key;
    return key;
}

// ─── Gruppen ──────────────────────────────────────────────────────────────────

async function loadGroups() {
    try {
        const { groups } = await apiFetch('/chat/groups');
        _groups = groups || [];
        renderGroupList();
    } catch (e) {
        showToast('Fehler beim Laden der Gruppen: ' + e.message, 'error');
    }
}

function renderGroupList() {
    const el = document.getElementById('groupList');
    if (!_groups.length) {
        el.innerHTML = '<p class="sidebar-empty">Keine Gruppen vorhanden.<br>Erstelle eine neue!</p>';
        return;
    }
    el.innerHTML = _groups.map(g => `
        <div class="group-item ${_activeGroupId === g.id ? 'active' : ''}" onclick="selectGroup('${g.id}')">
            <div class="group-item-icon">👥</div>
            <div class="group-item-info">
                <div class="group-item-name">${esc(g.name)}</div>
                <div class="group-item-sub">von ${esc(g.created_by)}</div>
            </div>
        </div>
    `).join('');
}

async function selectGroup(groupId) {
    _activeGroupId = groupId;
    renderGroupList();

    const group = _groups.find(g => g.id === groupId);
    if (!group) return;

    document.getElementById('noGroupSelected').style.display = 'none';
    document.getElementById('activeChat').style.display = 'flex';
    document.getElementById('activeChatName').textContent = group.name;
    document.getElementById('activeChatMembers').textContent = 'Mitglieder laden…';
    document.getElementById('messagesArea').innerHTML = '<div class="messages-loading">Nachrichten werden entschlüsselt…</div>';

    // Mitglieder zählen
    try {
        const { members } = await apiFetch(`/chat/groups/${groupId}/members`);
        document.getElementById('activeChatMembers').textContent = `${members.length} Mitglied${members.length !== 1 ? 'er' : ''}`;
    } catch {}

    // Alle Nachrichten laden
    _lastMsgId[groupId] = 0;
    await loadMessages(groupId, true);
}

async function loadMessages(groupId, initial = false) {
    try {
        const after = _lastMsgId[groupId] || 0;
        const { messages } = await apiFetch(`/chat/messages/${groupId}?after=${after}`);
        if (!messages.length) {
            if (initial) {
                document.getElementById('messagesArea').innerHTML = '<div class="messages-loading" style="color:#3a6070">Noch keine Nachrichten. Schreibe die erste!</div>';
            }
            return;
        }

        const key = await getGroupKey(groupId);
        if (initial) document.getElementById('messagesArea').innerHTML = '';

        for (const msg of messages) {
            if (groupId !== _activeGroupId) break;
            let text;
            try { text = await decryptMessage(msg.encrypted_content, key); }
            catch { text = null; }
            appendMessage(msg, text);
            _lastMsgId[groupId] = msg.id;
        }

        // Auto-scroll
        if (groupId === _activeGroupId) {
            const area = document.getElementById('messagesArea');
            area.scrollTop = area.scrollHeight;
        }
    } catch (e) {
        if (initial) {
            document.getElementById('messagesArea').innerHTML = `<div class="messages-loading" style="color:#c05050">Fehler: ${esc(e.message)}</div>`;
        }
    }
}

function appendMessage(msg, plainText) {
    const area = document.getElementById('messagesArea');
    const isOwn = msg.sender === _me?.username;
    const time = new Date(msg.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

    const row = document.createElement('div');
    row.className = `message-row${isOwn ? ' own' : ''}`;
    row.innerHTML = `
        <div class="message-avatar">${esc(msg.sender.substring(0, 2).toUpperCase())}</div>
        <div class="message-bubble-wrap">
            ${!isOwn ? `<span class="message-sender">${esc(msg.sender)}</span>` : ''}
            <div class="message-bubble">
                ${plainText !== null
                    ? esc(plainText).replace(/\n/g, '<br>')
                    : '<span class="decrypt-error">🔒 Nachricht kann nicht entschlüsselt werden</span>'
                }
            </div>
            <span class="message-time">${time}</span>
        </div>
    `;
    area.appendChild(row);
}

async function sendMessage(event) {
    event.preventDefault();
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !_activeGroupId) return;

    input.value = '';
    input.disabled = true;

    try {
        const key = await getGroupKey(_activeGroupId);
        const encryptedContent = await encryptMessage(text, key);
        const { id, created_at } = await apiFetch('/chat/messages', {
            method: 'POST',
            body: { groupId: _activeGroupId, encryptedContent }
        });
        // Eigene Nachricht direkt anzeigen
        appendMessage({ id, sender: _me.username, created_at, encrypted_content: encryptedContent }, text);
        _lastMsgId[_activeGroupId] = id;
        const area = document.getElementById('messagesArea');
        area.scrollTop = area.scrollHeight;
    } catch (e) {
        showToast('Fehler beim Senden: ' + e.message, 'error');
        input.value = text;
    } finally {
        input.disabled = false;
        input.focus();
    }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
    _pollInterval = setInterval(async () => {
        if (_activeGroupId) {
            await loadMessages(_activeGroupId, false);
        }
    }, 3000);
}

// ─── Nutzersuche ─────────────────────────────────────────────────────────────

let _searchTimeout = null;
async function searchUsers(q, resultsId) {
    const container = document.getElementById(resultsId);
    clearTimeout(_searchTimeout);
    if (!q || q.length < 2) { container.innerHTML = ''; container.style.display = 'none'; return; }

    _searchTimeout = setTimeout(async () => {
        try {
            const { users } = await apiFetch(`/chat/users/search?q=${encodeURIComponent(q)}`);
            if (!users.length) { container.innerHTML = '<div class="search-result-item" style="color:#4a7a90">Keine Nutzer gefunden</div>'; container.style.display = 'block'; return; }
            container.style.display = 'block';

            if (resultsId === 'newGroupResults') {
                // Für neue Gruppe: Nutzer zur Auswahl hinzufügen
                container.innerHTML = users.map(u => `
                    <div class="search-result-item" onclick="toggleNewGroupMember('${esc(u)}')">
                        <span class="result-name">${esc(u)}</span>
                        <span class="result-add">${_selectedNewMembers[u] ? '✓ ausgewählt' : '+ Hinzufügen'}</span>
                    </div>
                `).join('');
            } else if (resultsId === 'addMemberResults') {
                // Für bestehende Gruppe: direkt hinzufügen
                container.innerHTML = users.map(u => `
                    <div class="search-result-item" onclick="addMemberToGroup('${esc(u)}')">
                        <span class="result-name">${esc(u)}</span>
                        <span class="result-add">+ Hinzufügen</span>
                    </div>
                `).join('');
            }
        } catch { container.innerHTML = ''; container.style.display = 'none'; }
    }, 300);
}

// ─── Neue Gruppe Modal ────────────────────────────────────────────────────────

function openNewGroupModal() {
    _selectedNewMembers = {};
    document.getElementById('newGroupName').value = '';
    document.getElementById('memberSearchInput').value = '';
    document.getElementById('newGroupResults').innerHTML = '';
    document.getElementById('newGroupResults').style.display = 'none';
    document.getElementById('selectedMembers').innerHTML = '';
    document.getElementById('newGroupModal').style.display = 'flex';
}

async function toggleNewGroupMember(username) {
    if (_selectedNewMembers[username]) {
        delete _selectedNewMembers[username];
    } else {
        // Public Key holen
        try {
            const { publicKey } = await apiFetch(`/chat/key/${username}`);
            _selectedNewMembers[username] = publicKey;
        } catch {
            showToast(`${username} hat noch keinen Chat-Schlüssel. Er muss Chat einmal öffnen.`, 'error');
            return;
        }
    }
    renderSelectedMembers();
    // Suchergebnisse neu rendern
    const q = document.getElementById('memberSearchInput').value;
    searchUsers(q, 'newGroupResults');
}

function removeNewGroupMember(username) {
    delete _selectedNewMembers[username];
    renderSelectedMembers();
}

function renderSelectedMembers() {
    const el = document.getElementById('selectedMembers');
    el.innerHTML = Object.keys(_selectedNewMembers).map(u => `
        <div class="member-chip">
            <span>${esc(u)}</span>
            <button onclick="removeNewGroupMember('${esc(u)}')" title="Entfernen">✕</button>
        </div>
    `).join('');
}

async function createGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if (!name) { showToast('Bitte einen Gruppennamen eingeben', 'error'); return; }

    try {
        // Eigenen Public Key holen
        const myPubJwk = await exportPublicKey(_myKeys.publicKey);

        // Gruppenkey generieren
        const groupKey = await generateGroupKey();
        const groupKeyB64 = await exportGroupKeyB64(groupKey);

        // Gruppenkey für alle Mitglieder (+ sich selbst) verpacken
        const memberKeys = {};

        // Eigener Schlüssel
        memberKeys[_me.username] = await wrapGroupKeyForMember(groupKeyB64, myPubJwk);

        // Für alle ausgewählten Mitglieder
        for (const [username, pubJwk] of Object.entries(_selectedNewMembers)) {
            memberKeys[username] = await wrapGroupKeyForMember(groupKeyB64, pubJwk);
        }

        const { id, name: groupName } = await apiFetch('/chat/groups', {
            method: 'POST',
            body: { name, memberKeys }
        });

        // Gruppenkey cachen
        _groupKeyCache[id] = groupKey;

        closeModal('newGroupModal');
        showToast(`Gruppe "${groupName}" erstellt!`, 'ok');

        // Gruppen neu laden und öffnen
        await loadGroups();
        selectGroup(id);
    } catch (e) {
        showToast('Fehler beim Erstellen: ' + e.message, 'error');
    }
}

// ─── Mitglied hinzufügen ──────────────────────────────────────────────────────

function openAddMemberModal() {
    document.getElementById('addMemberInput').value = '';
    document.getElementById('addMemberResults').innerHTML = '';
    document.getElementById('addMemberResults').style.display = 'none';
    document.getElementById('addMemberStatus').textContent = '';
    document.getElementById('addMemberStatus').className = 'modal-status';
    document.getElementById('addMemberModal').style.display = 'flex';
}

async function addMemberToGroup(username) {
    const status = document.getElementById('addMemberStatus');
    document.getElementById('addMemberResults').style.display = 'none';
    status.textContent = `${username} wird hinzugefügt…`;
    status.className = 'modal-status';

    try {
        // Public Key des neuen Mitglieds holen
        const { publicKey: theirPubJwk } = await apiFetch(`/chat/key/${username}`);

        // Gruppenkey des aktuellen Raums entschlüsseln
        const groupKey = await getGroupKey(_activeGroupId);
        const groupKeyB64 = await exportGroupKeyB64(groupKey);

        // Für neues Mitglied verpacken
        const encryptedGroupKey = await wrapGroupKeyForMember(groupKeyB64, theirPubJwk);

        await apiFetch(`/chat/groups/${_activeGroupId}/members`, {
            method: 'POST',
            body: { username, encryptedGroupKey }
        });

        status.textContent = `✓ ${username} wurde hinzugefügt!`;
        status.className = 'modal-status';

        // Mitgliederzahl aktualisieren
        const { members } = await apiFetch(`/chat/groups/${_activeGroupId}/members`);
        document.getElementById('activeChatMembers').textContent = `${members.length} Mitglied${members.length !== 1 ? 'er' : ''}`;

        showToast(`${username} zur Gruppe hinzugefügt`, 'ok');
    } catch (e) {
        status.textContent = 'Fehler: ' + e.message;
        status.className = 'modal-status error';
    }
}

// ─── Mitgliederliste Modal ────────────────────────────────────────────────────

async function openMembersModal() {
    document.getElementById('membersList').innerHTML = '<li style="color:#4a7a90;padding:10px">Lade…</li>';
    document.getElementById('membersModal').style.display = 'flex';

    try {
        const { members } = await apiFetch(`/chat/groups/${_activeGroupId}/members`);
        const group = _groups.find(g => g.id === _activeGroupId);

        document.getElementById('membersList').innerHTML = members.map(m => `
            <li>
                <div class="member-avatar-sm">${esc(m.username.substring(0, 2).toUpperCase())}</div>
                <span>${esc(m.username)}</span>
                ${group?.created_by === m.username ? '<span class="member-creator-badge">Ersteller</span>' : ''}
            </li>
        `).join('') || '<li style="color:#4a7a90;padding:10px">Keine Mitglieder</li>';
    } catch {
        document.getElementById('membersList').innerHTML = '<li style="color:#c05050;padding:10px">Fehler beim Laden</li>';
    }
}

// ─── Modal-Hilfsfunktionen ────────────────────────────────────────────────────

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function closeModalIfOverlay(e, id) { if (e.target === e.currentTarget) closeModal(id); }

// ─── Toast ────────────────────────────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg, type = '') {
    const t = document.getElementById('chatToast');
    t.textContent = msg;
    t.className = `chat-toast${type === 'error' ? ' toast-error' : type === 'ok' ? ' toast-ok' : ''} show`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
