'use strict';
const API_ORIGIN = window.location.protocol === 'file:' ? 'https://ehoser.de' : window.location.origin;
const API = API_ORIGIN + '/api';
const CHAT_CACHE_VERSION = 'v3';
const CHAT_ACCESS_CODE_KEY = 'ehoserAccessCode';
const IS_EHOSER_ANDROID_APP = Boolean(window.EhoserAndroid && typeof window.EhoserAndroid.isNativeApp === 'function');
let _chatGoogleClientId = '';
let _chatGoogleInitialized = false;
let _chatGoogleConfigLoading = false;

function hasChatNotificationPermission() {
    if (IS_EHOSER_ANDROID_APP) {
        try { return Boolean(window.EhoserAndroid.hasNotificationPermission()); } catch { return false; }
    }
    return 'Notification' in window && Notification.permission === 'granted';
}

function requestNativeChatNotifications() {
    try { window.EhoserAndroid?.requestNotificationPermission?.(); } catch {}
}

if (IS_EHOSER_ANDROID_APP) {
    document.documentElement.classList.add('ehoser-android-app');
    document.addEventListener('DOMContentLoaded', () => document.body?.classList.add('ehoser-android-app'), { once: true });
}

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

function presenceDate(value) {
    if (!value) return null;
    if (typeof value === 'number') return new Date(value);
    let raw = String(value).trim();
    // Supabase stores last_seen as a UTC value. Older databases return a
    // timestamp without an offset, which browsers would otherwise read as
    // local time (for example 07:22 instead of 09:22 in Germany).
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)) {
        raw = raw.replace(' ', 'T') + 'Z';
    }
    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? null : date;
}

function isUserOnline(lastSeen, presenceOverride = 'automatic') {
    if (presenceOverride === 'force_online') return true;
    if (presenceOverride === 'force_offline') return false;
    const date = presenceDate(lastSeen);
    return Boolean(date && Date.now() - date.valueOf() >= -60_000 && Date.now() - date.valueOf() < 5 * 60 * 1000);
}

function lastSeenLabel(lastSeen, presenceOverride = 'automatic') {
    if (presenceOverride === 'force_online') return 'online';
    if (presenceOverride === 'force_offline') return 'offline';
    const date = presenceDate(lastSeen);
    if (!date) return 'Zuletzt online unbekannt';
    const elapsed = Math.max(0, Date.now() - date.valueOf());
    if (elapsed < 5 * 60 * 1000) return 'online';
    if (elapsed < 60 * 60 * 1000) return 'zuletzt online vor ' + Math.max(1, Math.floor(elapsed / 60_000)) + ' Min.';
    const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return 'zuletzt online um ' + time;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'zuletzt online gestern um ' + time;
    return 'zuletzt online am ' + date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + ' um ' + time;
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
let _contacts = [];
let _openingPrivateChats = new Set();
let _lastMsgId = {};
let _lastMessageSyncAt = {};
let _proBadgeCache = {};
let _poll = null;
let _ngMembers = {}; // selected members for a new group
let _recorder = null, _recChunks = [], _recTimer = null, _recSecs = 0;
let _attachOpen = false;
let _summaryAiEnabled = false;
let _seenMessageIds = {};
let _pendingMessages = {};
let _messageNotificationCursor = 0;
let _unreadByGroup = {};
let _unreadActivityAtByGroup = {};
let _lastNotificationSoundAt = 0;
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
let _callRecoveryTimer = null;
let _callRecoveryAttempts = 0;
let _callRecoveryBusy = false;
let _ringTimer = null;
let _ringAudioContext = null;
let _notifiedIncomingCallId = null;
let _finishingCall = false;
let _callPollBusy = false;
let _callFacingMode = 'user';
let _cameraSwitchBusy = false;
let _callVideoInputCount = 0;
let _callDevicePanelOpen = false;
let _preferredCallCameraId = localStorage.getItem('ehoserCallCameraId') || '';
let _preferredCallMicId = localStorage.getItem('ehoserCallMicId') || '';
let _preferredCallSpeakerId = localStorage.getItem('ehoserCallSpeakerId') || '';
let _chatServiceWorkerReady = null;
let _groupCallInvitePoll = null;
let _lastGroupCallInviteId = null;
let _chatGroupFilter = '';
let _presenceHeartbeat = null;
let _onlineListOpen = false;
let _onlineListRequestId = 0;
let _messagePollBusy = false;
let _lastReadSent = {};
let _topbarMemberText = '';
let _typingGroupId = null;
let _typingLastSentAt = 0;
let _typingStopTimer = null;
let _chatSettingsLoginCode = null;
let _settingsOnlineRequestId = 0;
const _chatProfiles = new Map();

const FALLBACK_RTC_CONFIG = {
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
let _callRtcConfig = FALLBACK_RTC_CONFIG;
let _callRtcConfigPromise = null;

function chatCacheKey(kind) {
    return `ehoserChat:${CHAT_CACHE_VERSION}:${_me?.username || localStorage.getItem('ehoserChatLastUser') || 'unknown'}:${kind}`;
}

function readChatCache(kind, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(chatCacheKey(kind)) || 'null');
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function writeChatCache(kind, value) {
    try { localStorage.setItem(chatCacheKey(kind), JSON.stringify(value)); } catch {}
}

function getCachedMessages(groupId) {
    const cache = readChatCache('messages', {});
    return Array.isArray(cache[groupId]) ? cache[groupId] : [];
}

function persistMessages(groupId, messages) {
    if (!groupId) return;
    const cache = readChatCache('messages', {});
    const byId = new Map();
    for (const message of [...(cache[groupId] || []), ...(messages || [])]) {
        if (!message) continue;
        if (isHiddenTicTacToeChallenge(readStoredMessage(message.content))) continue;
        const key = String(message.id || `${message.sender}:${message.created_at}:${message.content || ''}`);
        byId.set(key, message);
    }
    cache[groupId] = [...byId.values()]
        .sort((a, b) => {
            const ai = Number(a.id) || 0, bi = Number(b.id) || 0;
            if (ai && bi) return ai - bi;
            return new Date(a.created_at || 0) - new Date(b.created_at || 0);
        })
        .slice(-180);
    writeChatCache('messages', cache);
    if (_groups.length && document.getElementById('groupList')) renderGroupList();
}

function normaliseUnreadCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const counts = {};
    for (const [groupId, count] of Object.entries(value)) {
        const number = Math.min(999, Math.max(0, Number(count) || 0));
        if (groupId && number) counts[groupId] = number;
    }
    return counts;
}

function unreadCount(groupId) {
    return Math.max(0, Number(_unreadByGroup[groupId]) || 0);
}

function persistUnreadCounts() {
    writeChatCache('unread', _unreadByGroup);
    writeChatCache('unread-activity', _unreadActivityAtByGroup);
}

function markGroupNotificationsRead(groupId) {
    if (!groupId || !unreadCount(groupId)) return;
    delete _unreadByGroup[groupId];
    delete _unreadActivityAtByGroup[groupId];
    persistUnreadCounts();
    renderGroupList();
}

function noteUnreadMessage(message) {
    const groupId = String(message?.group_id || '');
    if (!groupId || message?.sender === _me?.username) return false;
    const chatVisible = !document.hidden && groupId === _activeGroupId && document.hasFocus();
    if (chatVisible) {
        markGroupNotificationsRead(groupId);
        return false;
    }
    _unreadByGroup[groupId] = Math.min(999, unreadCount(groupId) + 1);
    const sentAt = new Date(message?.created_at || '').valueOf();
    _unreadActivityAtByGroup[groupId] = Number.isFinite(sentAt) ? sentAt : Date.now();
    persistUnreadCounts();
    renderGroupList();
    return true;
}

function replaceCachedMessage(groupId, oldId, message) {
    const cache = readChatCache('messages', {});
    const list = Array.isArray(cache[groupId]) ? cache[groupId] : [];
    cache[groupId] = list.map((item) => String(item.id) === String(oldId) ? message : item).slice(-180);
    writeChatCache('messages', cache);
    if (_groups.length && document.getElementById('groupList')) renderGroupList();
}

function updateCachedMessage(groupId, message) {
    if (!groupId || !message?.id) return;
    const cache = readChatCache('messages', {});
    const messages = Array.isArray(cache[groupId]) ? cache[groupId] : [];
    const index = messages.findIndex((item) => String(item?.id) === String(message.id));
    if (index >= 0) messages[index] = { ...messages[index], ...message };
    else messages.push(message);
    cache[groupId] = messages.slice(-180);
    writeChatCache('messages', cache);
    if (_groups.length && document.getElementById('groupList')) renderGroupList();
}

function getMessageSyncAt(groupId) {
    if (_lastMessageSyncAt[groupId]) return _lastMessageSyncAt[groupId];
    const saved = readChatCache('messageSync', {});
    return String(saved[groupId] || new Date(0).toISOString());
}

function setMessageSyncAt(groupId, value) {
    if (!groupId || !value) return;
    _lastMessageSyncAt[groupId] = value;
    const saved = readChatCache('messageSync', {});
    saved[groupId] = value;
    writeChatCache('messageSync', saved);
}

function setChatAuthMode(mode) {
    const register = mode === 'register';
    document.getElementById('chatLoginForm').style.display = register ? 'none' : 'grid';
    document.getElementById('chatRegisterForm').style.display = register ? 'grid' : 'none';
    document.getElementById('chatLoginTab').classList.toggle('active', !register);
    document.getElementById('chatRegisterTab').classList.toggle('active', register);
    setChatAuthStatus('');
}

function setChatAuthStatus(message = '', error = false) {
    const status = document.getElementById('chatAuthStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', error);
}

function prepareChatAuthWall(message = '') {
    const accessCode = localStorage.getItem(CHAT_ACCESS_CODE_KEY) || '';
    const username = localStorage.getItem('ehoserChatLastUser') || '';
    document.getElementById('chatLoginUnlockCode').value = accessCode;
    document.getElementById('chatRegisterUnlockCode').value = accessCode;
    document.getElementById('chatLoginUsername').value = username;
    setChatAuthStatus(message, Boolean(message));
    show('loginWall');
    initChatGoogleAuth();
}

function saveChatAuth(data, username, accessCode) {
    localStorage.setItem('token', data.token);
    localStorage.setItem(CHAT_ACCESS_CODE_KEY, accessCode);
    if (username) localStorage.setItem('ehoserChatLastUser', username);
}

async function initChatGoogleAuth() {
    if (_chatGoogleInitialized || _chatGoogleConfigLoading) return;
    _chatGoogleConfigLoading = true;
    try {
        if (!_chatGoogleClientId) {
            const response = await fetch(API + '/config');
            const config = await response.json().catch(() => ({}));
            _chatGoogleClientId = config.googleClientId || '';
        }
        if (!_chatGoogleClientId) return;
        if (!window.google?.accounts?.id) {
            setTimeout(initChatGoogleAuth, 500);
            return;
        }
        window.google.accounts.id.initialize({
            client_id: _chatGoogleClientId,
            callback: submitChatGoogleLogin,
            auto_select: false,
            cancel_on_tap_outside: true
        });
        const host = document.getElementById('chatGoogleSignIn');
        if (host) {
            host.replaceChildren();
            const width = Math.max(220, Math.min(320, Math.floor(host.getBoundingClientRect().width || 320)));
            window.google.accounts.id.renderButton(host, { theme: 'filled_black', size: 'large', width, text: 'continue_with' });
        }
        _chatGoogleInitialized = true;
    } catch {
        // Username/password login remains available if Google is unavailable.
    } finally {
        _chatGoogleConfigLoading = false;
    }
}

async function submitChatGoogleLogin(response) {
    const loginVisible = document.getElementById('chatLoginForm').style.display !== 'none';
    const inputId = loginVisible ? 'chatLoginUnlockCode' : 'chatRegisterUnlockCode';
    const accessCode = document.getElementById(inputId).value.trim();
    if (!accessCode) {
        setChatAuthStatus('Bitte zuerst den Zugangscode eingeben.', true);
        return;
    }
    setChatAuthStatus('Google-Anmeldung läuft…');
    try {
        const result = await fetch(API + '/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: response?.credential, unlockCode: accessCode })
        });
        const data = await result.json().catch(() => ({}));
        if (!result.ok) throw new Error(data.error || 'Google-Anmeldung fehlgeschlagen.');
        saveChatAuth(data, data.username, accessCode);
        window.location.replace('/chat/');
    } catch (error) {
        setChatAuthStatus(error.message || 'Google-Anmeldung fehlgeschlagen.', true);
    }
}

async function submitChatLogin(event) {
    event.preventDefault();
    const accessCode = document.getElementById('chatLoginUnlockCode').value.trim();
    const username = document.getElementById('chatLoginUsername').value.trim();
    const password = document.getElementById('chatLoginPassword').value;
    const loginCode = document.getElementById('chatLoginCode').value.trim();
    if (!password && !loginCode) {
        setChatAuthStatus('Bitte Passwort oder Login-Code eingeben.', true);
        return;
    }
    const button = document.getElementById('chatLoginSubmit');
    button.disabled = true;
    button.textContent = 'Anmeldung läuft…';
    setChatAuthStatus('');
    try {
        const response = await fetch(API + '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, unlockCode: accessCode, password: password || undefined, loginCode: loginCode || undefined })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.moderation?.reason || 'Anmeldung fehlgeschlagen.');
        saveChatAuth(data, username, accessCode);
        if (data.redirectToAdmin) window.location.replace('/admin.html');
        else window.location.replace('/chat/');
    } catch (error) {
        setChatAuthStatus(error.message || 'Anmeldung fehlgeschlagen.', true);
        button.disabled = false;
        button.textContent = 'Chat öffnen';
    }
}

async function submitChatRegister(event) {
    event.preventDefault();
    const accessCode = document.getElementById('chatRegisterUnlockCode').value.trim();
    const username = document.getElementById('chatRegisterUsername').value.trim();
    const email = document.getElementById('chatRegisterEmail').value.trim();
    const password = document.getElementById('chatRegisterPassword').value;
    const confirmation = document.getElementById('chatRegisterPasswordConfirm').value;
    if (password !== confirmation) {
        setChatAuthStatus('Die Passwörter stimmen nicht überein.', true);
        return;
    }
    const button = document.getElementById('chatRegisterSubmit');
    button.disabled = true;
    button.textContent = 'Account wird erstellt…';
    setChatAuthStatus('');
    try {
        const response = await fetch(API + '/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                email: email || undefined,
                password,
                unlockCode: accessCode,
                referralCode: new URLSearchParams(window.location.search).get('ref') || undefined
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Registrierung fehlgeschlagen.');
        saveChatAuth(data, username, accessCode);
        if (data.loginCode) window.alert(`Dein Login-Code: ${data.loginCode}\nBewahre ihn sicher auf.`);
        window.location.replace('/chat/');
    } catch (error) {
        setChatAuthStatus(error.message || 'Registrierung fehlgeschlagen.', true);
        button.disabled = false;
        button.textContent = 'Account erstellen';
    }
}

function logoutChat() {
    localStorage.removeItem('token');
    localStorage.removeItem('proStatus');
    localStorage.removeItem('premiumStatus');
    window.location.replace('/chat/');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
    _token = localStorage.getItem('token');
    if (!_token) { prepareChatAuthWall(); return; }
    try {
        // Raw fetch statt api() – wir brauchen den genauen Status-Code
        const resp = await fetch(API + '/verify-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token }
        });
        if (resp.status === 401) {
            // Token abgelaufen → einmalig neu anmelden nötig (nur 1x, dann 10 Jahre gültig)
            localStorage.removeItem('token');
            localStorage.removeItem('proStatus');
            prepareChatAuthWall('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.');
            return;
        }
        if (!resp.ok) {
            prepareChatAuthWall('Der Server antwortet nicht. Bitte versuche es erneut.');
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
        prepareChatAuthWall('Keine Verbindung. Bitte überprüfe dein Internet und versuche es erneut.');
        return;
    }
    if (!IS_EHOSER_ANDROID_APP && !('Notification' in window)) {
        showNotificationWall('Dein Browser unterstützt keine Benachrichtigungen. Öffne den Chat bitte in Chrome, Edge oder Firefox.');
        return;
    }
    if (!hasChatNotificationPermission()) {
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
    applyChatPreferences();
    document.getElementById('sidebarMe').textContent = '👤 ' + _me.username;
    if (_meProfile?.isPro) {
        const proStickerItem = document.getElementById('proStickerItem');
        if (proStickerItem) proStickerItem.style.display = '';
    }
    _summaryAiEnabled = localStorage.getItem('ehoserAiSummary') === '1' && Boolean(_meProfile?.isPro);
    if (!IS_EHOSER_ANDROID_APP && 'serviceWorker' in navigator) {
        _chatServiceWorkerReady = navigator.serviceWorker.register('service-worker.js')
            .then(() => navigator.serviceWorker.ready)
            .catch(() => null);
    }
    const cachedGroups = readChatCache('groups', []);
    _unreadByGroup = normaliseUnreadCounts(readChatCache('unread', {}));
    _unreadActivityAtByGroup = normaliseUnreadCounts(readChatCache('unread-activity', {}));
    if (Array.isArray(cachedGroups) && cachedGroups.length) {
        _groups = cachedGroups;
        renderGroupList();
    }
    // Always refresh from the server before showing the chat list. Local storage is
    // only a fast preview, never the source of truth for chats on another device.
    await loadGroups();
    await pollMessageNotifications(true);
    _poll = setInterval(pollMessages, 3000);
    _callPoll = setInterval(pollCalls, 1500);
    _groupCallInvitePoll = setInterval(pollGroupCallInvites, 2500);
    sendChatHeartbeat();
    clearInterval(_presenceHeartbeat);
    _presenceHeartbeat = setInterval(sendChatHeartbeat, 60000);
    initHoldOnlineList();
    initSecretShortcut();
    pollCalls();
    pollGroupCallInvites();
    document.addEventListener('click', globalClickClose);
    updateAiSummaryToggle();
}

async function sendChatHeartbeat() {
    if (!_chatStarted || !_token) return;
    try { await api('/heartbeat', 'POST'); } catch {}
}

function initHoldOnlineList() {
    if (window._ehoserOnlineHoldReady) return;
    window._ehoserOnlineHoldReady = true;
    const isF8 = (event) => event.key === 'F8' || event.code === 'F8' || Number(event.keyCode) === 119;
    const onKeyDown = (event) => {
        if (!isF8(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!_chatStarted || event.repeat || _onlineListOpen) return;
        showOnlineHoldList();
    };
    const onKeyUp = (event) => {
        if (!isF8(event)) return;
        event.preventDefault();
        event.stopPropagation();
        hideOnlineHoldList();
    };
    // Capture catches F8 before focused inputs or browser UI handlers can stop it.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', () => {
        hideOnlineHoldList();
        stopChatTyping();
    });
    window.addEventListener('focus', () => markActiveGroupRead(_activeGroupId));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            hideOnlineHoldList();
            stopChatTyping();
        } else {
            markActiveGroupRead(_activeGroupId);
        }
    });
}

const SECRET_ESCAPE_PRESSES = 10;
let _secretEscapeCount = 0;

function secretOverlayVisible(id) {
    const element = document.getElementById(id);
    return Boolean(element && element.style.display !== 'none');
}

function initSecretShortcut() {
    if (window._ehoserSecretsShortcutReady) return;
    window._ehoserSecretsShortcutReady = true;
    window.addEventListener('keydown', (event) => {
        const chatApp = document.getElementById('chatApp');
        if (!chatApp || getComputedStyle(chatApp).display === 'none' || _currentCall || event.repeat) return;
        const isEscape = event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape' || Number(event.keyCode) === 27;
        if (!isEscape) {
            _secretEscapeCount = 0;
            return;
        }
        if (secretOverlayVisible('bugSecretModal')) {
            event.preventDefault();
            closeBugSecret();
            return;
        }
        if (secretOverlayVisible('ehoserNilsSecrets')) {
            event.preventDefault();
            closeEhoserNilsSecrets();
            return;
        }
        // Der Nachrichteneditor hat im Chat häufig automatisch den Fokus.
        // Esc zählt daher bewusst auch dort mit.
        _secretEscapeCount += 1;
        const remaining = SECRET_ESCAPE_PRESSES - _secretEscapeCount;
        if (remaining <= 0) {
            event.preventDefault();
            _secretEscapeCount = 0;
            openEhoserNilsSecrets();
            return;
        }
        if (_secretEscapeCount >= 5) {
            event.preventDefault();
            toast(`Noch ${remaining}× Esc`, 'ok');
        }
    }, true);
}

function openEhoserNilsSecrets() {
    const area = document.getElementById('ehoserNilsSecrets');
    if (!area) return;
    closeMessageContextMenu();
    area.style.display = 'flex';
}

function closeEhoserNilsSecrets() {
    const area = document.getElementById('ehoserNilsSecrets');
    if (area) area.style.display = 'none';
    closeBugSecret();
}

function openBugSecret() {
    const modal = document.getElementById('bugSecretModal');
    const video = document.getElementById('bugSecretVideo');
    if (!modal || !video) return;
    if (!video.src) video.src = video.dataset.src || '';
    modal.style.display = 'flex';
}

function closeBugSecret() {
    const modal = document.getElementById('bugSecretModal');
    const video = document.getElementById('bugSecretVideo');
    if (modal) modal.style.display = 'none';
    if (video) video.removeAttribute('src');
}

function closeBugSecretIfOverlay(event) {
    if (event.target === event.currentTarget) closeBugSecret();
}

// Der Shortcut darf nicht vom Laden der Chatliste abhängen. So funktioniert
// er auch dann, wenn eine Hintergrund-Anfrage gerade fehlschlägt oder hängt.
initSecretShortcut();

function toggleOnlineList() {
    if (_onlineListOpen) hideOnlineHoldList();
    else showOnlineHoldList();
}

async function showOnlineHoldList() {
    const overlay = document.getElementById('onlineHoldOverlay');
    const list = document.getElementById('onlineHoldList');
    const count = document.getElementById('onlineHoldCount');
    if (!overlay || !list || !count) return;
    const requestId = ++_onlineListRequestId;
    _onlineListOpen = true;
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    list.innerHTML = '<li class="online-hold-loading">Online-Liste wird geladen…</li>';
    count.textContent = 'Online-Liste wird geladen…';
    try {
        await sendChatHeartbeat();
        const data = await api('/online-users');
        if (!_onlineListOpen || requestId !== _onlineListRequestId) return;
        const users = Array.isArray(data) ? data : (data.users || []);
        count.textContent = users.length === 1 ? '1 Person ist online' : `${users.length} Personen sind online`;
        if (!users.length) {
            list.innerHTML = '<li class="online-hold-empty">Gerade ist niemand online.</li>';
            return;
        }
        list.innerHTML = users.map((user) => {
            const username = String(user?.username || 'Gast');
            const isMe = username.toLowerCase() === String(_me?.username || '').toLowerCase();
            return `<li${isMe ? ' class="is-me"' : ''}>
                ${renderPersonAvatar(username, 'online-hold-avatar', user)}
                <span class="online-hold-name">${esc(username)}${isMe ? '<small>Du</small>' : ''}</span>
                <span class="online-hold-status"><i></i>online</span>
            </li>`;
        }).join('');
    } catch {
        if (!_onlineListOpen || requestId !== _onlineListRequestId) return;
        count.textContent = 'Verbindung fehlgeschlagen';
        list.innerHTML = '<li class="online-hold-empty">Die Online-Liste konnte nicht geladen werden.</li>';
    }
}

function hideOnlineHoldList() {
    _onlineListOpen = false;
    _onlineListRequestId += 1;
    const overlay = document.getElementById('onlineHoldOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
}

function showNotificationWall(message = '') {
    show('notificationWall');
    const help = document.getElementById('notificationHelp');
    const button = document.getElementById('notificationEnableBtn');
    if (help) help.textContent = message;
    if (button) {
        const unsupported = !IS_EHOSER_ANDROID_APP && !('Notification' in window);
        button.disabled = unsupported;
        button.textContent = IS_EHOSER_ANDROID_APP
            ? 'Benachrichtigungen aktivieren'
            : window.Notification?.permission === 'denied' ? 'Erneut prüfen' : 'Benachrichtigungen erlauben';
    }
}

async function enableChatNotifications() {
    const help = document.getElementById('notificationHelp');
    if (IS_EHOSER_ANDROID_APP) {
        if (hasChatNotificationPermission()) {
            if (help) help.textContent = '';
            if (_chatStarted) show('chatApp');
            else await finishChatBoot();
        } else {
            if (help) help.textContent = 'Android fragt jetzt nach der Berechtigung.';
            requestNativeChatNotifications();
        }
        return;
    }
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
    const allowed = hasChatNotificationPermission();
    if (!allowed && _me) {
        showNotificationWall(IS_EHOSER_ANDROID_APP
            ? 'Benachrichtigungen sind in den Android-App-Einstellungen blockiert.'
            : window.Notification?.permission === 'denied'
            ? 'Benachrichtigungen sind blockiert. Erlaube sie in den Website-Einstellungen und lade die Seite neu.'
            : 'Aktiviere Benachrichtigungen, um weiter zu chatten.');
    }
    return allowed;
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _chatStarted) enforceNotificationPermission();
});

function playChatNotificationSound() {
    // Browser notifications do not support a custom sound option. Play the
    // bundled alarm in the page as well, after the user has granted permission.
    const now = Date.now();
    if (now - _lastNotificationSoundAt < 1200) return;
    _lastNotificationSoundAt = now;
    try {
        const audio = new Audio('/chat/arlam.mp3');
        audio.volume = 0.72;
        void audio.play().catch(() => {});
    } catch {}
}

function notifyChat(title, body, tag, url = '/chat/') {
    playChatNotificationSound();
    if (IS_EHOSER_ANDROID_APP) {
        try {
            window.EhoserAndroid.showNotification(title, body, tag, new URL(url, window.location.origin).toString());
            return;
        } catch {}
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, tag, icon: '/favicon.svg', badge: '/favicon.svg', data: { url } };
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

window.onEhoserAndroidNotificationPermission = async function onEhoserAndroidNotificationPermission(granted) {
    if (!IS_EHOSER_ANDROID_APP) return;
    const help = document.getElementById('notificationHelp');
    if (!granted) {
        showNotificationWall('Ohne Benachrichtigungen kann ehoser Chat nicht geöffnet werden. Erlaube sie in den Android-App-Einstellungen.');
        if (help) help.textContent = 'Berechtigung noch nicht erlaubt.';
        return;
    }
    if (help) help.textContent = '';
    if (_chatStarted) show('chatApp');
    else await finishChatBoot();
};

async function pollGroupCallInvites() {
    if (!_chatStarted) return;
    try {
        const { room } = await api('/chat/group-calls/pending');
        const banner = document.getElementById('groupCallInviteBanner');
        if (!room) {
            if (banner) banner.style.display = 'none';
            return;
        }
        if (banner) {
            const text = document.getElementById('groupCallInviteText');
            if (text) text.textContent = `${room.host || 'Jemand'} lädt dich mit ${Math.max(1, (room.participants || []).length - 1)} weiteren Personen ein.`;
            banner.style.display = 'flex';
        }
        if (_lastGroupCallInviteId !== room.id) {
            _lastGroupCallInviteId = room.id;
            notifyChat('Eingehender Gruppenanruf', `${room.host || 'Jemand'} lädt dich ein`, 'group-call-' + room.id, '/group-call/');
        }
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
    const opts = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Authorization': 'Bearer ' + _token } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(API + path, opts);
    const raw = await r.text();
    let data = {};
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch {
            // Vercel and reverse proxies sometimes return a plain-text 5xx page.
            // Never expose a JSON parser error to the person using the chat.
            if (!r.ok || r.status >= 500 || /server error/i.test(raw)) {
                throw new Error('Serverfehler (HTTP ' + r.status + '). Bitte Seite neu laden und später erneut versuchen.');
            }
            throw new Error('Der Server hat eine ungültige Antwort gesendet. Bitte Seite neu laden.');
        }
    }
    if (!r.ok) throw new Error(data?.error || 'HTTP ' + r.status);
    return data;
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
    const raw = await r.text();
    let data = {};
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        throw new Error(!r.ok || r.status >= 500
            ? 'Serverfehler beim Upload (HTTP ' + r.status + '). Bitte später erneut versuchen.'
            : 'Der Server hat beim Upload keine gültige Antwort gesendet.');
    }
    if (!r.ok) throw new Error(data.error || 'Upload fehlgeschlagen');
    return data;
}

// New chat messages are stored as ordinary JSON text. Older encrypted records
// cannot be decoded after encryption is disabled and are shown as legacy items.
function readStoredMessage(value) {
    const parsed = safeJsonParse(value, null);
    if (parsed && typeof parsed === 'object' && parsed.iv && parsed.c) return null;
    return typeof value === 'string' ? value : JSON.stringify(value || '');
}

const CHAT_TRANSLATIONS = {
    de: {
        search: 'Chats durchsuchen', chats: 'Chats', logout: 'Abmelden',
        groupCall: 'Gruppenanruf', groupCallSub: 'Mit mehreren sprechen',
        emptyChat: 'Wähle einen Chat aus<br>oder starte einen neuen.',
        emptyNote: 'Nachrichten, Bilder und Anrufe', messagePlaceholder: 'Nachricht…',
        noChats: 'Noch keine Chats.<br>Tippe oben auf ＋.', noResult: 'Kein Chat gefunden.',
        privateChat: 'Privater Chat', members: 'Mitglieder', member: 'Mitglied',
        oldMessage: 'Alte Nachricht', deletedMessage: 'Nachricht wurde gelöscht', message: 'Nachricht', you: 'Du',
        photo: '📷 Foto', video: '🎥 Video', audio: '🎤 Sprachnachricht',
        file: '📎 Datei', sticker: '✨ Sticker', summary: '🤖 Zusammenfassung',
        loadingMembers: 'Mitglieder werden geladen…', typingOne: 'schreibt gerade…',
        typingMany: 'schreiben…', typingGroup: 'Mehrere Personen schreiben gerade…'
    },
    en: {
        search: 'Search chats', chats: 'Chats', logout: 'Log out',
        groupCall: 'Group call', groupCallSub: 'Talk with several people',
        emptyChat: 'Choose a chat<br>or start a new one.',
        emptyNote: 'Messages, media and calls', messagePlaceholder: 'Message…',
        noChats: 'No chats yet.<br>Tap ＋ above.', noResult: 'No chat found.',
        privateChat: 'Private chat', members: 'members', member: 'member',
        oldMessage: 'Old message', deletedMessage: 'Message deleted', message: 'Message', you: 'You',
        photo: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice message',
        file: '📎 File', sticker: '✨ Sticker', summary: '🤖 Summary',
        loadingMembers: 'Loading members…', typingOne: 'is typing…',
        typingMany: 'are typing…', typingGroup: 'Several people are typing…'
    }
};

function chatLanguage() {
    const language = String(_meProfile?.settings?.language || 'de').toLowerCase();
    return Object.prototype.hasOwnProperty.call(CHAT_TRANSLATIONS, language) ? language : 'de';
}

function chatText(key) {
    return CHAT_TRANSLATIONS[chatLanguage()]?.[key] || CHAT_TRANSLATIONS.de[key] || key;
}

function applyChatPreferences() {
    const settings = _meProfile?.settings || {};
    const language = chatLanguage();
    document.documentElement.lang = language;
    document.body.classList.toggle('chat-compact', Boolean(settings.chatCompactMode));
    const search = document.getElementById('chatSearchInput');
    if (search) {
        search.placeholder = chatText('search');
        search.setAttribute('aria-label', chatText('search'));
    }
    const staticText = {
        chatListTitle: chatText('chats'),
        groupCallTitle: chatText('groupCall'),
        groupCallSubtitle: chatText('groupCallSub'),
        chatLogoutButton: chatText('logout'),
        emptyChatHint: chatText('emptyChat'),
        emptyChatNote: chatText('emptyNote')
    };
    Object.entries(staticText).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (!element) return;
        if (id === 'emptyChatHint') element.innerHTML = value;
        else element.textContent = value;
    });
    const input = document.getElementById('msgInput');
    if (input) input.placeholder = chatText('messagePlaceholder');
    renderGroupList();
    if (_activeMembers.length) {
        const activeGroup = _groups.find((group) => group.id === _activeGroupId);
        _topbarMemberText = activeGroup?.type === 'private'
            ? lastSeenLabel(activeGroup.last_seen, activeGroup.presence_override)
            : _activeMembers.length + ' ' + (_activeMembers.length === 1 ? chatText('member') : chatText('members'));
        updateTypingIndicator([]);
    }
}

// ─── Groups ───────────────────────────────────────────────────────────────────
async function loadGroups() {
    try {
        const [groupsResult, contactsResult] = await Promise.allSettled([
            api('/chat/groups'),
            api('/chat/contacts')
        ]);
        if (groupsResult.status !== 'fulfilled') throw groupsResult.reason;
        const groups = groupsResult.value.groups || [];
        _contacts = contactsResult.status === 'fulfilled' ? (contactsResult.value.contacts || []) : _contacts;
        rememberChatProfiles(_contacts);
        _groups = mergeGroupsWithContacts(groups, _contacts);
        writeChatCache('groups', groups);
        renderGroupList();
    } catch (e) { toast('Fehler: ' + e.message, 'err'); }
}

function contactKey(username) {
    return String(username || '').trim().toLowerCase();
}

function mergeGroupsWithContacts(groups, contacts) {
    const realGroups = Array.isArray(groups) ? groups.map((group) => ({ ...group, is_contact: false })) : [];
    const privateChats = new Map();
    for (const group of realGroups) {
        if (group.type !== 'private') continue;
        const peer = group.peer_username || group.name;
        if (peer) privateChats.set(contactKey(peer), group);
    }
    const presenceByContact = new Map((contacts || []).map((contact) => [contactKey(contact?.username), contact]));
    for (const group of realGroups) {
        if (group.type !== 'private') continue;
        const contact = presenceByContact.get(contactKey(group.peer_username || group.name));
        if (contact) {
            group.name = contact.username;
            group.peer_username = contact.username;
            group.last_seen = contact.last_seen || null;
            group.presence_override = contact.presence_override || 'automatic';
        }
    }
    const missingContacts = (contacts || [])
        .filter((contact) => contact?.username && contactKey(contact.username) !== contactKey(_me?.username))
        .filter((contact) => !privateChats.has(contactKey(contact.username)))
        .sort((a, b) => String(a.username).localeCompare(String(b.username), 'de'))
        .map((contact) => ({
            id: 'contact:' + contact.username,
            name: contact.username,
            peer_username: contact.username,
            last_seen: contact.last_seen || null,
            presence_override: contact.presence_override || 'automatic',
            type: 'private',
            member_count: 2,
            is_contact: true
        }));
    return [...realGroups, ...missingContacts];
}

function renderGroupList() {
    const el = document.getElementById('groupList');
    if (!el) return;
    if (!_groups.length) { el.innerHTML = '<p class="empty-hint">' + chatText('noChats') + '</p>'; return; }
    const visibleGroups = _groups
        .filter((group) => String(group.name || '').toLowerCase().includes(_chatGroupFilter))
        .sort((a, b) => {
            const aUnread = unreadCount(a.id) > 0;
            const bUnread = unreadCount(b.id) > 0;
            if (aUnread !== bUnread) return Number(bUnread) - Number(aUnread);
            if (aUnread) {
                const unreadTimeDifference = (Number(_unreadActivityAtByGroup[b.id]) || 0) - (Number(_unreadActivityAtByGroup[a.id]) || 0);
                if (unreadTimeDifference) return unreadTimeDifference;
            }
            const aMessages = getCachedMessages(a.id);
            const bMessages = getCachedMessages(b.id);
            const aTime = aMessages.length ? new Date(aMessages[aMessages.length - 1]?.created_at || 0).valueOf() : 0;
            const bTime = bMessages.length ? new Date(bMessages[bMessages.length - 1]?.created_at || 0).valueOf() : 0;
            if (aTime !== bTime) return bTime - aTime;
            return String(a.name || '').localeCompare(String(b.name || ''), 'de');
        });
    if (!visibleGroups.length) {
        el.innerHTML = '<p class="empty-hint">' + chatText('noResult') + '</p>';
        return;
    }
    el.innerHTML = visibleGroups.map(g => {
        const cached = getCachedMessages(g.id).filter((message) => !String(message?.id || '').startsWith('tmp-'));
        const lastMessage = cached[cached.length - 1] || null;
        const listPreview = _meProfile?.settings?.chatShowPreviews === false
            ? (g.type === 'private' ? lastSeenLabel(g.last_seen, g.presence_override) : (Number(g.member_count) || 0) + ' ' + chatText('members'))
            : getChatListPreview(lastMessage, g);
        const listTime = lastMessage
            ? parseServerDate(lastMessage.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
            : '';
        const unread = unreadCount(g.id);
        const unreadLabel = unread > 99 ? '99+' : String(unread);
        return `
        <div class="group-item${_activeGroupId === g.id ? ' active' : ''}${g.is_contact ? ' contact-item' : ''}${unread ? ' has-unread' : ''}" onclick="selectGroup('${g.id}')">
            ${renderConversationAvatar(g, 'gi-avatar')}
            <div class="gi-info">
                <div class="gi-head"><div class="gi-name">${esc(g.name)}</div><div class="gi-meta"><time>${esc(listTime)}</time>${unread ? '<span class="unread-badge" aria-label="' + unread + ' ungelesene Nachrichten">' + unreadLabel + '</span>' : ''}</div></div>
                <div class="gi-sub">${esc(listPreview)}</div>
            </div>
        </div>`;
    }).join('');
}

function getChatListPreview(message, group) {
    if (!message) {
        if (group.type === 'private') {
            const status = lastSeenLabel(group.last_seen, group.presence_override);
            return group.is_contact ? status + ' · Tippe, um zu schreiben' : status;
        }
        return (Number(group.member_count) || 0) + ' ' + chatText('members');
    }
    if (message.deleted_at) return chatText('deletedMessage');
    const stored = readStoredMessage(message.content);
    if (stored === null) return chatText('oldMessage');
    const parsed = safeJsonParse(stored, { t: 'txt', v: String(stored || '') });
    if (parsed?.t === 'deleted') return chatText('deletedMessage');
    const labels = {
        img: chatText('photo'), vid: chatText('video'), aud: chatText('audio'), fw: '🎭 Face Warp',
        file: chatText('file'), pro_sticker: chatText('sticker'), ai_summary: chatText('summary')
    };
    const text = parsed?.t === 'txt'
        ? String(parsed.v || '').replace(/\s+/g, ' ').trim()
        : (labels[parsed?.t] || chatText('message'));
    const sender = message.sender === _me?.username ? chatText('you') + ': ' : (group.type === 'private' ? '' : String(message.sender || '') + ': ');
    return sender + (text || chatText('message'));
}

function filterChatGroups(value) {
    _chatGroupFilter = String(value || '').trim().toLowerCase();
    renderGroupList();
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
    const requestedGroup = _groups.find(x => x.id === gid);
    if (requestedGroup?.is_contact) {
        await openDirectChat(requestedGroup.peer_username || requestedGroup.name);
        return;
    }
    const previousGroupId = _activeGroupId;
    if (previousGroupId && previousGroupId !== gid) stopChatTyping(previousGroupId);
    _activeGroupId = gid;
    markGroupNotificationsRead(gid);
    const chatApp = document.getElementById('chatApp');
    const opensMobileView = window.matchMedia?.('(max-width: 760px)').matches && !chatApp?.classList.contains('chat-open');
    chatApp?.classList.add('chat-open');
    if (opensMobileView) history.pushState({ ehoserChatView: true }, '', window.location.href);
    renderGroupList();
    const g = _groups.find(x => x.id === gid);
    if (!g) return;
    _seenMessageIds[gid] = new Set();
    document.getElementById('noGroup').style.display = 'none';
    const ac = document.getElementById('activeChat');
    ac.style.display = 'flex';
    document.getElementById('topbarName').textContent = g.name;
    setConversationAvatar(document.getElementById('topbarGroupIcon'), g);
    _topbarMemberText = chatText('loadingMembers');
    updateTypingIndicator([]);
    const cachedMessages = getCachedMessages(gid);
    if (cachedMessages.length) renderCachedMessages(gid, cachedMessages);
    else document.getElementById('messagesArea').innerHTML = '<div class="msg-loading">Nachrichten werden geladen…</div>';
    _activeMembers = [];
    updateCallButtons();
    try {
        const { members } = await api('/chat/groups/' + gid + '/members');
        if (gid !== _activeGroupId) return;
        _activeMembers = members || [];
        _topbarMemberText = g.type === 'private'
            ? lastSeenLabel(g.last_seen, g.presence_override)
            : _activeMembers.length + ' ' + (_activeMembers.length === 1 ? chatText('member') : chatText('members'));
        updateTypingIndicator([]);
    } catch {}
    updateCallButtons();
    if (!cachedMessages.length) _lastMsgId[gid] = 0;
    await loadMessages(gid, true);
    document.getElementById('msgInput').focus();
    updateAiSummaryToggle();
}

async function openDirectChat(username) {
    const peerUsername = String(username || '').trim();
    if (!peerUsername || contactKey(peerUsername) === contactKey(_me?.username)) return;
    const existing = _groups.find((group) => group.type === 'private' && !group.is_contact
        && contactKey(group.peer_username || group.name) === contactKey(peerUsername));
    if (existing) {
        await selectGroup(existing.id);
        return;
    }
    const key = contactKey(peerUsername);
    if (_openingPrivateChats.has(key)) return;
    _openingPrivateChats.add(key);
    try {
        const chat = await api('/chat/private', 'POST', { username: peerUsername });
        const group = {
            id: chat.id,
            name: chat.name || peerUsername,
            peer_username: chat.peer_username || peerUsername,
            last_seen: _contacts.find((contact) => contactKey(contact.username) === key)?.last_seen || null,
            type: 'private',
            member_count: 2,
            is_contact: false
        };
        _groups = _groups.filter((item) => !(item.is_contact && contactKey(item.peer_username || item.name) === key));
        if (!_groups.some((item) => item.id === group.id)) _groups.unshift(group);
        writeChatCache('groups', _groups.filter((item) => !item.is_contact));
        renderGroupList();
        await selectGroup(group.id);
        loadGroups();
    } catch (error) {
        toast('Chat mit ' + peerUsername + ' konnte nicht geöffnet werden: ' + (error?.message || 'Unbekannter Fehler'), 'err');
    } finally {
        _openingPrivateChats.delete(key);
    }
}

function closeMobileChat() {
    stopChatTyping();
    if (history.state?.ehoserChatView) {
        history.back();
        return;
    }
    document.getElementById('chatApp')?.classList.remove('chat-open');
    document.getElementById('msgInput')?.blur();
}

window.handleEhoserAndroidBack = function handleEhoserAndroidBack() {
    const openModal = [...document.querySelectorAll('.modal-overlay')].find((modal) => modal.style.display !== 'none');
    if (openModal) {
        openModal.style.display = 'none';
        return true;
    }
    const attachMenu = document.getElementById('attachMenu');
    if (attachMenu?.style.display !== 'none') {
        attachMenu.style.display = 'none';
        _attachOpen = false;
        return true;
    }
    const chatApp = document.getElementById('chatApp');
    if (chatApp?.classList.contains('chat-open')) {
        closeMobileChat();
        return true;
    }
    return false;
};

window.addEventListener('popstate', () => {
    stopChatTyping();
    document.getElementById('chatApp')?.classList.remove('chat-open');
    document.getElementById('msgInput')?.blur();
});

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
    if (_messagePollBusy) return;
    _messagePollBusy = true;
    try {
        if (_activeGroupId) await loadMessages(_activeGroupId, false);
        await pollMessageNotifications(false);
    } finally {
        _messagePollBusy = false;
    }
}

async function pollMessageNotifications(initial = false) {
    try {
        const data = await api('/chat/notifications?after=' + (initial ? 0 : _messageNotificationCursor));
        _messageNotificationCursor = Math.max(_messageNotificationCursor, Number(data.cursor) || 0);
        if (initial) return;
        for (const message of data.messages || []) {
            if (message.sender === _me?.username) continue;
            const shouldNotify = noteUnreadMessage(message);
            if (!shouldNotify) continue;
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
        const changedAfter = getMessageSyncAt(gid);
        const response = await api('/chat/messages/' + gid + '?after=' + after + '&changedAfter=' + encodeURIComponent(changedAfter));
        const messages = response.messages || [];
        const activity = response.activity || { deliveredUpTo: 0, readUpTo: 0, typing: [] };
        if (gid !== _activeGroupId) return;
        setMessageSyncAt(gid, response.syncedAt || new Date().toISOString());
        updatePinnedMessageBanner(response.pinnedMessage || null);
        if (!messages.length) {
            if (initial && !document.querySelector('#messagesArea .msg-row')) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#8696a0">Noch keine Nachrichten.</div>';
            updatePinnedMessageBanner(response.pinnedMessage || null);
            updateMessageReceipts(activity);
            updateTypingIndicator(activity.typing || []);
            markActiveGroupRead(gid);
            return;
        }
        persistMessages(gid, messages);
        await fetchProBadges(messages.map((m) => m.sender));
        if (gid !== _activeGroupId) return;
        if (initial) document.getElementById('messagesArea').innerHTML = '';
        for (const m of messages) {
            if (gid !== _activeGroupId) break;
            // Try to find an existing DOM element for this message
            const existingEl = document.querySelector(`[data-msgid="${m.id}"]`);
            const plain = readStoredMessage(m.content);
            if (existingEl) {
                updateRenderedMessageRow(existingEl, m, plain);
                markMessageSeen(gid, m.id);
                _lastMsgId[gid] = Math.max(_lastMsgId[gid] || 0, Number(m.id) || 0);
                continue;
            }
            if (isMessageSeen(gid, m.id)) continue;
            appendMessage(m, plain);
            markMessageSeen(gid, m.id);
            _lastMsgId[gid] = Math.max(_lastMsgId[gid] || 0, Number(m.id) || 0);
        }
        updateMessageReceipts(activity);
        updateTypingIndicator(activity.typing || []);
        markActiveGroupRead(gid);
        updatePinnedMessageBanner(response.pinnedMessage || null);
        if (gid === _activeGroupId) { const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight; }
    } catch (e) {
        if (initial) document.getElementById('messagesArea').innerHTML = '<div class="msg-loading" style="color:#c05050">Fehler: ' + esc(e.message) + '</div>';
    }
}

function updateMessageReceipts(activity = {}) {
    const deliveredUpTo = Math.max(0, Number(activity.deliveredUpTo) || 0);
    const readUpTo = Math.max(0, Number(activity.readUpTo) || 0);
    document.querySelectorAll('#messagesArea .msg-row.own[data-msgid]').forEach((row) => {
        const messageId = Number(row.dataset.msgid) || 0;
        const ticks = row.querySelector('.msg-ticks');
        if (!ticks || !messageId) return;
        ticks.classList.remove('read');
        if (messageId <= readUpTo) {
            ticks.textContent = '✓✓';
            ticks.classList.add('read');
            ticks.setAttribute('aria-label', 'Von allen gelesen');
            ticks.title = 'Von allen gelesen';
        } else if (messageId <= deliveredUpTo) {
            ticks.textContent = '✓✓';
            ticks.setAttribute('aria-label', 'An alle zugestellt');
            ticks.title = 'An alle zugestellt';
        } else {
            ticks.textContent = '✓';
            ticks.setAttribute('aria-label', 'Beim Server angekommen');
            ticks.title = 'Beim Server angekommen';
        }
    });
}

function updateTypingIndicator(usernames = []) {
    const meta = document.getElementById('topbarMeta');
    if (!meta) return;
    const typing = [...new Set((usernames || []).filter((name) => name && name !== _me?.username))];
    if (!typing.length) {
        meta.textContent = _topbarMemberText;
        meta.classList.remove('typing');
        return;
    }
    meta.textContent = typing.length === 1
        ? typing[0] + ' ' + chatText('typingOne')
        : typing.length === 2
            ? typing[0] + (chatLanguage() === 'de' ? ' und ' : ' and ') + typing[1] + ' ' + chatText('typingMany')
            : chatText('typingGroup');
    meta.classList.add('typing');
}

async function markActiveGroupRead(gid = _activeGroupId) {
    if (!gid || gid !== _activeGroupId || document.hidden || !document.hasFocus() || _onlineListOpen || _currentCall || _incomingCall) return;
    const chatApp = document.getElementById('chatApp');
    if (window.matchMedia?.('(max-width: 760px)').matches && !chatApp?.classList.contains('chat-open')) return;
    markGroupNotificationsRead(gid);
    const upTo = Math.max(0, Number(_lastMsgId[gid]) || 0);
    if (!upTo || (_lastReadSent[gid] || 0) >= upTo) return;
    const previous = _lastReadSent[gid] || 0;
    _lastReadSent[gid] = upTo;
    try {
        await api('/chat/groups/' + gid + '/read', 'POST', { upTo });
    } catch {
        _lastReadSent[gid] = previous;
    }
}

function renderCachedMessages(gid, messages) {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    area.innerHTML = '';
    _seenMessageIds[gid] = new Set();
    _lastMsgId[gid] = 0;
    for (const message of messages || []) {
        if (String(message.id || '').startsWith('tmp-')) continue;
        const plain = readStoredMessage(message.content);
        appendMessage(message, plain);
        markMessageSeen(gid, message.id);
        _lastMsgId[gid] = Math.max(_lastMsgId[gid], Number(message.id) || 0);
    }
    const pinnedMessage = [...(messages || [])]
        .filter((message) => message?.pinned_at && !message?.deleted_at)
        .sort((a, b) => new Date(b.pinned_at || 0) - new Date(a.pinned_at || 0))[0] || null;
    updatePinnedMessageBanner(pinnedMessage);
    area.scrollTop = area.scrollHeight;
}

function isDeletedMessage(message, plainJson) {
    if (message?.deleted_at) return true;
    return safeJsonParse(plainJson, null)?.t === 'deleted';
}

function renderMessageBody(plainJson) {
    if (plainJson === null) return '<span class="decrypt-err">' + esc(chatText('oldMessage')) + '</span>';
    const parsed = safeJsonParse(plainJson, { t: 'txt', v: String(plainJson || '') });
    return renderContent(parsed);
}

function ticTacToeChallengeFrom(plainJson) {
    const parsed = safeJsonParse(plainJson, null);
    return parsed?.t === 'tic_tac_toe' && typeof parsed === 'object' ? parsed : null;
}

function isHiddenTicTacToeChallenge(plainJson) {
    const challenge = ticTacToeChallengeFrom(plainJson);
    if (!challenge?.target) return false;
    return String(challenge.target).toLowerCase() !== String(_me?.username || '').toLowerCase();
}

function updateRenderedMessageRow(row, message, plainJson = readStoredMessage(message?.content)) {
    if (!row || !message) return;
    const deleted = isDeletedMessage(message, plainJson);
    const pinned = Boolean(message.pinned_at) && !deleted;
    row.dataset.stored = message.content || '';
    row.dataset.plain = plainJson ? encodeURIComponent(plainJson) : '';
    row.dataset.sender = String(message.sender || '');
    row.dataset.deleted = deleted ? 'true' : 'false';
    row.dataset.pinned = pinned ? 'true' : 'false';
    row.dataset.edited = 'false';
    row.classList.toggle('deleted', deleted);
    row.classList.toggle('pinned', pinned);

    const content = row.querySelector('.msg-content');
    if (content) content.innerHTML = renderMessageBody(plainJson);

    const meta = row.querySelector('.msg-meta');
    if (!meta) return;
    meta.querySelectorAll('.msg-edited').forEach((edited) => edited.remove());
}

function messagePreviewText(message) {
    if (!message || isDeletedMessage(message, readStoredMessage(message.content))) return chatText('deletedMessage');
    const plain = readStoredMessage(message.content);
    if (plain === null) return chatText('oldMessage');
    const parsed = safeJsonParse(plain, { t: 'txt', v: String(plain || '') });
    if (parsed?.t === 'txt') return String(parsed.v || '').replace(/\s+/g, ' ').trim() || chatText('message');
    const labels = { img: chatText('photo'), vid: chatText('video'), aud: chatText('audio'), file: chatText('file'), pro_sticker: chatText('sticker'), tic_tac_toe: '🎮 Tic-Tac-Toe' };
    return labels[parsed?.t] || chatText('message');
}

function updatePinnedMessageBanner(message) {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    let banner = document.getElementById('pinnedMessageBanner');
    if (!message || isDeletedMessage(message, readStoredMessage(message.content))) {
        banner?.remove();
        return;
    }
    if (!banner) {
        banner = document.createElement('button');
        banner.id = 'pinnedMessageBanner';
        banner.type = 'button';
        banner.className = 'pinned-message-banner';
        area.prepend(banner);
    }
    const preview = messagePreviewText(message).slice(0, 110);
    banner.innerHTML = '<span class="pinned-message-icon">📌</span><span><strong>Angepinnt</strong><small>'
        + esc(String(message.sender || '')) + ': ' + esc(preview) + '</small></span>';
    banner.onclick = () => {
        const row = document.querySelector('#messagesArea .msg-row[data-msgid="' + String(message.id) + '"]');
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('message-focus');
        window.setTimeout(() => row.classList.remove('message-focus'), 1200);
    };
}

function appendMessage(m, plainJson) {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    if (isHiddenTicTacToeChallenge(plainJson)) return;
    if (m?.id && _activeGroupId && isMessageSeen(_activeGroupId, m.id)) return;
    const own = m.sender === _me?.username;
    const ts = parseServerDate(m.created_at || Date.now());
    const timeStr = ts.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const content = renderMessageBody(plainJson);
    const row = document.createElement('div');
    row.className = 'msg-row' + (own ? ' own' : '');
    row.dataset.dateKey = `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}`;
    const senderName = m.sender || 'ehoser AI';
    const isSenderPro = senderName !== 'ehoser AI' && _proBadgeCache[senderName]?.isPro;
    const senderBadge = isSenderPro ? '<span class="msg-pro-badge">⭐ PRO</span>' : '';
    const senderClass = isSenderPro ? 'msg-sender pro-sender' : 'msg-sender';
    const avatarClass = isSenderPro && !own ? 'msg-avatar pro-av' : 'msg-avatar';
    const avatar = senderName === 'ehoser AI'
        ? '<span class="' + avatarClass + '"><span class="chat-avatar-fallback">AI</span></span>'
        : renderPersonAvatar(senderName, avatarClass);
    row.innerHTML = `
        ${avatar}
        <div class="msg-body">
            ${(!own && senderName !== 'ehoser AI') ? '<span class="' + senderClass + '">' + esc(senderName) + senderBadge + '</span>' : ''}
            <div class="msg-bubble"><div class="msg-content">${content}</div><span class="msg-meta"><span class="msg-time">${timeStr}</span>${own ? '<span class="msg-ticks" aria-label="Beim Server angekommen" title="Beim Server angekommen">✓</span>' : ''}</span></div>
        </div>`;
    const lastVisibleMessage = area.querySelector('.msg-row:last-of-type');
    if (!lastVisibleMessage || lastVisibleMessage.dataset.dateKey !== row.dataset.dateKey) {
        const separator = document.createElement('div');
        separator.className = 'msg-date';
        separator.textContent = formatMessageDate(ts);
        area.appendChild(separator);
    }
    // attach metadata for future updates
    if (m?.id && !String(m.id).startsWith('tmp-')) {
        row.dataset.msgid = String(m.id);
        updateRenderedMessageRow(row, m, plainJson);
    }
    // temp-id handling: if message id looks like a client-temp id, mark element as pending
    if (String(m.id || '').startsWith('tmp-')) {
        row.dataset.tempid = m.id;
        row.classList.add('pending');
        const ticks = row.querySelector('.msg-ticks');
        if (ticks) {
            ticks.textContent = '◷';
            ticks.setAttribute('aria-label', 'Wird gesendet');
            ticks.title = 'Wird gesendet';
        }
        // store pending meta for potential matching
        _pendingMessages[m.id] = { sender: senderName, content };
        area.appendChild(row);
        return;
    }

    // If there is an existing pending element that matches this content and sender (optimistic), upgrade it
    const pendingEls = area.querySelectorAll('[data-tempid]');
    for (const pe of pendingEls) {
        try {
            const pb = pe.querySelector('.msg-content')?.innerHTML || '';
            const pSenderOwn = pe.classList.contains('own');
            if (pb === content && pSenderOwn === own) {
                // upgrade pending element
                const tempKey = pe.getAttribute('data-tempid');
                pe.dataset.msgid = String(m.id);
                updateRenderedMessageRow(pe, m, plainJson);
                pe.removeAttribute('data-tempid');
                pe.classList.remove('pending');
                const ticks = pe.querySelector('.msg-ticks');
                if (ticks) {
                    ticks.textContent = '✓';
                    ticks.setAttribute('aria-label', 'Beim Server angekommen');
                    ticks.title = 'Beim Server angekommen';
                }
                // update time (include date)
                const timeEl = pe.querySelector('.msg-time'); if (timeEl) timeEl.textContent = timeStr;
                if (_activeGroupId && m.id) markMessageSeen(_activeGroupId, m.id);
                if (tempKey) delete _pendingMessages[tempKey];
                return;
            }
        } catch {}
    }
    area.appendChild(row);
    if (m?.id && _activeGroupId) markMessageSeen(_activeGroupId, m.id);
}

function formatMessageDate(date) {
    const current = new Date();
    const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDifference = Math.round((today - target) / 86400000);
    if (dayDifference === 0) return 'Heute';
    if (dayDifference === 1) return 'Gestern';
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderContent(p) {
    if (!p || typeof p !== 'object') return esc(String(p));
    switch (p.t) {
        case 'deleted': return '<span class="message-deleted">🚫 ' + esc(chatText('deletedMessage')) + '</span>';
        case 'txt': return esc(p.v || '').replace(/\n/g, '<br>');
        case 'img': return `<img class="msg-img" src="${esc(p.url)}" alt="${esc(p.name||'Bild')}" loading="lazy" onclick="viewImg(this.src)">`;
        case 'vid': return `<video class="msg-video" src="${esc(p.url)}" controls preload="metadata"></video>`;
        case 'aud': return renderAudio(p);
        case 'fw':  return `<img class="msg-img" src="${esc(p.url)}" alt="Face Warp" loading="lazy" onclick="viewImg(this.src)"><div class="msg-fw-label">🎭 Face Warp</div>`;
        case 'pro_sticker': return renderProSticker(p);
        case 'tic_tac_toe': return isHiddenTicTacToeChallenge(JSON.stringify(p)) ? '' : renderTicTacToeChallenge(p);
        case 'file': return renderFile(p);
        case 'ai_summary': return `<div class="ai-summary-card"><div class="ai-summary-header">🤖 ehoser AI</div><div>${esc(p.summary || '').replace(/\n/g, '<br>')}</div></div>`;
        default: return esc(JSON.stringify(p));
    }
}

function renderProSticker(p) {
    const label = p?.label || 'ehoser PRO';
    return `<div class="pro-sticker"><span class="pro-sticker-logo">E</span><span>${esc(label)}</span></div>`;
}

const TICTACTOE_WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];
const _ticTacToeGames = new Map();

function cleanTicTacToeGameId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || ('ttt_' + Date.now());
}

function getTicTacToeWinner(board) {
    for (const [a, b, c] of TICTACTOE_WIN_LINES) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return '';
}

function ticTacToeMinimax(board, computerTurn, depth = 0) {
    const winner = getTicTacToeWinner(board);
    if (winner === 'O') return 10 - depth;
    if (winner === 'X') return depth - 10;
    if (!board.includes('')) return 0;
    const scores = [];
    for (let index = 0; index < board.length; index += 1) {
        if (board[index]) continue;
        board[index] = computerTurn ? 'O' : 'X';
        scores.push(ticTacToeMinimax(board, !computerTurn, depth + 1));
        board[index] = '';
    }
    return computerTurn ? Math.max(...scores) : Math.min(...scores);
}

function bestTicTacToeMove(board) {
    let bestScore = -Infinity;
    let bestMove = -1;
    for (let index = 0; index < board.length; index += 1) {
        if (board[index]) continue;
        board[index] = 'O';
        const score = ticTacToeMinimax(board, false, 0);
        board[index] = '';
        if (score > bestScore) {
            bestScore = score;
            bestMove = index;
        }
    }
    return bestMove;
}

function getTicTacToeGame(payload) {
    const gameId = cleanTicTacToeGameId(payload?.gameId);
    if (!_ticTacToeGames.has(gameId)) {
        _ticTacToeGames.set(gameId, {
            board: Array(9).fill(''),
            finished: false,
            status: 'Du bist X. Die KI spielt O.',
            text: String(payload?.text || 'Wer gewinnt, ist mein bester Freund. Sonst war’s das mit der Freundschaft 😄')
        });
    }
    return { gameId, game: _ticTacToeGames.get(gameId) };
}

function renderTicTacToeChallenge(payload) {
    const { gameId, game } = getTicTacToeGame(payload);
    const cells = game.board.map((mark, index) => `<button type="button" class="ttt-cell ${mark ? 'marked' : ''}" ${mark || game.finished ? 'disabled' : ''} onclick="playTicTacToeCell('${gameId}', ${index})">${mark || ''}</button>`).join('');
    return `<section class="tic-tac-toe-card" data-tic-tac-toe="${gameId}">
        <div class="ttt-head"><span aria-hidden="true">🎮</span><div><strong>Unmögliche Tic-Tac-Toe KI</strong><small>${esc(game.text)}</small></div></div>
        <div class="ttt-board" role="grid" aria-label="Tic-Tac-Toe">${cells}</div>
        <div class="ttt-foot"><span>${esc(game.status)}</span>${game.finished ? `<button type="button" onclick="restartTicTacToe('${gameId}')">Nochmal</button>` : ''}</div>
    </section>`;
}

function repaintTicTacToeGame(gameId) {
    const safeGameId = cleanTicTacToeGameId(gameId);
    const card = document.querySelector(`.tic-tac-toe-card[data-tic-tac-toe="${safeGameId}"]`);
    const game = _ticTacToeGames.get(safeGameId);
    if (!card || !game) return;
    card.outerHTML = renderTicTacToeChallenge({ gameId: safeGameId, text: game.text });
}

function playTicTacToeCell(gameId, index) {
    const safeGameId = cleanTicTacToeGameId(gameId);
    const game = _ticTacToeGames.get(safeGameId);
    if (!game || game.finished || game.board[index]) return;
    game.board[index] = 'X';
    if (getTicTacToeWinner(game.board) === 'X') {
        game.finished = true;
        game.status = '🎉 Du gewinnst – du bist mein bester Freund!';
        repaintTicTacToeGame(safeGameId);
        return;
    }
    if (!game.board.includes('')) {
        game.finished = true;
        game.status = 'Unentschieden – die KI bleibt ungeschlagen.';
        repaintTicTacToeGame(safeGameId);
        return;
    }
    const aiMove = bestTicTacToeMove(game.board);
    if (aiMove >= 0) game.board[aiMove] = 'O';
    if (getTicTacToeWinner(game.board) === 'O') {
        game.finished = true;
        game.status = 'Die KI gewinnt – war’s das mit der Freundschaft 😄';
    } else if (!game.board.includes('')) {
        game.finished = true;
        game.status = 'Unentschieden – die KI bleibt ungeschlagen.';
    } else {
        game.status = 'Die KI hat gezogen. Du bist wieder dran.';
    }
    repaintTicTacToeGame(safeGameId);
}

function restartTicTacToe(gameId) {
    const safeGameId = cleanTicTacToeGameId(gameId);
    const game = _ticTacToeGames.get(safeGameId);
    if (!game) return;
    game.board = Array(9).fill('');
    game.finished = false;
    game.status = 'Du bist X. Die KI spielt O.';
    repaintTicTacToeGame(safeGameId);
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

function canEditMessage(row) {
    if (!row?.dataset?.msgid || row.dataset.deleted === 'true') return false;
    return row.dataset.sender === String(_me?.username || '');
}

function canDeleteMessage(row) {
    return Boolean(row?.dataset?.msgid) && row.dataset.deleted !== 'true'
        && row.dataset.sender === String(_me?.username || '');
}

function closeMessageContextMenu() {
    document.getElementById('ehoser-ctx-menu')?.remove();
}

function addMessageContextAction(menu, label, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-context-action ' + className;
    button.textContent = label;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMessageContextMenu();
        onClick();
    });
    menu.appendChild(button);
}

function showMessageContextMenu(row, x, y) {
    closeMessageContextMenu();
    if (!row?.dataset?.msgid || row.dataset.deleted === 'true') return;
    const menu = document.createElement('div');
    menu.id = 'ehoser-ctx-menu';
    menu.className = 'message-context-menu';
    menu.setAttribute('role', 'menu');

    addMessageContextAction(menu, row.dataset.pinned === 'true' ? 'Nicht mehr anpinnen' : '📌 Anpinnen', () => togglePinnedMessage(row));
    if (canEditMessage(row)) addMessageContextAction(menu, 'Bearbeiten', () => startEditMessage(row));
    if (canDeleteMessage(row)) addMessageContextAction(menu, 'Löschen', () => deleteMessage(row), 'danger');
    document.body.appendChild(menu);

    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(margin, Math.min(x + 4, window.innerWidth - rect.width - margin)) + 'px';
    menu.style.top = Math.max(margin, Math.min(y + 4, window.innerHeight - rect.height - margin)) + 'px';
}

function initMessageContextMenu() {
    if (window._ehoserCtxAttached) return;
    document.addEventListener('contextmenu', (event) => {
        const row = event.target.closest?.('.msg-row');
        if (!row?.dataset?.msgid || row.dataset.deleted === 'true') return;
        event.preventDefault();
        showMessageContextMenu(row, event.clientX, event.clientY);
    });
    document.addEventListener('click', (event) => {
        const menu = document.getElementById('ehoser-ctx-menu');
        if (menu && !menu.contains(event.target)) closeMessageContextMenu();
    });
    window.addEventListener('scroll', closeMessageContextMenu, true);
    window.addEventListener('resize', closeMessageContextMenu);
    window._ehoserCtxAttached = true;
}

initMessageContextMenu();

async function startEditMessage(row) {
    if (!canEditMessage(row)) return alert('Diese Nachricht kann nicht bearbeitet werden');
    const msgId = row.dataset.msgid;
    const plainEnc = row.dataset.plain || '';
    let currText = '';
    try {
        const plain = plainEnc ? decodeURIComponent(plainEnc) : null;
        const payload = safeJsonParse(plain, null);
        if (!payload || payload.t !== 'txt') return alert('Nur Textnachrichten können bearbeitet werden');
        currText = payload.v || '';
    } catch { return alert('Fehler beim Lesen der Nachricht'); }
    const newText = prompt('Bearbeite Nachricht:', currText);
    if (newText === null) return;
    await editMessage(msgId, newText, row);
}

async function editMessage(msgId, newText, row) {
    try {
        const gid = _activeGroupId;
        if (!gid) throw new Error('Keine Gruppe aktiv');
        const response = await api('/chat/messages/' + msgId, 'PATCH', { content: JSON.stringify({ t: 'txt', v: String(newText) }) });
        if (!response.message) throw new Error('Die aktualisierte Nachricht fehlt');
        updateRenderedMessageRow(row, response.message, readStoredMessage(response.message.content));
        updateCachedMessage(gid, response.message);
        toast('Nachricht bearbeitet', 'ok');
    } catch (error) { toast('Bearbeiten fehlgeschlagen: ' + error.message, 'err'); }
}

async function deleteMessage(row) {
    if (!canDeleteMessage(row)) return;
    if (!confirm('Diese Nachricht für alle löschen?')) return;
    try {
        const gid = _activeGroupId;
        const response = await api('/chat/messages/' + row.dataset.msgid, 'DELETE');
        if (!response.message) throw new Error('Die gelöschte Nachricht fehlt');
        updateRenderedMessageRow(row, response.message, readStoredMessage(response.message.content));
        updateCachedMessage(gid, response.message);
        updatePinnedMessageBanner(null);
        toast('Nachricht gelöscht', 'ok');
    } catch (error) { toast('Löschen fehlgeschlagen: ' + error.message, 'err'); }
}

async function togglePinnedMessage(row) {
    if (!row?.dataset?.msgid || row.dataset.deleted === 'true') return;
    try {
        const gid = _activeGroupId;
        const pinned = row.dataset.pinned !== 'true';
        const response = await api('/chat/messages/' + row.dataset.msgid + '/pin', 'POST', { pinned });
        if (!response.message) throw new Error('Die angepinnte Nachricht fehlt');
        const cleared = new Set((response.clearedMessageIds || []).map(String));
        if (cleared.size) {
            const cache = readChatCache('messages', {});
            cache[gid] = (cache[gid] || []).map((message) => cleared.has(String(message?.id))
                ? { ...message, pinned_at: null, pinned_by: null }
                : message);
            writeChatCache('messages', cache);
            for (const id of cleared) {
                const previousRow = document.querySelector('#messagesArea .msg-row[data-msgid="' + id + '"]');
                if (previousRow) previousRow.dataset.pinned = 'false';
                previousRow?.classList.remove('pinned');
            }
        }
        updateRenderedMessageRow(row, response.message, readStoredMessage(response.message.content));
        updateCachedMessage(gid, response.message);
        updatePinnedMessageBanner(pinned ? response.message : null);
        toast(pinned ? 'Nachricht angepinnt' : 'Nachricht nicht mehr angepinnt', 'ok');
    } catch (error) { toast('Anpinnen fehlgeschlagen: ' + error.message, 'err'); }
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
    stopChatTyping();
    inp.value = ''; inp.style.height = ''; inp.disabled = true;
    const ticTacToeTest = String(_me?.username || '').toLowerCase() === 'meisterlool_707' && text === '/test';
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    const storedContent = JSON.stringify({ t:'txt', v:text });
    const tempMessage = { id: tempId, sender: _me.username, created_at: new Date().toISOString(), content: storedContent };
    if (!ticTacToeTest) {
        appendMessage(tempMessage, storedContent);
        persistMessages(_activeGroupId, [tempMessage]);
    }
    try {
        const { id, created_at, command } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, content: storedContent });
        if (command === 'tic_tac_toe') {
            toast('Tic-Tac-Toe wurde an den anderen Nutzer gesendet.', 'ok');
            _lastMsgId[_activeGroupId] = id;
            return;
        }
        const finalMessage = { id, sender: _me.username, created_at, content: storedContent };
        replaceCachedMessage(_activeGroupId, tempId, finalMessage);
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
    const storedContent = JSON.stringify(payload);
    const tempMessage = { id: tempId, sender: _me.username, created_at: new Date().toISOString(), content: storedContent };
    appendMessage(tempMessage, storedContent);
    persistMessages(_activeGroupId, [tempMessage]);
    try {
        const { id, created_at } = await api('/chat/messages', 'POST', { groupId: _activeGroupId, content: storedContent });
        replaceCachedMessage(_activeGroupId, tempId, { id, sender: _me.username, created_at, content: storedContent });
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
            updateRenderedMessageRow(el, { id: realId, sender: _me.username, created_at, content }, plainJson);
            el.removeAttribute('data-tempid');
            el.classList.remove('pending');
            const ticks = el.querySelector('.msg-ticks');
            if (ticks) {
                ticks.textContent = '✓';
                ticks.classList.remove('read');
                ticks.setAttribute('aria-label', 'Beim Server angekommen');
                ticks.title = 'Beim Server angekommen';
            }
            const ts2 = parseServerDate(created_at || Date.now());
            const timeStr2 = ts2.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
            const timeEl = el.querySelector('.msg-time'); if (timeEl) timeEl.textContent = timeStr2;
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
    if (e.key === 'Enter' && !e.shiftKey && _meProfile?.settings?.chatEnterToSend !== false) {
        e.preventDefault();
        sendMessage();
    }
}

function handleMessageInput(el) {
    autoResize(el);
    if (String(el?.value || '').trim()) signalChatTyping();
    else stopChatTyping();
}

function signalChatTyping() {
    const gid = _activeGroupId;
    if (!gid || !_chatStarted) return;
    const now = Date.now();
    _typingGroupId = gid;
    clearTimeout(_typingStopTimer);
    _typingStopTimer = setTimeout(() => stopChatTyping(gid), 4000);
    if (now - _typingLastSentAt < 2000) return;
    _typingLastSentAt = now;
    api('/chat/groups/' + gid + '/typing', 'POST', { active: true }).catch(() => {});
}

function stopChatTyping(gid = _typingGroupId || _activeGroupId) {
    if (!gid || _typingGroupId !== gid) return;
    clearTimeout(_typingStopTimer);
    _typingStopTimer = null;
    _typingGroupId = null;
    _typingLastSentAt = 0;
    api('/chat/groups/' + gid + '/typing', 'POST', { active: false }).catch(() => {});
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
    replaceAvatarElement(document.getElementById('callAvatar'), renderPersonAvatar(peerName, 'call-avatar'));
    document.getElementById('callStatus').textContent = status || 'Verbindung wird aufgebaut…';
    document.getElementById('callTimer').textContent = '';
    overlay.classList.remove('video-active');
    overlay.style.display = 'flex';
    _callDevicePanelOpen = false;
    document.getElementById('callDevicePanel').style.display = 'none';
    document.getElementById('deviceSettingsCallBtn')?.classList.remove('active');
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
    const switchButton = document.getElementById('switchCameraCallBtn');
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
    if (localVideo) {
        localVideo.classList.toggle('visible', Boolean(videoTrack?.enabled));
        localVideo.classList.toggle('rear-camera', _callFacingMode === 'environment');
    }
    if (switchButton) {
        switchButton.style.display = videoTrack?.enabled && _callVideoInputCount > 1 ? 'flex' : 'none';
        switchButton.disabled = _cameraSwitchBusy || !videoTrack?.enabled;
        switchButton.classList.toggle('switching', _cameraSwitchBusy);
        const label = switchButton.querySelector('small');
        if (label) label.textContent = _cameraSwitchBusy ? 'Wechsel…' : 'Drehen';
    }
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
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: callAudioConstraints(_preferredCallMicId),
            video: withVideo ? cameraVideoConstraints(_callFacingMode, _preferredCallCameraId) : false
        });
    } catch (error) {
        if (!['NotFoundError', 'OverconstrainedError'].includes(error?.name) || (!_preferredCallMicId && !_preferredCallCameraId)) throw error;
        _preferredCallMicId = '';
        _preferredCallCameraId = '';
        localStorage.removeItem('ehoserCallMicId');
        localStorage.removeItem('ehoserCallCameraId');
        return navigator.mediaDevices.getUserMedia({
            audio: callAudioConstraints(),
            video: withVideo ? cameraVideoConstraints(_callFacingMode) : false
        });
    }
}

function callAudioConstraints(deviceId = '') {
    const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    return constraints;
}

function cameraVideoConstraints(facingMode, deviceId = '') {
    const constraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: { ideal: facingMode }
    };
    if (deviceId) {
        delete constraints.facingMode;
        constraints.deviceId = { exact: deviceId };
    }
    return constraints;
}

async function acquireOtherCamera(oldTrack, facingMode) {
    const oldDeviceId = oldTrack?.getSettings?.().deviceId || '';
    const devices = navigator.mediaDevices.enumerateDevices
        ? (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput')
        : [];
    const alternatives = devices.filter((device) => !oldDeviceId || device.deviceId !== oldDeviceId);
    const labelPattern = facingMode === 'environment'
        ? /(back|rear|environment|rück|hinten)/i
        : /(front|user|face|vorder|selfie)/i;
    const target = alternatives.find((device) => labelPattern.test(device.label || '')) || alternatives[0] || null;
    const constraints = cameraVideoConstraints(facingMode, target?.deviceId || '');

    if (oldTrack?.applyConstraints) {
        try {
            await oldTrack.applyConstraints(constraints);
            const settings = oldTrack.getSettings?.() || {};
            if ((target?.deviceId && settings.deviceId === target.deviceId) || settings.facingMode === facingMode) {
                return { track: oldTrack, stream: null };
            }
        } catch {}
    }

    if (devices.length === 1 && !alternatives.length) {
        throw new Error('Keine zweite Kamera gefunden.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Andere Kamera konnte nicht geöffnet werden.');
    return { track, stream };
}

function fillCallDeviceSelect(selectId, devices, selectedId, fallbackLabel) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.replaceChildren();
    devices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
        select.appendChild(option);
    });
    if (selectedId && devices.some((device) => device.deviceId === selectedId)) select.value = selectedId;
}

async function refreshCallDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === 'videoinput');
        const microphones = devices.filter((device) => device.kind === 'audioinput');
        const speakers = devices.filter((device) => device.kind === 'audiooutput');
        _callVideoInputCount = cameras.length;
        const currentCamera = _localCallStream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || _preferredCallCameraId;
        const currentMic = _localCallStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId || _preferredCallMicId;
        fillCallDeviceSelect('callCameraSelect', cameras, currentCamera, 'Kamera');
        fillCallDeviceSelect('callMicSelect', microphones, currentMic, 'Mikrofon');
        fillCallDeviceSelect('callSpeakerSelect', speakers, _preferredCallSpeakerId, 'Lautsprecher');
        const speakerSupported = typeof document.getElementById('remoteAudio')?.setSinkId === 'function';
        document.getElementById('callSpeakerRow').style.display = speakerSupported && speakers.length ? 'grid' : 'none';
        updateCallControlState();
    } catch {}
}

function toggleCallDevicePanel(force) {
    if (!_currentCall) return;
    _callDevicePanelOpen = typeof force === 'boolean' ? force : !_callDevicePanelOpen;
    document.getElementById('callDevicePanel').style.display = _callDevicePanelOpen ? 'block' : 'none';
    document.getElementById('deviceSettingsCallBtn')?.classList.toggle('active', _callDevicePanelOpen);
    if (_callDevicePanelOpen) refreshCallDevices();
}

async function selectCallCamera(deviceId) {
    if (!deviceId || !_localCallStream || !_peerConnection) return;
    const oldTrack = _localCallStream.getVideoTracks()[0];
    if (!oldTrack) {
        toast('Schalte zuerst die Kamera ein.', 'err');
        return;
    }
    try {
        let newTrack = oldTrack;
        try { await oldTrack.applyConstraints(cameraVideoConstraints('user', deviceId)); } catch {}
        if (oldTrack.getSettings?.().deviceId !== deviceId) {
            const stream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints('user', deviceId), audio: false });
            newTrack = stream.getVideoTracks()[0];
            const sender = _peerConnection.getSenders().find((item) => item.track?.kind === 'video');
            if (!newTrack || !sender) throw new Error('Kamera konnte nicht übernommen werden.');
            await sender.replaceTrack(newTrack);
            _localCallStream.removeTrack(oldTrack);
            _localCallStream.addTrack(newTrack);
            oldTrack.stop();
        }
        _preferredCallCameraId = deviceId;
        localStorage.setItem('ehoserCallCameraId', deviceId);
        _callFacingMode = newTrack.getSettings?.().facingMode || 'user';
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = _localCallStream;
        await localVideo.play().catch(() => {});
        updateCallControlState();
        await refreshCallDevices();
        setCallStatus('Kamera gewechselt');
    } catch (error) {
        toast(error?.message || 'Kamera konnte nicht gewechselt werden.', 'err');
    }
}

async function selectCallMicrophone(deviceId) {
    if (!deviceId || !_localCallStream || !_peerConnection) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: callAudioConstraints(deviceId), video: false });
        const newTrack = stream.getAudioTracks()[0];
        const oldTrack = _localCallStream.getAudioTracks()[0];
        const sender = _peerConnection.getSenders().find((item) => item.track?.kind === 'audio');
        if (!newTrack || !sender) throw new Error('Mikrofon konnte nicht übernommen werden.');
        newTrack.enabled = oldTrack?.enabled ?? true;
        await sender.replaceTrack(newTrack);
        if (oldTrack) {
            _localCallStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        _localCallStream.addTrack(newTrack);
        _preferredCallMicId = deviceId;
        localStorage.setItem('ehoserCallMicId', deviceId);
        updateCallControlState();
        await refreshCallDevices();
        setCallStatus('Mikrofon gewechselt');
    } catch (error) {
        toast(error?.message || 'Mikrofon konnte nicht gewechselt werden.', 'err');
    }
}

async function selectCallSpeaker(deviceId) {
    if (!deviceId) return;
    try {
        const outputs = [document.getElementById('remoteAudio'), document.getElementById('remoteVideo')];
        await Promise.all(outputs.filter((element) => typeof element?.setSinkId === 'function').map((element) => element.setSinkId(deviceId)));
        _preferredCallSpeakerId = deviceId;
        localStorage.setItem('ehoserCallSpeakerId', deviceId);
        setCallStatus('Lautsprecher gewechselt');
    } catch {
        toast('Dieser Browser kann den Lautsprecher nicht wechseln.', 'err');
    }
}

async function ensureCallRtcConfig() {
    if (_callRtcConfigPromise) return _callRtcConfigPromise;
    _callRtcConfigPromise = (async () => {
        try {
            const data = await api('/chat/calls/config');
            if (Array.isArray(data?.iceServers) && data.iceServers.length) {
                _callRtcConfig = { ...FALLBACK_RTC_CONFIG, iceServers: data.iceServers };
            }
        } catch {
            // The built-in relay remains available when no custom TURN server is configured.
        }
        return _callRtcConfig;
    })();
    return _callRtcConfigPromise;
}

function resumeRemoteCallPlayback() {
    const media = [document.getElementById('remoteAudio'), document.getElementById('remoteVideo')];
    media.forEach((element) => element?.play?.().catch(() => {}));
}

function clearCallRecovery() {
    clearTimeout(_callRecoveryTimer);
    _callRecoveryTimer = null;
    _callRecoveryAttempts = 0;
    _callRecoveryBusy = false;
}

function scheduleCallRecovery() {
    if (!_currentCall?.id || !_peerConnection || _finishingCall || _callRecoveryTimer || _callRecoveryBusy) return;
    // Only the caller starts a new offer, avoiding a collision when both
    // devices notice a short Wi-Fi/mobile-network interruption together.
    if (_currentCall.role !== 'caller') {
        setCallStatus('Verbindung wird wiederhergestellt…');
        return;
    }
    if (_callRecoveryAttempts >= 3) {
        setCallStatus('Verbindung unterbrochen. Warte auf das Netzwerk oder lege auf.');
        return;
    }
    setCallStatus('Verbindung wird wiederhergestellt…');
    _callRecoveryTimer = setTimeout(restartCallIce, 1200);
}

async function restartCallIce() {
    _callRecoveryTimer = null;
    const peer = _peerConnection;
    if (!_currentCall?.id || !peer || _finishingCall || _callRecoveryBusy) return;
    if (peer.signalingState !== 'stable') {
        scheduleCallRecovery();
        return;
    }
    _callRecoveryBusy = true;
    _callRecoveryAttempts += 1;
    let retry = false;
    try {
        peer.restartIce?.();
        const offer = await peer.createOffer({ iceRestart: true });
        if (peer !== _peerConnection || _finishingCall) return;
        await peer.setLocalDescription(offer);
        await postCallSignal('offer', peer.localDescription.toJSON ? peer.localDescription.toJSON() : peer.localDescription);
        setCallStatus('Verbindung wird wiederhergestellt…');
    } catch {
        if (_callRecoveryAttempts >= 3) setCallStatus('Verbindung unterbrochen. Prüfe dein Internet.');
        else retry = true;
    } finally {
        _callRecoveryBusy = false;
        if (retry) scheduleCallRecovery();
    }
}

function createPeerConnection() {
    if (_peerConnection) {
        try { _peerConnection.close(); } catch {}
    }
    _remoteCallStream = new MediaStream();
    _peerConnection = new RTCPeerConnection(_callRtcConfig);
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
            if (track.kind === 'audio') {
                track.onunmute = () => {
                    resumeRemoteCallPlayback();
                    if (_peerConnection?.connectionState === 'connected') setCallStatus('Verbunden');
                };
            }
        }
        const remoteVideo = document.getElementById('remoteVideo');
        const remoteAudio = document.getElementById('remoteAudio');
        remoteVideo.muted = true;
        remoteVideo.autoplay = true;
        remoteVideo.srcObject = _remoteCallStream;
        remoteAudio.muted = false;
        remoteAudio.autoplay = true;
        remoteAudio.volume = 1;
        remoteAudio.srcObject = _remoteCallStream;
        if (_preferredCallSpeakerId) {
            remoteAudio.setSinkId?.(_preferredCallSpeakerId).catch(() => {});
            remoteVideo.setSinkId?.(_preferredCallSpeakerId).catch(() => {});
        }
        resumeRemoteCallPlayback();
        updateRemoteVideoState();
    };
    _peerConnection.onconnectionstatechange = () => {
        if (!_peerConnection || _finishingCall) return;
        if (_peerConnection.connectionState === 'connected') {
            clearCallRecovery();
            setCallStatus('Verbunden');
            startCallTimer();
        } else if (_peerConnection.connectionState === 'failed') {
            scheduleCallRecovery();
        } else if (_peerConnection.connectionState === 'disconnected') {
            scheduleCallRecovery();
        }
    };
    _peerConnection.oniceconnectionstatechange = () => {
        if (!_peerConnection || _finishingCall) return;
        if (['connected', 'completed'].includes(_peerConnection.iceConnectionState)) clearCallRecovery();
        else if (['disconnected', 'failed'].includes(_peerConnection.iceConnectionState)) scheduleCallRecovery();
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
    _callFacingMode = 'user';
    _currentCall = { id: null, role: 'caller', peerName, mediaType, remoteVideoEnabled: mediaType === 'video' };
    updateCallButtons();
    openCallUi(peerName, mediaType === 'video' ? 'Kamera und Mikrofon werden gestartet…' : 'Mikrofon wird gestartet…', mediaType === 'video');
    try {
        await ensureCallRtcConfig();
        _localCallStream = await getCallMedia(mediaType === 'video');
        document.getElementById('localVideo').srcObject = _localCallStream;
        refreshCallDevices();
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
    replaceAvatarElement(document.getElementById('incomingCallAvatar'), renderPersonAvatar(caller, 'incoming-avatar'));
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
    _callFacingMode = 'user';
    openCallUi(call.caller, withVideo ? 'Kamera und Mikrofon werden gestartet…' : 'Mikrofon wird gestartet…', withVideo);
    try {
        await ensureCallRtcConfig();
        _localCallStream = await getCallMedia(withVideo);
        document.getElementById('localVideo').srcObject = _localCallStream;
        refreshCallDevices();
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
        const labels = { rejected: 'Anruf wurde abgelehnt.', missed: 'Nicht erreichbar.', ended: 'Anruf beendet.' };
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
            let cameraStream;
            try {
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(_callFacingMode, _preferredCallCameraId), audio: false });
            } catch (error) {
                if (!['NotFoundError', 'OverconstrainedError'].includes(error?.name) || !_preferredCallCameraId) throw error;
                _preferredCallCameraId = '';
                localStorage.removeItem('ehoserCallCameraId');
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(_callFacingMode), audio: false });
            }
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
        refreshCallDevices();
    } catch (error) {
        toast(error?.name === 'NotAllowedError' ? 'Kamera wurde nicht erlaubt.' : 'Kamera konnte nicht gestartet werden.', 'err');
    }
}

async function switchCallCamera() {
    const oldTrack = _localCallStream?.getVideoTracks?.()[0];
    if (!oldTrack?.enabled || !_peerConnection || _cameraSwitchBusy) return;
    _cameraSwitchBusy = true;
    updateCallControlState();
    const nextFacingMode = _callFacingMode === 'user' ? 'environment' : 'user';
    let replacement = null;
    let installed = false;
    try {
        replacement = await acquireOtherCamera(oldTrack, nextFacingMode);
        if (replacement.track !== oldTrack) {
            const sender = _peerConnection.getSenders().find((item) => item.track?.kind === 'video');
            if (!sender) throw new Error('Videoverbindung ist noch nicht bereit.');
            await sender.replaceTrack(replacement.track);
            _localCallStream.removeTrack(oldTrack);
            _localCallStream.addTrack(replacement.track);
            oldTrack.stop();
            installed = true;
        }
        _callFacingMode = nextFacingMode;
        _preferredCallCameraId = replacement.track.getSettings?.().deviceId || _preferredCallCameraId;
        if (_preferredCallCameraId) localStorage.setItem('ehoserCallCameraId', _preferredCallCameraId);
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = _localCallStream;
        await localVideo.play().catch(() => {});
        postCallSignal('media', { video: true }).catch(() => {});
        refreshCallDevices();
        setCallStatus(nextFacingMode === 'environment' ? 'Rückkamera aktiv' : 'Vorderkamera aktiv');
    } catch (error) {
        if (!installed && replacement?.track && replacement.track !== oldTrack) replacement.track.stop();
        toast(error?.message || 'Kamera konnte nicht gewechselt werden.', 'err');
    } finally {
        _cameraSwitchBusy = false;
        updateCallControlState();
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
    clearCallRecovery();
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
    _callFacingMode = 'user';
    _cameraSwitchBusy = false;
    _callDevicePanelOpen = false;
    document.getElementById('callDevicePanel').style.display = 'none';
    document.getElementById('deviceSettingsCallBtn')?.classList.remove('active');
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

// Some mobile browsers defer unmuted playback even after a call was accepted.
// Any tap inside the active-call UI retries playback without changing the call.
document.getElementById('callOverlay')?.addEventListener('click', () => {
    if (_currentCall) resumeRemoteCallPlayback();
});

document.addEventListener('keydown', (event) => {
    if (!_currentCall || document.getElementById('callOverlay')?.style.display === 'none') return;
    const target = event.target;
    if (target?.matches?.('input, textarea, select') || target?.isContentEditable) return;
    if (event.key === 'Escape' && _callDevicePanelOpen) {
        event.preventDefault();
        toggleCallDevicePanel(false);
    } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggleCallMute();
    } else if (event.key.toLowerCase() === 'v') {
        event.preventDefault();
        toggleCallVideo();
    } else if (event.key.toLowerCase() === 'c' && _callVideoInputCount > 1) {
        event.preventDefault();
        switchCallCamera();
    }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (_currentCall) refreshCallDevices();
});

window.addEventListener('online', () => {
    if (_currentCall) scheduleCallRecovery();
});

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

// ─── Chat settings ───────────────────────────────────────────────────────────
async function openChatSettings() {
    const settings = _meProfile?.settings || {};
    const username = _me?.username || 'Nutzer';
    document.getElementById('settingsUsername').textContent = username;
    document.getElementById('settingsEmail').textContent = 'Kontodaten werden geladen…';
    document.getElementById('settingsAvatarUrl').value = settings.avatarUrl || '';
    document.getElementById('settingsAvatarHint').textContent = 'JPG, PNG, GIF oder WebP · maximal 8 MB';
    refreshChatAvatarPreview();
    document.getElementById('settingsPlan').textContent = _meProfile?.isPremium ? 'Premium' : (_meProfile?.isPro ? 'PRO' : 'Gratis');
    document.getElementById('settingsLanguage').value = chatLanguage();
    document.getElementById('settingsEnterToSend').checked = settings.chatEnterToSend !== false;
    document.getElementById('settingsCompactMode').checked = Boolean(settings.chatCompactMode);
    document.getElementById('settingsShowPreviews').checked = settings.chatShowPreviews !== false;
    const isEhoserOwner = String(username).toLowerCase() === 'meisterlool_707';
    const presenceSection = document.getElementById('settingsPresenceOverrideSection');
    if (presenceSection) presenceSection.hidden = !isEhoserOwner;
    if (isEhoserOwner) document.getElementById('settingsPresenceOverride').value = settings.presenceOverride || 'automatic';
    const permission = IS_EHOSER_ANDROID_APP
        ? (hasChatNotificationPermission() ? 'granted' : 'denied')
        : window.Notification?.permission;
    document.getElementById('settingsNotificationState').textContent = permission === 'granted'
        ? 'Aktiv für Nachrichten und Anrufe'
        : permission === 'denied'
            ? (IS_EHOSER_ANDROID_APP ? 'In Android blockiert' : 'Im Browser blockiert')
            : 'Noch nicht erlaubt';
    const code = document.getElementById('settingsLoginCode');
    code.textContent = '••••••';
    code.dataset.revealed = 'false';
    document.getElementById('settingsRevealCode').textContent = 'Anzeigen';
    document.getElementById('settingsSaveStatus').textContent = '';
    _chatSettingsLoginCode = null;
    openModal('chatSettingsModal');
    loadSettingsOnlineList();

    const [accountResult, codeResult] = await Promise.allSettled([
        api('/me'),
        api('/me/login-code')
    ]);
    if (accountResult.status === 'fulfilled') {
        const account = accountResult.value;
        _meProfile = account.profile || _meProfile;
        document.getElementById('settingsAvatarUrl').value = _meProfile?.settings?.avatarUrl || document.getElementById('settingsAvatarUrl').value;
        refreshChatAvatarPreview();
        const email = account.user?.email;
        document.getElementById('settingsEmail').textContent = email || 'Keine E-Mail hinterlegt';
        document.getElementById('settingsPlan').textContent = _meProfile?.isPremium ? 'Premium' : (_meProfile?.isPro ? 'PRO' : 'Gratis');
    } else {
        document.getElementById('settingsEmail').textContent = 'Kontodaten konnten nicht geladen werden';
    }
    if (codeResult.status === 'fulfilled') {
        _chatSettingsLoginCode = codeResult.value.loginCode || null;
    }
}

async function loadSettingsOnlineList() {
    const list = document.getElementById('settingsOnlineList');
    const count = document.getElementById('settingsOnlineCount');
    if (!list || !count) return;
    const requestId = ++_settingsOnlineRequestId;
    count.textContent = 'Kontakte werden geladen…';
    list.innerHTML = '<li class="settings-online-loading">Online-Liste wird geladen…</li>';
    try {
        await sendChatHeartbeat();
        const data = await api('/chat/contacts');
        if (requestId !== _settingsOnlineRequestId) return;
        const users = data.contacts || [];
        rememberChatProfiles(users);
        const onlineCount = users.filter((user) => isUserOnline(user?.last_seen, user?.presence_override)).length;
        count.textContent = `${onlineCount} online · ${users.length} Kontakte`;
        if (!users.length) {
            list.innerHTML = '<li class="settings-online-empty">Noch keine anderen Nutzer vorhanden.</li>';
            return;
        }
        list.innerHTML = users.map((user) => {
            const username = String(user?.username || 'Gast');
            const online = isUserOnline(user?.last_seen, user?.presence_override);
            return `<li>
                ${renderPersonAvatar(username, 'settings-online-avatar', user)}
                <span class="settings-online-user">${esc(username)}<small>${esc(lastSeenLabel(user?.last_seen, user?.presence_override))}</small></span>
                <i class="${online ? '' : 'offline'}" aria-label="${online ? 'online' : 'zuletzt online'}"></i>
            </li>`;
        }).join('');
    } catch (error) {
        if (requestId !== _settingsOnlineRequestId) return;
        count.textContent = 'Online-Liste nicht verfügbar';
        list.innerHTML = '<li class="settings-online-empty">' + esc(error?.message || 'Die Online-Liste konnte nicht geladen werden.') + '</li>';
    }
}

async function loadChatSettingsLoginCode() {
    if (_chatSettingsLoginCode) return _chatSettingsLoginCode;
    try {
        const data = await api('/me/login-code');
        _chatSettingsLoginCode = data.loginCode || null;
    } catch {}
    return _chatSettingsLoginCode;
}

async function toggleChatLoginCode() {
    const display = document.getElementById('settingsLoginCode');
    const button = document.getElementById('settingsRevealCode');
    if (display.dataset.revealed === 'true') {
        display.textContent = '••••••';
        display.dataset.revealed = 'false';
        button.textContent = 'Anzeigen';
        return;
    }
    button.disabled = true;
    const loginCode = await loadChatSettingsLoginCode();
    button.disabled = false;
    if (!loginCode) {
        toast('Login-Code konnte nicht geladen werden.', 'err');
        return;
    }
    display.textContent = loginCode;
    display.dataset.revealed = 'true';
    button.textContent = 'Verbergen';
}

async function copyChatLoginCode() {
    const loginCode = await loadChatSettingsLoginCode();
    if (!loginCode) {
        toast('Login-Code konnte nicht geladen werden.', 'err');
        return;
    }
    try {
        await navigator.clipboard.writeText(loginCode);
        toast('Login-Code kopiert.', 'ok');
    } catch {
        toast('Kopieren wurde vom Browser blockiert.', 'err');
    }
}

async function saveChatSettings() {
    const button = document.getElementById('settingsSaveButton');
    const status = document.getElementById('settingsSaveStatus');
    button.disabled = true;
    status.className = 'status-msg';
    status.textContent = 'Wird gespeichert…';
    try {
        const payload = {
            language: document.getElementById('settingsLanguage').value,
            chatEnterToSend: document.getElementById('settingsEnterToSend').checked,
            chatCompactMode: document.getElementById('settingsCompactMode').checked,
            chatShowPreviews: document.getElementById('settingsShowPreviews').checked,
            avatarUrl: document.getElementById('settingsAvatarUrl').value.trim()
        };
        if (String(_me?.username || '').toLowerCase() === 'meisterlool_707') {
            payload.presenceOverride = document.getElementById('settingsPresenceOverride').value;
        }
        const data = await api('/me/settings', 'PUT', payload);
        _meProfile = data.profile || _meProfile;
        document.getElementById('settingsAvatarUrl').value = _meProfile?.settings?.avatarUrl || '';
        rememberChatProfiles([{ username: _me?.username, avatar_url: _meProfile?.settings?.avatarUrl || '' }]);
        refreshChatAvatarPreview();
        applyChatPreferences();
        status.textContent = '✓ Gespeichert';
        toast('Einstellungen gespeichert.', 'ok');
    } catch (error) {
        status.className = 'status-msg error';
        status.textContent = error.message || 'Speichern fehlgeschlagen';
    } finally {
        button.disabled = false;
    }
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
        if (members.length < 2) {
            toast('Wähle mindestens zwei weitere Kontakte für eine Gruppe. Für einen einzelnen Kontakt tippst du ihn direkt in der Chatliste an.', 'err');
            return;
        }
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
        _activeMembers = members || [];
        const g = _groups.find(x => x.id === _activeGroupId);
        document.getElementById('membersList').innerHTML = members.map(m =>
            `<li>${renderPersonAvatar(m.username, 'member-av')}<span>${esc(m.username)}</span>${g?.created_by === m.username ? '<span class="creator-badge">Ersteller</span>' : ''}</li>`
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

// ─── Profile pictures ───────────────────────────────────────────────────────
function profileKey(username) {
    return String(username || '').trim().toLowerCase();
}

function rememberChatProfiles(profiles) {
    for (const profile of profiles || []) {
        const username = String(profile?.username || '').trim();
        if (!username) continue;
        _chatProfiles.set(profileKey(username), {
            avatarUrl: safeChatAvatarUrl(profile.avatar_url || profile.avatarUrl || ''),
            displayName: String(profile.display_name || profile.displayName || '').trim().slice(0, 40)
        });
    }
}

function safeChatAvatarUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'https:' ? url.toString() : '';
    } catch {
        return '';
    }
}

function profileForChatUser(username, supplied = null) {
    const key = profileKey(username);
    if (supplied) {
        const avatarUrl = safeChatAvatarUrl(supplied.avatar_url || supplied.avatarUrl || '');
        const displayName = String(supplied.display_name || supplied.displayName || '').trim().slice(0, 40);
        if (avatarUrl || displayName) return { avatarUrl, displayName };
    }
    if (key && key === profileKey(_me?.username)) {
        return {
            avatarUrl: safeChatAvatarUrl(_meProfile?.settings?.avatarUrl || ''),
            displayName: String(_meProfile?.settings?.displayName || '').trim().slice(0, 40)
        };
    }
    return _chatProfiles.get(key) || { avatarUrl: '', displayName: '' };
}

function avatarInitials(username) {
    const clean = String(username || '?').trim();
    const words = clean.split(/[\s_-]+/).filter(Boolean);
    return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join('') : clean.slice(0, 2)).toUpperCase();
}

function renderPersonAvatar(username, className, suppliedProfile = null) {
    const profile = profileForChatUser(username, suppliedProfile);
    const image = profile.avatarUrl
        ? '<img class="chat-avatar-image" src="' + esc(profile.avatarUrl) + '" alt="" loading="lazy" onerror="this.remove();this.parentElement.classList.remove(\'has-avatar-image\')">'
        : '';
    return '<span class="' + className + (image ? ' has-avatar-image' : '') + '" title="' + esc(profile.displayName || username) + '">' + image + '<span class="chat-avatar-fallback">' + esc(avatarInitials(username)) + '</span></span>';
}

function renderConversationAvatar(group, className) {
    if (group?.type === 'private') return renderPersonAvatar(group.peer_username || group.name, className);
    const photoUrl = safeChatAvatarUrl(group?.photo_url || '');
    const image = photoUrl
        ? '<img class="chat-avatar-image" src="' + esc(photoUrl) + '" alt="" loading="lazy" onerror="this.remove();this.parentElement.classList.remove(\'has-avatar-image\')">'
        : '';
    return '<span class="' + className + (image ? ' has-avatar-image' : '') + '">' + image + '<span class="chat-avatar-fallback">👥</span></span>';
}

function replaceAvatarElement(element, markup) {
    if (!element) return;
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    const replacement = holder.firstElementChild;
    if (!replacement) return;
    replacement.id = element.id;
    element.replaceWith(replacement);
}

function setConversationAvatar(element, group) {
    replaceAvatarElement(element, renderConversationAvatar(group, 'topbar-group-icon'));
}

function refreshChatAvatarPreview() {
    const preview = document.getElementById('settingsAvatar');
    if (!preview) return;
    const username = _me?.username || 'Nutzer';
    replaceAvatarElement(preview, renderPersonAvatar(username, 'settings-avatar', {
        avatar_url: document.getElementById('settingsAvatarUrl')?.value || ''
    }));
}

async function uploadChatAvatar() {
    const input = document.getElementById('settingsAvatarFile');
    const hint = document.getElementById('settingsAvatarHint');
    const file = input?.files?.[0];
    if (!file) return;
    const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (!supportedTypes.has(file.type) || file.size > 8 * 1024 * 1024) {
        hint.textContent = 'Bitte JPG, PNG, GIF oder WebP bis maximal 8 MB auswählen.';
        input.value = '';
        return;
    }
    hint.textContent = 'Profilbild wird hochgeladen…';
    try {
        const result = await uploadFile(file);
        document.getElementById('settingsAvatarUrl').value = result.url || '';
        refreshChatAvatarPreview();
        hint.textContent = 'Bild bereit – zum Übernehmen unten speichern.';
    } catch (error) {
        hint.textContent = error?.message || 'Bild konnte nicht hochgeladen werden.';
    } finally {
        input.value = '';
    }
}

function clearChatAvatar() {
    document.getElementById('settingsAvatarUrl').value = '';
    document.getElementById('settingsAvatarHint').textContent = 'Profilbild wird beim Speichern entfernt.';
    refreshChatAvatarPreview();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(secs) { const m=Math.floor(secs/60),s=Math.round(secs%60); return m+':'+String(s).padStart(2,'0'); }
function fmtSize(bytes) { if (bytes<1024) return bytes+'B'; if (bytes<1024*1024) return Math.round(bytes/1024)+'KB'; return (bytes/(1024*1024)).toFixed(1)+'MB'; }
