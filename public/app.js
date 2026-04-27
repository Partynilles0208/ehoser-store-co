const API_BASE = `${window.location.origin}/api`;
let currentUser = null;
let currentProfile = null;
let allApps = [];
let currentCategory = 'all';
let resetRequestId = null;
let resetLookupToken = null;
let resetToken = null;
let resetPollInterval = null;
let pendingReferral = null;
let imageSearchLastQuery = '';
let _lastPersonalizationSearchMiss = '';

// Client-Konfiguration (API Keys sicher vom Backend laden)
window.__ENV__ = { __loaded: false };
fetch('/api/config').then(r => r.json()).then(cfg => {
    window.__ENV__ = { ...cfg, __loaded: true };
    updateGoogleAuthVisibility();
}).catch(() => {
    window.__ENV__ = { __loaded: true };
});

let _googleAuthInitialized = false;
let _pendingReloadSnapshot = null;

try {
    const rawReloadSnapshot = sessionStorage.getItem('pendingReloadSnapshot');
    _pendingReloadSnapshot = rawReloadSnapshot ? JSON.parse(rawReloadSnapshot) : null;
} catch {
    _pendingReloadSnapshot = null;
}

function normalizeUnlockCodeValue(value) {
    return String(value || '').replace(/\s+/g, '');
}

function getActiveAuthUnlockCode() {
    const registerForm = document.getElementById('registerForm');
    const registerVisible = registerForm && registerForm.style.display !== 'none';
    const input = registerVisible
        ? document.getElementById('unlockCode')
        : document.getElementById('loginUnlockCode');
    return normalizeUnlockCodeValue(input?.value || '');
}

function captureReloadSnapshot() {
    const activeSection = document.querySelector('.section.active')?.id || 'mode-select';
    sessionStorage.setItem('pendingReloadSnapshot', JSON.stringify({
        sectionId: activeSection,
        scrollY: window.scrollY || 0
    }));
}

function restoreReloadSnapshot() {
    if (!_pendingReloadSnapshot) return;
    const { sectionId, scrollY } = _pendingReloadSnapshot;
    const targetSection = document.getElementById(sectionId);
    if (targetSection && sectionId !== 'voteScreen') {
        showSection(sectionId);
    }
    requestAnimationFrame(() => {
        window.scrollTo({ top: Number(scrollY) || 0, behavior: 'auto' });
    });
    sessionStorage.removeItem('pendingReloadSnapshot');
    _pendingReloadSnapshot = null;
}

function showRepoUpdateOverlay() {
    return;
}

function dismissRepoUpdate() {
    return;
}

function loadRepoUpdate() {
    captureReloadSnapshot();
    window.location.reload();
}

async function checkRepoVersion() {
    return;
}

function startRepoUpdatePolling() {
    return;
}

async function handleGoogleCredentialResponse(response) {
    const unlockCode = getActiveAuthUnlockCode();
    if (unlockCode !== '020818') {
        showAlert('Google-Anmeldung wird erst mit dem richtigen Zugangscode freigeschaltet.', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idToken: response?.credential,
                unlockCode
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Google-Anmeldung fehlgeschlagen');

        localStorage.setItem('token', data.token);
        currentUser = { id: data.userId, username: data.username, isAdmin: false };
        currentProfile = data.profile || null;
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        showAlert(`Erfolgreich mit Google angemeldet: ${data.username}`, 'success');
    } catch (error) {
        showAlert(error.message || 'Google-Anmeldung fehlgeschlagen', 'error');
    }
}

function initGoogleAuth() {
    if (_googleAuthInitialized) return;
    const clientId = window.__ENV__?.googleClientId;
    const buttonHost = document.getElementById('googleSignInButton');
    if (!clientId || !buttonHost) return;
    if (!window.google?.accounts?.id) {
        // GSI script noch nicht geladen (async), nach kurzer Verzögerung erneut versuchen
        setTimeout(() => { _googleAuthInitialized = false; initGoogleAuth(); }, 500);
        return;
    }

    window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true
    });
    buttonHost.innerHTML = '';
    window.google.accounts.id.renderButton(buttonHost, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: 320
    });
    _googleAuthInitialized = true;
    updateGoogleAuthVisibility();
}

function updateGoogleAuthVisibility() {
    const gate = document.getElementById('googleAuthGate');
    if (!gate) return;
    const codeOk = getActiveAuthUnlockCode() === '020818';
    gate.style.display = codeOk ? 'block' : 'none';
    if (!codeOk) return;

    // Config noch nicht geladen – kurz warten und neu prüfen
    if (!window.__ENV__?.__loaded) {
        setTimeout(updateGoogleAuthVisibility, 300);
        return;
    }

    const clientId = window.__ENV__?.googleClientId;
    const notConfiguredMsg = document.getElementById('googleNotConfiguredMsg');
    if (!clientId) {
        if (notConfiguredMsg) notConfiguredMsg.style.display = 'block';
        return;
    }
    if (notConfiguredMsg) notConfiguredMsg.style.display = 'none';
    initGoogleAuth();
}

function getPersonalization() {
    if (currentProfile?.settings?.personalizationEnabled === false) return null;
    return currentProfile?.settings?.personalization || null;
}

async function refreshCurrentProfile() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok || !data?.profile) return;
        currentProfile = data.profile;
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showLoggedInUI();
    } catch {}
}

async function trackPersonalizationEvent(type, payload) {
    if (currentProfile?.settings?.personalizationEnabled === false) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/personalization/event`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ type, ...(payload || {}) })
        });
        const data = await res.json();
        if (!res.ok || !data?.profile) return;
        currentProfile = data.profile;
        applyProfileSettings();
        showLoggedInUI();
    } catch {}
}

function applyPersonalizationUI() {
    const titleEl = document.getElementById('modeTitle');
    const subtitleEl = document.getElementById('modeSubtitle');
    const bannerEl = document.getElementById('personalizationBanner');
    const searchInput = document.getElementById('searchInput');
    const cardsWrap = document.querySelector('.mode-cards');
    const personalization = getPersonalization();
    const defaultTitle = 'Ehoser – Offizielle Website';
    const defaultSubtitle = 'Willkommen auf der offiziellen Website von Ehoser. Hier findest du exklusive Apps im APK Store, kostenlose Online-Spiele, KI-Tools, den Face-Warp-Editor und vieles mehr – alles an einem Ort, entwickelt von Nils Becker.';

    document.body.dataset.personalizationTone = personalization?.tone || 'neutral';
    document.body.dataset.personalizationLayout = personalization?.layout || 'standard';
    document.body.dataset.personalizationPrimaryMode = personalization?.highlightModes?.[0] || 'default';
    document.body.classList.toggle('personalized-ui', Boolean(personalization));

    if (titleEl) {
        titleEl.textContent = currentUser ? `Ehoser für ${currentUser.username}` : defaultTitle;
    }
    if (subtitleEl) {
        subtitleEl.textContent = personalization?.summary || defaultSubtitle;
    }
    if (bannerEl) {
        if (currentUser && personalization?.heroLine) {
            bannerEl.textContent = `${currentUser.username}: ${personalization.heroLine}`;
            bannerEl.style.display = 'block';
        } else {
            bannerEl.style.display = 'none';
            bannerEl.textContent = '';
        }
    }

    if (searchInput) {
        if (!searchInput.dataset.defaultPlaceholder) {
            searchInput.dataset.defaultPlaceholder = searchInput.getAttribute('placeholder') || '';
        }
        searchInput.setAttribute(
            'placeholder',
            personalization?.simplifySearch
                ? 'Beschreibe kurz, was du suchst - ehoser macht es einfacher'
                : searchInput.dataset.defaultPlaceholder
        );
    }

    if (cardsWrap) {
        const getModeFromCard = (card) => {
            if (card.id === 'psModeCard') return 'ps';
            if (card.id === 'gameCreatorCard') return 'gameCreator';
            const onclick = card.getAttribute('onclick') || '';
            const match = onclick.match(/selectMode\('([^']+)'\)/);
            return match ? match[1] : '';
        };
        const priority = new Map();
        (personalization?.highlightModes || []).forEach((mode, index) => priority.set(mode, index));
        if (personalization?.prioritizePs) priority.set('ps', -1);
        const cards = Array.from(cardsWrap.querySelectorAll('.mode-card'));
        cards.forEach(card => card.classList.remove('mode-card-personalized'));
        cards.sort((a, b) => {
            const pa = priority.has(getModeFromCard(a)) ? priority.get(getModeFromCard(a)) : 999;
            const pb = priority.has(getModeFromCard(b)) ? priority.get(getModeFromCard(b)) : 999;
            if (pa !== pb) return pa - pb;
            return 0;
        });
        cards.forEach(card => {
            const mode = getModeFromCard(card);
            if (priority.has(mode)) card.classList.add('mode-card-personalized');
            cardsWrap.appendChild(card);
        });
    }
}

function switchAuthTab(tab, btn) {
    document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
    if (tab !== 'login') {
        document.getElementById('helpRequestForm').style.display = 'none';
        document.getElementById('resetCompleteForm').style.display = 'none';
    }
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateGoogleAuthVisibility();
}

function toggleResetHelp() {
    const form = document.getElementById('helpRequestForm');
    form.style.display = form.style.display === 'none' ? '' : 'none';
}

function stopResetStatusPolling() {
    clearInterval(resetPollInterval);
    resetPollInterval = null;
}

function startResetStatusPolling() {
    stopResetStatusPolling();
    pollResetStatus();
    resetPollInterval = setInterval(pollResetStatus, 5000);
}

async function handleHelpRequest(event) {
    event.preventDefault();
    const username = document.getElementById('helpUsername').value.trim();

    try {
        const response = await fetch(`${API_BASE}/request-code-reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });

        const data = await response.json();
        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Anfrage fehlgeschlagen'}`, 'error');
            return;
        }

        resetRequestId = data.requestId;
        resetLookupToken = data.lookupToken;
        showAlert('Anfrage gesendet. Admin wurde benachrichtigt.', 'success');
        startResetStatusPolling();
    } catch (err) {
        showAlert('Verbindungsfehler beim Senden der Anfrage.', 'error');
    }
}

async function pollResetStatus() {
    if (!resetRequestId || !resetLookupToken) return;

    try {
        const response = await fetch(`${API_BASE}/code-reset-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: resetRequestId, lookupToken: resetLookupToken })
        });

        const data = await response.json();
        if (!response.ok) return;

        if (data.status === 'approved' && data.resetToken) {
            resetToken = data.resetToken;
            stopResetStatusPolling();
            document.getElementById('helpRequestForm').style.display = 'none';
            document.getElementById('resetCompleteForm').style.display = '';
            showAlert('Anfrage angenommen. Du kannst jetzt einen neuen Login-Code setzen.', 'success');
            return;
        }

        if (data.status === 'rejected') {
            stopResetStatusPolling();
            showAlert('Deine Anfrage wurde vom Admin abgelehnt.', 'error');
        }
    } catch {
        // polling silent
    }
}

async function handleCompleteReset(event) {
    event.preventDefault();

    const newCode = document.getElementById('newLoginCode').value.trim();
    const confirmCode = document.getElementById('confirmLoginCode').value.trim();

    if (!resetRequestId || !resetToken) {
        showAlert('Reset-Sitzung fehlt. Bitte erneut Hilfe anfordern.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/code-reset-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requestId: resetRequestId,
                resetToken,
                newCode,
                confirmCode
            })
        });

        const data = await response.json();
        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Code konnte nicht aktualisiert werden'}`, 'error');
            return;
        }

        document.getElementById('resetCompleteForm').style.display = 'none';
        document.getElementById('helpRequestForm').style.display = 'none';
        document.getElementById('helpRequestForm').reset();
        document.getElementById('resetCompleteForm').reset();
        resetRequestId = null;
        resetLookupToken = null;
        resetToken = null;

        showAlert('Neuer Login-Code gespeichert. Du kannst dich jetzt anmelden.', 'success');
    } catch (err) {
        showAlert('Verbindungsfehler beim Speichern des neuen Codes.', 'error');
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const unlockCode = document.getElementById('loginUnlockCode').value.trim();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword')?.value.trim() || '';
    const loginCode = document.getElementById('loginCode')?.value.trim() || '';

    if (!password && !loginCode) {
        showAlert('Bitte Passwort oder Login-Code eingeben.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                unlockCode,
                password: password || undefined,
                loginCode: loginCode || undefined
            })
        });

        const data = await response.json();

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Anmeldung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        currentProfile = data.profile || null;
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showAlert('Erfolgreich angemeldet!', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        document.getElementById('loginForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. PrÃ¼fe ob der Server lÃ¤uft.', 'error');
    }
}

// ── reCAPTCHA entfernt – Vote-Screen oder direkt starten ─────────────────────
function showCaptcha() {
    applyUpdateFeatures(true);
    startApp();
    startRepoUpdatePolling();
}

// ── Update-Abstimmung ─────────────────────────────────────────────────────────
let _votePollingInterval = null;

function applyUpdateFeatures(unlocked) {
    const cards = document.querySelectorAll('[data-update-feature]');
    cards.forEach(c => { c.style.display = unlocked ? '' : 'none'; });
}

async function loadVoteStatus() {
    try {
        const token = localStorage.getItem('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/vote/status`, { headers });
        const data = await res.json();
        const count = data.count || 0;
        const unlocked = data.unlocked || false;
        const myVote = data.myVote || false;

        const countEl = document.getElementById('voteCountDisplay');
        const bar = document.getElementById('voteProgressBar');
        if (countEl) countEl.textContent = `${count} / 10`;
        if (bar) bar.style.width = `${Math.min(100, count * 10)}%`;

        // Abstimmen-Button je nach Status
        const voteBtn = document.getElementById('voteBtn');
        const voteMsg = document.getElementById('voteMsg');
        if (voteBtn) {
            if (!token) {
                voteBtn.disabled = true;
                voteBtn.style.opacity = '0.5';
                if (voteMsg) voteMsg.textContent = 'Bitte anmelden um abstimmen zu können.';
            } else if (myVote) {
                voteBtn.disabled = true;
                voteBtn.style.opacity = '0.5';
                voteBtn.textContent = '✓ Bereits abgestimmt';
                if (voteMsg) voteMsg.textContent = 'Du hast bereits abgestimmt.';
            } else {
                voteBtn.disabled = false;
                voteBtn.style.opacity = '';
            }
        }

        applyUpdateFeatures(unlocked);
        return { count, unlocked, myVote };
    } catch {
        return { count: 0, unlocked: false, myVote: false };
    }
}

function showVoteScreen() {
    const screen = document.getElementById('voteScreen');
    if (screen) screen.style.display = 'block';
    loadVoteStatus();

    // Polling alle 5s – wenn 10 erreicht: alle Seiten refreshen
    clearInterval(_votePollingInterval);
    _votePollingInterval = setInterval(async () => {
        const status = await loadVoteStatus();
        if (status.unlocked) {
            clearInterval(_votePollingInterval);
        }
    }, 5000);
}

async function castVote() {
    const token = localStorage.getItem('token');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }

    const btn = document.getElementById('voteBtn');
    const msg = document.getElementById('voteMsg');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Abstimmen…'; }

    try {
        const res = await fetch(`${API_BASE}/vote`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) {
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '✓ Bereits abgestimmt'; }
            if (msg) msg.textContent = data.error || 'Fehler.';
            return;
        }
        if (btn) { btn.textContent = '✅ Stimme gezählt!'; btn.style.background = 'linear-gradient(135deg,#1a7a3a,#2dbe6c)'; }
        if (msg) msg.textContent = `${data.count} von 10 Stimmen – danke!`;
        loadVoteStatus();

        if (data.unlocked) {
            if (msg) msg.textContent = '🎉 Update freigeschaltet! Du kannst es jetzt laden.';
        }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = '🗳️ Für Update abstimmen'; }
        if (msg) msg.textContent = 'Netzwerkfehler. Bitte erneut versuchen.';
    }
}

function skipVote() {
    clearInterval(_votePollingInterval);
    const screen = document.getElementById('voteScreen');
    if (screen) screen.style.display = 'none';
    startApp();
}

function startApp() {
    const token = localStorage.getItem('token');
    if (token) {
        verifyToken(token);
        return;
    }
    showSection('mode-select');
    restoreReloadSnapshot();
}

document.addEventListener('DOMContentLoaded', () => {
    // Referral-Code aus URL lesen
    const ref = new URLSearchParams(window.location.search).get('ref');
    pendingReferral = ref || localStorage.getItem('pendingReferralCode') || null;
    if (pendingReferral) {
        localStorage.setItem('pendingReferralCode', pendingReferral);
        const referralInput = document.getElementById('referralCode');
        if (referralInput) referralInput.value = pendingReferral;
    }

    ['unlockCode', 'loginUnlockCode'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', updateGoogleAuthVisibility);
    });
    updateGoogleAuthVisibility();

    // Splash: nur einmal pro Tab-Session
    const splash = document.getElementById('introSplash');
    if (splash) {
        const alreadyShown = sessionStorage.getItem('intro_shown');
        if (alreadyShown) {
            splash.remove();
            document.body.classList.remove('splash-active');
            document.body.style.overflow = '';
            showCaptcha();
        } else {
            // 13.8s: Big Logo erscheint mit Bounce
            const bigLogo = document.getElementById('introBigLogo');
            if (bigLogo) {
                setTimeout(() => {
                    bigLogo.style.opacity = '1';
                    bigLogo.style.transition = 'opacity 0.12s ease, transform 0.5s cubic-bezier(.2,1.4,.3,1)';
                    bigLogo.style.transform = 'scale(1.1)';
                    setTimeout(() => {
                        bigLogo.style.transition = 'transform 0.25s ease-out';
                        bigLogo.style.transform = 'scale(1)';
                    }, 500);
                }, 13800);
            }

            // 15.6s: Finaler Blitz ist am Peak → Splash weg, Seite erscheint sofort
            setTimeout(() => {
                splash.remove();
                document.body.classList.remove('splash-active');
                document.body.style.overflow = '';
                sessionStorage.setItem('intro_shown', '1');
                // Weißes Body-Overlay für den Blitz-Übergang
                const bodyFlash = document.createElement('div');
                bodyFlash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99998;pointer-events:none;transition:opacity 0.3s ease;';
                document.body.appendChild(bodyFlash);
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    bodyFlash.style.opacity = '0';
                    setTimeout(() => bodyFlash.remove(), 350);
                }));
                showCaptcha();
            }, 15600);
        }
    } else {
        showCaptcha();
    }
});

async function verifyToken(token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // Vercel cold start kann ~10s dauern
    try {
        const response = await fetch(`${API_BASE}/verify-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.status === 401) {
            // Token abgelaufen/ungÃ¼ltig â€“ Token NICHT lÃ¶schen!
            // User kann sich erneut anmelden â†’ Token wird dann Ã¼berschrieben
            localStorage.removeItem('proStatus');
            showSection('mode-select');
            return;
        }

        if (!response.ok) {
            // Server-Fehler: Token behalten, trotzdem UI laden
            showSection('mode-select');
            return;
        }

        const data = await response.json();
        if (data.token) localStorage.setItem('token', data.token);
        currentUser = data.user;
        currentProfile = data.profile || null;
        // ðŸ”¥ Pro-Status in localStorage speichern fÃ¼r FaceWarp/Chat
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
    } catch (err) {
        // Netzwerkfehler: Token NICHT lÃ¶schen, Seite trotzdem zeigen
        showSection('mode-select');
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const unlockCode = document.getElementById('unlockCode').value.trim();
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('registerPassword').value.trim();
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value.trim();

    if (!password || password.length < 6) {
        showAlert('Passwort muss mindestens 6 Zeichen lang sein.', 'error');
        return;
    }
    if (password !== passwordConfirm) {
        showAlert('PasswÃ¶rter stimmen nicht Ã¼berein.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unlockCode, username, email, password, referralCode: pendingReferral })
        });

        const data = await response.json();

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Registrierung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        currentProfile = data.profile || null;
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        window.alert(`Dein Login-Code: ${data.loginCode}\nDiesen Code sicher speichern. Du kannst ihn als Backup zum Anmelden nutzen.`);
        if (data.referralApplied) {
            showAlert('Referral erfolgreich: Ihr habt beide 2 Tage Pro erhalten.', 'success');
            localStorage.removeItem('pendingReferralCode');
            pendingReferral = null;
        }
        showAlert('Willkommen bei ehoser.', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        document.getElementById('registerForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. PrÃ¼fe ob der Server lÃ¤uft.', 'error');
    }
}

function showLoggedInUI() {
    const navLinks = document.getElementById('navLinks');
    const adminLabel = currentUser?.isAdmin ? 'Admin' : 'App hochladen';
    const plan = currentProfile?.isPro ? 'PRO' : 'Gratis';
    const psBadge = currentProfile?.ps_account ? '<span style="background:rgba(77,159,255,0.2);color:#4d9fff;border:1px solid rgba(77,159,255,0.4);border-radius:6px;font-size:0.75em;font-weight:700;padding:2px 7px;letter-spacing:.04em;">PS</span>' : '';
    const personalization = getPersonalization();
    const helloText = personalization?.heroLine
        ? `Hallo, ${escapeHtml(currentUser.username)}. ${escapeHtml(personalization.heroLine.slice(0, 72))}`
        : `Hallo, ${escapeHtml(currentUser.username)}.`;
    navLinks.innerHTML = `
        <a href="#" onclick="showSection('store')" class="nav-link">Store</a>
        <a href="#" onclick="showSection('my-apps')" class="nav-link">Meine Apps</a>
        <a href="admin.html" class="nav-link">${adminLabel}</a>
        <button onclick="openSettingsModal()" class="btn-small" style="width:auto;padding:8px 12px;">Einstellungen</button>
        <span class="plan-badge ${currentProfile?.isPro ? 'pro' : ''}">${plan}</span>
        <span class="hello-user">${psBadge} ${helloText}</span>
        <button onclick="logout()" class="logout-btn">Abmelden</button>
    `;

    // PS-Hilfe-Karte zeigen/verstecken
    const psCard = document.getElementById('psModeCard');
    if (psCard) psCard.style.display = currentProfile?.ps_account ? '' : 'none';

    // Spiel-erstellen-Karte zeigen/verstecken (nur Pro)
    const gameCard = document.getElementById('gameCreatorCard');
    if (gameCard) gameCard.style.display = currentProfile?.isPro ? '' : 'none';

    applyPersonalizationUI();
}

async function loadApps() {
    try {
        const response = await fetch(`${API_BASE}/apps`);
        const apps = await response.json();
        allApps = Array.isArray(apps) ? apps : [];
        displayApps(allApps, { searchText: '', category: 'all' });
    } catch (err) {
        showAlert('Apps konnten nicht geladen werden.', 'error');
    }
}

function displayApps(apps, meta) {
    const appsList = document.getElementById('appsList');
    const searchText = meta?.searchText || '';
    const personalization = getPersonalization();

    if (!apps.length) {
        appsList.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <h3>Keine Apps gefunden</h3>
                <p>${personalization?.simplifySearch ? 'Ich habe die Suche bereits vereinfacht. Versuche einen kuerzeren Begriff oder lass dir von ehoser KI etwas Passendes vorschlagen.' : 'Versuche eine andere Suche oder Kategorie.'}</p>
                ${searchText ? `<button class="btn-small" onclick="selectMode('ki')" style="margin-top:12px;">KI nach ${escapeHtml(searchText)} fragen</button>` : ''}
            </div>
        `;
        return;
    }

    appsList.innerHTML = apps.map((app) => `
        <article class="app-card">
            <div class="app-icon-wrap">${renderIcon(app.icon_url, app.name)}</div>
            <h3 class="app-name">${escapeHtml(app.name)}</h3>
            <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
            <p class="app-version">Version ${escapeHtml(app.version || '1.0.0')}</p>
            <div class="app-actions">
                <button class="btn-small btn-install" onclick="installApp(${app.id}, this)">Installieren</button>
                <button class="btn-small btn-info" onclick="showAppDetails(${app.id})">Details</button>
            </div>
        </article>
    `).join('');
}

function renderIcon(iconUrl, appName) {
    if (!iconUrl) {
        return '<span class="emoji-icon">ðŸ“±</span>';
    }

    const looksLikeImage = iconUrl.startsWith('/uploads/') || /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(iconUrl) || iconUrl.startsWith('http');
    if (looksLikeImage) {
        const safeUrl = escapeAttribute(iconUrl);
        const alt = escapeAttribute(appName || 'App Icon');
        return `<img class="app-icon-img" src="${safeUrl}" alt="${alt}">`;
    }

    return `<span class="emoji-icon">${escapeHtml(iconUrl)}</span>`;
}

function filterApps() {
    const searchText = document.getElementById('searchInput').value.trim().toLowerCase();
    applyFilters(searchText, currentCategory);
}

function filterByCategory(category, evt) {
    currentCategory = category;
    document.querySelectorAll('.filter-btn').forEach((btn) => btn.classList.remove('active'));

    const clickedButton = evt?.currentTarget || event?.currentTarget;
    if (clickedButton) {
        clickedButton.classList.add('active');
    }

    const searchText = document.getElementById('searchInput').value.trim().toLowerCase();
    applyFilters(searchText, category);
}

function applyFilters(searchText, category) {
    let filtered = [...allApps];

    if (searchText) {
        filtered = filtered.filter((app) =>
            (app.name || '').toLowerCase().includes(searchText) ||
            (app.description || '').toLowerCase().includes(searchText)
        );
    }

    if (category !== 'all') {
        filtered = filtered.filter((app) => app.category === category);
    }

    if (!filtered.length && searchText && currentUser) {
        const missKey = `${category}:${searchText}`;
        if (_lastPersonalizationSearchMiss !== missKey) {
            _lastPersonalizationSearchMiss = missKey;
            trackPersonalizationEvent('search-empty', { query: searchText, category });
        }
    } else if (filtered.length) {
        _lastPersonalizationSearchMiss = '';
    }

    displayApps(filtered, { searchText, category });
}

async function installApp(appId, button) {
    if (!currentUser) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    const app = allApps.find((item) => item.id === appId);
    const isPro = Boolean(currentProfile?.isPro);
    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`${API_BASE}/install`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ appId })
        });

        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Installation fehlgeschlagen.', 'error');
            return;
        }

        if (button) {
            button.textContent = 'Installiert';
            button.classList.add('btn-installed');
            button.disabled = true;
        }

        if (!isPro) {
            showAlert('Gratis-Modus: Download startet in 5 Sekunden. Mit PRO sofort.', 'success');
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        // APK direkt herunterladen
        if (app && app.download_url) {
            const a = document.createElement('a');
            a.href = app.download_url;
            a.download = `${app.name || 'app'}.apk`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        showAlert('Download gestartet!', 'success');
    } catch (err) {
        showAlert('Installationsfehler.', 'error');
    }
}

function showAppDetails(appId) {
    const app = allApps.find((item) => item.id === appId);
    if (!app) {
        return;
    }

    const modal = document.getElementById('appModal');
    const modalBody = document.getElementById('modalBody');

    modalBody.innerHTML = `
        <div class="modal-body">
            <div class="app-icon app-icon-large">${renderIcon(app.icon_url, app.name)}</div>
            <h3>${escapeHtml(app.name)}</h3>
            <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
            <p>${escapeHtml(app.description || 'Keine Beschreibung')}</p>
            <p><strong>Version:</strong> ${escapeHtml(app.version || '1.0.0')}</p>
            ${app.source_url ? `<p><strong>Quelle:</strong> <a href="${escapeAttribute(app.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(app.source_url)}</a></p>` : ''}
            ${app.download_url ? `<p><strong>Datei:</strong> <a href="${escapeAttribute(app.download_url)}" target="_blank" rel="noopener noreferrer">APK herunterladen</a></p>` : ''}
            <button class="btn-primary" onclick="installApp(${app.id}); closeModal();">Jetzt installieren</button>
        </div>
    `;

    modal.classList.add('show');
}

function closeModal() {
    document.getElementById('appModal').classList.remove('show');
}

async function loadMyApps() {
    const token = localStorage.getItem('token');

    if (!token) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/my-apps`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) {
            showAlert('Meine Apps konnten nicht geladen werden.', 'error');
            return;
        }

        const apps = await response.json();
        const myAppsList = document.getElementById('myAppsList');

        if (!apps.length) {
            myAppsList.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <h3>Noch keine Apps installiert</h3>
                    <p>Gehe in den Store und installiere deine ersten Apps.</p>
                </div>
            `;
            return;
        }

        myAppsList.innerHTML = apps.map((app) => `
            <article class="app-card">
                <div class="app-icon-wrap">${renderIcon(app.icon_url, app.name)}</div>
                <h3 class="app-name">${escapeHtml(app.name)}</h3>
                <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
                <p class="app-version">Version ${escapeHtml(app.version || '1.0.0')}</p>
                <div class="app-actions">
                    <button class="btn-small btn-installed" disabled>Installiert</button>
                    <button class="btn-small btn-info" onclick="showAppDetails(${app.id})">Details</button>
                </div>
            </article>
        `).join('');
    } catch (err) {
        showAlert('Meine Apps konnten nicht geladen werden.', 'error');
    }
}

function showSection(sectionId) {
    document.querySelectorAll('.section').forEach((section) => {
        section.classList.remove('active');
    });

    const section = document.getElementById(sectionId);
    if (!section) {
        return;
    }

    section.classList.add('active');
    if (sectionId === 'auth') {
        loadUnlockCode();
    }
    if (sectionId === 'my-apps') {
        loadMyApps();
    }
    if (sectionId === 'games') {
        if (!gamesAllLoaded.length) loadGames();
    }
}

let _unlockCode = null;

async function loadUnlockCode() {
    if (_unlockCode) {
        document.getElementById('unlockCodeDisplay').textContent = _unlockCode;
        updateGoogleAuthVisibility();
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/unlock-code`);
        const data = await res.json();
        _unlockCode = data.code;
        document.getElementById('unlockCodeDisplay').textContent = _unlockCode;
        updateGoogleAuthVisibility();
    } catch {
        document.getElementById('unlockCodeDisplay').textContent = 'â€“';
    }
}

async function copyUnlockCode() {
    if (!_unlockCode) return;
    try {
        await navigator.clipboard.writeText(_unlockCode);
    } catch {
        // Fallback
        const el = document.getElementById('unlockCodeDisplay');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    const btn = document.querySelector('.unlock-code-copy');
    btn.textContent = 'âœ“ Kopiert!';
    btn.classList.add('copied');
    setTimeout(() => {
        btn.textContent = 'ðŸ“‹ Kopieren';
        btn.classList.remove('copied');
    }, 2000);
}

function selectMode(mode) {
    if (mode === 'store') {
        showSection('mode-select');
    } else if (mode === 'games') {
        showSection('games');
    } else if (mode === 'images') {
        showSection('images');
        if (!imageSearchLastQuery) {
            document.getElementById('imageSearchStatus').textContent = 'Gib ein Suchwort ein und starte die Suche.';
        }
    } else if (mode === 'weather') {
        showSection('weather');
        document.getElementById('weatherStatus').textContent = '';
        document.getElementById('weatherResult').innerHTML = '';
        setTimeout(() => document.getElementById('weatherCityInput')?.focus(), 50);
    } else if (mode === 'map') {
        showSection('map');
        setTimeout(initMap, 50); // kurz warten bis section sichtbar ist
    } else if (mode === 'youtube') {
        showSection('youtube');
        setTimeout(() => document.getElementById('ytSearchInput')?.focus(), 50);
    } else if (mode === 'news') {
        showSection('news');
        newsLoad('top');
    } else if (mode === 'ki') {
        // Registrierung nÃ¶tig
        const token = localStorage.getItem('token');
        if (!token) {
            showAlert('Bitte zuerst anmelden, um ehoser KI zu nutzen.', 'error');
            showSection('auth');
            return;
        }
        showSection('ki');
        // Name bereits bekannt â†’ direkt Chat Ã¶ffnen, sonst Modal zeigen
        if (sessionStorage.getItem('kiUserName')) {
            showKIChat();
        } else {
            document.getElementById('kiNameModal').style.display = 'flex';
            document.getElementById('kiChatWrapper').style.display = 'none';
            setTimeout(() => document.getElementById('kiNameInput')?.focus(), 50);
        }
    } else if (mode === 'facewarp') {
        openFacewarpModeModal();
    } else if (mode === 'chat') {
        const token = localStorage.getItem('token');
        if (!token) {
            showAlert('Bitte zuerst anmelden, um den Chat zu nutzen.', 'error');
            showSection('auth');
            return;
        }
        showSection('chat');
        initChatSection();
    } else if (mode === 'qr') {
        showSection('qr');
        setTimeout(() => document.getElementById('qrInput')?.focus(), 50);
    } else if (mode === 'calc') {
        showSection('calc');
        _calcExpr = '';
        _calcRender();
    } else if (mode === 'notes') {
        showSection('notes');
        _notesLoad();
        _notesRender();
    } else if (mode === 'pwd') {
        showSection('pwd');
        pwdGenerate();
    } else if (mode === 'palette') {
        showSection('palette');
        paletteGenerate();
    } else if (mode === 'json') {
        showSection('json');
    } else if (mode === 'stopwatch') {
        showSection('stopwatch');
    } else if (mode === 'encode') {
        showSection('encode');
    } else if (mode === 'units') {
        showSection('units');
        unitsUpdateCat();
    } else if (mode === 'rng') {
        showSection('rng');
    } else if (mode === 'tone') {
        showSection('tone');
    } else if (mode === 'draw') {
        showSection('draw');
        drawInit();
    } else if (mode === 'habits') {
        showSection('habits');
        habitsRender();
    } else if (mode === 'texttools') {
        showSection('texttools');
    } else if (mode === 'gradient') {
        showSection('gradient');
        gradUpdate();
    } else if (mode === 'sandbox') {
        showSection('sandbox');
    } else if (mode === 'regex') {
        showSection('regex');
    } else if (mode === 'wheel') {
        showSection('wheel');
        wheelDraw();
    } else if (mode === 'hash') {
        showSection('hash');
    } else if (mode === 'typing') {
        showSection('typing');
        typingReset();
    } else if (mode === 'camera') {
        showSection('camera');
        cameraStart();
    } else if (mode === 'countdown') {
        showSection('countdown');
    } else if (mode === 'metronome') {
        showSection('metronome');
        metroInit();
    } else if (mode === 'snake') {
        showSection('snake'); initSnake();
    } else if (mode === 'tictactoe') {
        showSection('tictactoe'); initTictactoe();
    } else if (mode === 'memory2') {
        showSection('memory2'); initMemory2();
    } else if (mode === 'bmi') {
        showSection('bmi'); initBmi();
    } else if (mode === 'tip') {
        showSection('tip'); initTip();
    } else if (mode === 'morse') {
        showSection('morse'); initMorse();
    } else if (mode === 'caesar') {
        showSection('caesar'); initCaesar();
    } else if (mode === 'uuid') {
        showSection('uuid'); initUuid();
    } else if (mode === 'boxshadow') {
        showSection('boxshadow'); initBoxshadow();
    } else if (mode === 'httpstatus') {
        showSection('httpstatus'); initHttpstatus();
    } else if (mode === 'pomodoro') {
        showSection('pomodoro'); initPomodoro();
    } else if (mode === 'kanban') {
        showSection('kanban'); initKanban();
    } else if (mode === 'eightball') {
        showSection('eightball'); initEightball();
    } else if (mode === 'jokegen') {
        showSection('jokegen'); initJokegen();
    } else if (mode === 'breathe') {
        showSection('breathe'); initBreathe();
    } else {
        showSection('mode-select');
    }
}



// WMO Wetter-Code â†’ Emoji + Beschreibung (Open-Meteo)
function weatherCodeInfo(code) {
    const map = {
        0:  ['â˜€ï¸', 'Klarer Himmel'],
        1:  ['ðŸŒ¤ï¸', 'Ãœberwiegend klar'],
        2:  ['â›…', 'Teilweise bewÃ¶lkt'],
        3:  ['â˜ï¸', 'Bedeckt'],
        45: ['ðŸŒ«ï¸', 'Nebel'],
        48: ['ðŸŒ«ï¸', 'Gefrierender Nebel'],
        51: ['ðŸŒ¦ï¸', 'Leichter Nieselregen'],
        53: ['ðŸŒ¦ï¸', 'Nieselregen'],
        55: ['ðŸŒ§ï¸', 'Starker Nieselregen'],
        61: ['ðŸŒ§ï¸', 'Leichter Regen'],
        63: ['ðŸŒ§ï¸', 'Regen'],
        65: ['ðŸŒ§ï¸', 'Starker Regen'],
        71: ['ðŸŒ¨ï¸', 'Leichter Schneefall'],
        73: ['ðŸŒ¨ï¸', 'Schneefall'],
        75: ['â„ï¸', 'Starker Schneefall'],
        77: ['ðŸŒ¨ï¸', 'SchneekÃ¶rner'],
        80: ['ðŸŒ¦ï¸', 'Leichte Schauer'],
        81: ['ðŸŒ§ï¸', 'Schauer'],
        82: ['â›ˆï¸', 'Starke Schauer'],
        85: ['ðŸŒ¨ï¸', 'Schneeschauer'],
        86: ['â„ï¸', 'Starke Schneeschauer'],
        95: ['â›ˆï¸', 'Gewitter'],
        96: ['â›ˆï¸', 'Gewitter mit Hagel'],
        99: ['â›ˆï¸', 'Gewitter mit starkem Hagel'],
    };
    return map[code] || ['ðŸŒ¡ï¸', `Wetter-Code ${code}`];
}

async function runWeatherSearch() {
    const input = document.getElementById('weatherCityInput');
    const status = document.getElementById('weatherStatus');
    const result = document.getElementById('weatherResult');
    const city = (input?.value || '').trim();

    if (!city) {
        status.textContent = 'Bitte einen Ort eingeben.';
        return;
    }

    status.textContent = 'Suche Ortâ€¦';
    result.innerHTML = '';

    try {
        // 1. Geocoding (kein API Key nÃ¶tig)
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de&format=json`);
        const geoData = await geoRes.json();

        if (!geoData.results?.length) {
            status.textContent = `Ort â€ž${city}" nicht gefunden.`;
            return;
        }

        const { latitude, longitude, name, country, admin1 } = geoData.results[0];
        status.textContent = 'Lade Wetterdatenâ€¦';

        // 2. Wetterdaten (kein API Key nÃ¶tig)
        const weatherRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
            `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,visibility` +
            `&wind_speed_unit=kmh&timezone=auto`
        );
        const weatherData = await weatherRes.json();
        const cur = weatherData.current;

        status.textContent = '';

        const temp      = Math.round(cur.temperature_2m);
        const feels     = Math.round(cur.apparent_temperature);
        const humidity  = cur.relative_humidity_2m;
        const wind      = Math.round(cur.wind_speed_10m);
        const visKm     = cur.visibility != null ? `${Math.round(cur.visibility / 1000)} km` : 'â€“';
        const [icon, desc] = weatherCodeInfo(cur.weather_code);
        const location  = [name, admin1, country].filter(Boolean).join(', ');

        result.innerHTML = `
            <div class="weather-card">
                <div class="weather-card-city">${escapeHtml(name)}</div>
                <div class="weather-card-country">${escapeHtml([admin1, country].filter(Boolean).join(', '))}</div>
                <div class="weather-card-icon" style="font-size:5rem;line-height:1">${icon}</div>
                <div class="weather-card-desc">${escapeHtml(desc)}</div>
                <div class="weather-card-temp">${temp}Â°C</div>
                <div class="weather-card-feels">GefÃ¼hlt wie ${feels}Â°C</div>
                <div class="weather-card-stats">
                    <div class="weather-stat">
                        <span class="weather-stat-label">ðŸ’§ Luftfeucht.</span>
                        <span class="weather-stat-value">${humidity}%</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">ðŸ’¨ Wind</span>
                        <span class="weather-stat-value">${wind} km/h</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">ðŸ‘ï¸ Sichtweite</span>
                        <span class="weather-stat-value">${visKm}</span>
                    </div>
                </div>
            </div>`;
    } catch (err) {
        status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.';
    }
}

// â”€â”€â”€ Karte (Leaflet + OpenStreetMap + Nominatim) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _map = null;
let _mapNormalLayer = null;
let _mapSatLayer = null;
let _mapCurrentLayer = 'normal';
let _mapSearchTimer = null;

function initMap() {
    if (_map) {
        _map.invalidateSize();
        return;
    }
    _map = window.L?.map('mapContainer', { zoomControl: true, attributionControl: true })
        .setView([51.1657, 10.4515], 6);
    if (!_map) return;

    _mapNormalLayer = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'Â© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    });
    _mapSatLayer = window.L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles Â© Esri',
        maxZoom: 19
    });
    _mapNormalLayer.addTo(_map);

    // Dropdown schlieÃŸen bei Klick auf Karte
    _map.on('click', closeMapDropdown);
}

function setMapLayer(type) {
    if (!_map) return;
    if (type === 'satellite' && _mapCurrentLayer !== 'satellite') {
        _map.removeLayer(_mapNormalLayer);
        _mapSatLayer.addTo(_map);
        _mapCurrentLayer = 'satellite';
        document.getElementById('mapLayerNormalBtn')?.classList.remove('active');
        document.getElementById('mapLayerSatBtn')?.classList.add('active');
    } else if (type === 'normal' && _mapCurrentLayer !== 'normal') {
        _map.removeLayer(_mapSatLayer);
        _mapNormalLayer.addTo(_map);
        _mapCurrentLayer = 'normal';
        document.getElementById('mapLayerSatBtn')?.classList.remove('active');
        document.getElementById('mapLayerNormalBtn')?.classList.add('active');
    }
}

function onMapSearchInput() {
    const val = document.getElementById('mapSearchInput')?.value.trim() || '';
    const dropdown = document.getElementById('mapSearchDropdown');
    clearTimeout(_mapSearchTimer);

    if (val.length < 2) {
        closeMapDropdown();
        return;
    }

    _mapSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=7&addressdetails=1&accept-language=de`,
                { headers: { 'Accept': 'application/json' } }
            );
            const results = await res.json();
            if (!dropdown) return;

            if (!results.length) {
                dropdown.innerHTML = '<div class="map-search-item map-search-empty">Kein Ergebnis gefunden</div>';
                dropdown.style.display = 'block';
                return;
            }

            dropdown.innerHTML = '';
            results.forEach(r => {
                const item = document.createElement('div');
                item.className = 'map-search-item';
                item.textContent = r.display_name;
                item.dataset.lat = r.lat;
                item.dataset.lon = r.lon;
                item.dataset.name = r.display_name;
                item.addEventListener('click', () => goToMapResult(item.dataset.lat, item.dataset.lon, item.dataset.name));
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        } catch {
            closeMapDropdown();
        }
    }, 280);
}

function closeMapDropdown() {
    const d = document.getElementById('mapSearchDropdown');
    if (d) { d.innerHTML = ''; d.style.display = 'none'; }
}

function goToMapResult(lat, lon, name) {
    if (!_map) return;
    _map.setView([parseFloat(lat), parseFloat(lon)], 14);
    closeMapDropdown();
    const input = document.getElementById('mapSearchInput');
    if (input) input.value = name.split(',')[0].trim();
}

// Dropdown schlieÃŸen bei Klick auÃŸerhalb
document.addEventListener('click', (e) => {
    const wrap = document.getElementById('mapSearchInput')?.closest('.map-search-wrap');
    if (wrap && !wrap.contains(e.target)) closeMapDropdown();
});

// --- Nachrichten (NewsAPI via Backend-Proxy) ---
let _newsCat = 'top';

async function newsLoad(cat) {
    _newsCat = cat || _newsCat;
    const tabMap = { top:'Top', technology:'Tech', science:'Sci', business:'Biz', sports:'Sport', entertainment:'Ent', health:'Health' };
    Object.keys(tabMap).forEach(c => {
        document.getElementById('newsTab' + tabMap[c])?.classList.toggle('active', c === _newsCat);
    });
    const status = document.getElementById('newsStatus');
    const grid   = document.getElementById('newsGrid');
    if (status) status.textContent = 'Nachrichten werden geladen...';
    if (grid)   grid.innerHTML = '';
    try {
        const res  = await fetch(`/api/news?cat=${encodeURIComponent(_newsCat)}`);
        if (!res.ok) { const err = await res.json().catch(()=>({})); if (status) status.textContent = 'Fehler: ' + (err.error || res.statusText); return; }
        const data = await res.json();
        if (!data.articles?.length) { if (status) status.textContent = 'Keine Artikel gefunden.'; return; }
        if (status) status.textContent = '';
        if (grid)   grid.innerHTML = data.articles.map(newsCard).join('');
    } catch (e) { if (status) status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.'; }
}

async function newsSearch() {
    const q = document.getElementById('newsSearchInput')?.value.trim();
    if (!q) return newsLoad(_newsCat);
    const tabMap = { top:'Top', technology:'Tech', science:'Sci', business:'Biz', sports:'Sport', entertainment:'Ent', health:'Health' };
    Object.keys(tabMap).forEach(c => document.getElementById('newsTab' + tabMap[c])?.classList.remove('active'));
    const status = document.getElementById('newsStatus');
    const grid   = document.getElementById('newsGrid');
    if (status) status.textContent = 'Suche laeuft...';
    if (grid)   grid.innerHTML = '';
    try {
        const res  = await fetch(`/api/news?q=${encodeURIComponent(q)}`);
        if (!res.ok) { const err = await res.json().catch(()=>({})); if (status) status.textContent = 'Fehler: ' + (err.error || res.statusText); return; }
        const data = await res.json();
        if (!data.articles?.length) { if (status) status.textContent = 'Keine Artikel gefunden.'; return; }
        if (status) status.textContent = '';
        if (grid)   grid.innerHTML = data.articles.map(newsCard).join('');
    } catch (e) { if (status) status.textContent = 'Verbindungsfehler.'; }
}

function newsSetCat(cat) {
    const inp = document.getElementById('newsSearchInput');
    if (inp) inp.value = '';
    newsLoad(cat);
}

function newsCard(a) {
    const title = escapeHtml(a.title || 'Kein Titel');
    const desc  = escapeHtml((a.description || '').slice(0, 130)) + (a.description && a.description.length > 130 ? '...' : '');
    const src   = escapeHtml(a.source?.name || '');
    const img   = a.urlToImage || '';
    const url   = a.url || '#';
    const date  = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString('de-DE', { day:'2-digit', month:'short', year:'numeric' }) : '';
    return `
        <a class="news-card" href="${url}" target="_blank" rel="noopener noreferrer">
            ${img ? `<div class="news-thumb" style="background-image:url('${img}')"></div>` : '<div class="news-thumb news-thumb-empty">newspaper</div>'}
            <div class="news-card-body">
                <div class="news-card-meta"><span class="news-source">${src}</span>${date ? `<span class="news-date">${date}</span>` : ''}</div>
                <div class="news-card-title">${title}</div>
                <div class="news-card-desc">${desc}</div>
            </div>
        </a>`;
}

// â”€â”€â”€ YouTube (YouTube Data API v3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const YT_API_KEY = window.__ENV__?.YT_API_KEY || '';
let _ytType = 'video';
let _ytNextPageToken = null;
let _ytPrevPageToken = null;
let _ytLastQuery = '';

function setYTType(type) {
    _ytType = type;
    ['video', 'playlist', 'channel'].forEach(t => {
        const btn = document.getElementById('ytTab' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === type);
    });
    if (_ytLastQuery) runYTSearch();
}

async function runYTSearch(pageToken) {
    const query = document.getElementById('ytSearchInput')?.value.trim();
    if (!query) return;
    _ytLastQuery = query;

    const status = document.getElementById('ytStatus');
    const results = document.getElementById('ytResults');
    const pagination = document.getElementById('ytPagination');
    if (status) status.textContent = 'Suche lÃ¤uftâ€¦';
    if (results) results.innerHTML = '';
    if (pagination) pagination.innerHTML = '';
    closeYTPlayer();

    try {
        let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${_ytType}&maxResults=12&key=${YT_API_KEY}&safeSearch=moderate`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            status.textContent = 'Fehler: ' + (err?.error?.message || res.statusText);
            return;
        }
        const data = await res.json();
        _ytNextPageToken = data.nextPageToken || null;
        _ytPrevPageToken = data.prevPageToken || null;

        if (!data.items?.length) {
            status.textContent = 'Keine Ergebnisse gefunden.';
            return;
        }

        status.textContent = '';
        if (results) results.innerHTML = data.items.map(item => buildYTCard(item)).join('');

        // Pagination
        if (pagination && (_ytPrevPageToken || _ytNextPageToken)) {
            pagination.innerHTML = `
                ${_ytPrevPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytPrevPageToken}')">â† ZurÃ¼ck</button>` : ''}
                ${_ytNextPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytNextPageToken}')">Weiter â†’</button>` : ''}
            `;
        }

        // Scroll to results
        document.getElementById('ytResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        if (status) status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.';
    }
}

function buildYTCard(item) {
    const kind = item.id.kind; // youtube#video, youtube#playlist, youtube#channel
    const thumb = item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '';
    const title = escapeHtml(item.snippet.title);
    const sub = escapeHtml(item.snippet.channelTitle || item.snippet.description || '');

    let id, onclickAttr, badge, playOverlay;

    if (kind === 'youtube#video') {
        id = item.id.videoId;
        onclickAttr = `openYTPlayer('${id}', this.querySelector('.yt-card-title').textContent, 'video')`;
        badge = 'â–¶ Video';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">â–¶</div></div>`;
    } else if (kind === 'youtube#playlist') {
        id = item.id.playlistId;
        onclickAttr = `openYTPlayer('${id}', this.querySelector('.yt-card-title').textContent, 'playlist')`;
        badge = 'ðŸ“‹ Playlist';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">â–¶</div></div>`;
    } else {
        id = item.id.channelId;
        onclickAttr = `window.open('https://www.youtube.com/channel/${id}','_blank')`;
        badge = 'ðŸ“º Kanal';
        playOverlay = '';
    }

    return `
        <div class="yt-card" onclick="${onclickAttr}">
            <div class="yt-thumb-wrap">
                ${thumb ? `<img class="yt-thumb" src="${thumb}" alt="" loading="lazy">` : ''}
                ${playOverlay}
            </div>
            <div class="yt-card-body">
                <div class="yt-card-title">${title}</div>
                <div class="yt-card-sub">${sub}</div>
                <span class="yt-card-type-badge">${badge}</span>
            </div>
        </div>`;
}

function openYTPlayer(id, title, type) {
    const wrap = document.getElementById('ytPlayerWrap');
    const iframe = document.getElementById('ytIframe');
    const titleEl = document.getElementById('ytPlayerTitle');
    if (!wrap || !iframe) return;

    let src;
    if (type === 'playlist') {
        src = `https://www.youtube-nocookie.com/embed/videoseries?list=${id}&autoplay=1`;
    } else {
        src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    }

    iframe.src = src;
    if (titleEl) titleEl.textContent = title;
    wrap.style.display = 'block';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeYTPlayer() {
    const wrap = document.getElementById('ytPlayerWrap');
    const iframe = document.getElementById('ytIframe');
    if (iframe) iframe.src = '';
    if (wrap) wrap.style.display = 'none';
}

// â”€â”€â”€ KI Chat (Groq â€“ Llama 3.3 70B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// API Key liegt serverseitig in GROQ_API_KEY (Vercel Environment Variable)
let _kiHistory = []; // { role: 'user'|'assistant'|'system', content: string }
let _kiAttachment = null; // { type: 'image'|'text', data: string, name: string }

const KI_SYSTEM_PROMPT = `Du bist ehoser KI, ein freundlicher und sympathischer KI-Assistent, der exklusiv auf den Servern von ehoser lÃ¤uft. ehoser ist eine private Plattform mit APK Store, Spielen, Chat und weiteren Features.
Deine PersÃ¶nlichkeit ist locker, nett und ein kleines bisschen charmant â€“ aber nicht Ã¼bertrieben. Keine Kosenamen wie "Schatz" oder "SÃ¼ÃŸe". Sprich den Nutzer normal aber herzlich an.
Wenn du den Nutzer persÃ¶nlich ansprechen mÃ¶chtest, schreibe ausschlieÃŸlich [name] anstelle des echten Namens (zum Beispiel: "Hey [name], wie kann ich helfen?"). Verwende niemals den echten Namen direkt.
Antworte IMMER ausschlieÃŸlich auf Deutsch, egal in welcher Sprache der Nutzer schreibt. Keine Ausnahmen.
Halte deine Antworten kurz und knapp â€“ maximal 3-4 SÃ¤tze.
Du kannst Bilder generieren! Wenn der Nutzer ein Bild moechte, antworte mit: BILD_GENERIEREN: [englischer Bildprompt]. Dieser Befehl wird automatisch erkannt und ein Bild erstellt.
Du kannst auch Videos generieren! Wenn der Nutzer ein Video moechte, antworte mit: VIDEO_GENERIEREN: [englischer Videoprompt]. Dieser Befehl wird automatisch erkannt und ein Video erstellt.`;

function startKIWithName() {
    const input = document.getElementById('kiNameInput');
    const name = (input?.value || '').trim();
    if (!name) {
        input?.focus();
        return;
    }
    sessionStorage.setItem('kiUserName', name);
    showKIChat();
}

function showKIChat() {
    const name = sessionStorage.getItem('kiUserName') || 'Nutzer';
    document.getElementById('kiNameModal').style.display = 'none';
    document.getElementById('kiChatWrapper').style.display = 'flex';

    // Anhang-Button nur fÃ¼r PRO sichtbar
    const attachBtn = document.getElementById('kiAttachBtn');
    if (attachBtn) attachBtn.style.display = localStorage.getItem('proStatus') === '1' ? 'flex' : 'none';

    // Nur beim ersten Mal initialisieren
    if (_kiHistory.length === 0) {
        _kiHistory = [{ role: 'system', content: KI_SYSTEM_PROMPT }];
        const greeting = kiReplaceNamePlaceholder(`Hallo, [name]! ðŸ‘‹ Ich bin ehoser KI, dein persÃ¶nlicher Assistent auf dem ehoser Server. Wie kann ich dir heute helfen?`);
        appendKIBubble('ai', greeting);
    }
    setTimeout(() => document.getElementById('kiInput')?.focus(), 50);
}

function kiHandleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        showAlert('Datei zu groÃŸ (max. 4 MB).', 'error');
        event.target.value = '';
        return;
    }
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onload = (e) => {
        _kiAttachment = { type: isImage ? 'image' : 'text', data: e.target.result, name: file.name };
        document.getElementById('kiAttachPreview').style.display = 'flex';
        document.getElementById('kiAttachName').textContent = 'ðŸ“Ž ' + file.name;
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
    event.target.value = '';
}

function kiClearAttachment() {
    _kiAttachment = null;
    const preview = document.getElementById('kiAttachPreview');
    if (preview) preview.style.display = 'none';
    const name = document.getElementById('kiAttachName');
    if (name) name.textContent = '';
}

function kiReplaceNamePlaceholder(text) {
    const name = sessionStorage.getItem('kiUserName') || '';
    return name ? text.replace(/\[name\]/gi, name) : text;
}

function appendKIBubble(type, text) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = `ki-bubble ki-bubble-${type}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

function appendKIImageBubble(prompt, imageUrl) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.8rem;color:#8ab4c9;margin-bottom:8px;';
    label.textContent = '\uD83C\uDFA8 Generiertes Bild: ' + prompt;
    div.appendChild(label);
    const loading = document.createElement('div');
    loading.style.cssText = 'color:#8ab4c9;font-size:0.9rem;padding:4px 0;';
    loading.textContent = '\u23F3 Bild wird generiert\u2026 (kann bis zu 30 Sekunden dauern)';
    div.appendChild(loading);
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = prompt;
    img.style.cssText = 'max-width:100%;border-radius:10px;display:none;cursor:pointer;margin-top:6px;';
    img.title = 'Klicken zum \u00D6ffnen in neuem Tab';
    img.onclick = () => window.open(imageUrl, '_blank', 'noopener');
    img.onload = () => {
        loading.remove();
        img.style.display = 'block';
        messages.scrollTop = messages.scrollHeight;
    };
    img.onerror = () => {
        loading.innerHTML = '\u274C Bild konnte nicht geladen werden. '
            + '<a href="' + imageUrl + '" target="_blank" rel="noopener" style="color:#8ab4c9;text-decoration:underline;">Direkt \u00F6ffnen</a>'
            + ' &nbsp;<button onclick="this.closest(\'.ki-bubble\').querySelector(\'img\').src=\'' + imageUrl + '?r=\'+Date.now()" '
            + 'style="background:#1e3a4a;color:#8ab4c9;border:1px solid #8ab4c9;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:0.8rem;">'
            + '\uD83D\uDD04 Erneut versuchen</button>';
    };
    div.appendChild(img);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function kiHandleImageGenCommand(reply) {
    const match = reply.match(/BILD_GENERIEREN:\s*(.+)/i);
    if (!match) return false;
    const prompt = match[1].trim().replace(/["']/g, '').slice(0, 500);
    const seed = Math.floor(Math.random() * 999999);
    // Direkt von Pollinations laden – kein Backend-Proxy, kein Vercel-Timeout
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
    const textBefore = reply.replace(/BILD_GENERIEREN:\s*.+/i, '').trim();
    if (textBefore) appendKIBubble('ai', kiReplaceNamePlaceholder(textBefore));
    appendKIImageBubble(prompt, url);
    return true;
}

function appendKIVideoBubble(prompt) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.8rem;color:#8ab4c9;margin-bottom:8px;';
    label.textContent = '\uD83C\uDFAC Generiertes Video: ' + prompt;
    div.appendChild(label);
    const status = document.createElement('div');
    status.className = 'ki-video-status';
    status.style.cssText = 'color:#8ab4c9;font-size:0.9rem;padding:4px 0;';
    status.textContent = '\u23F3 Video wird generiert\u2026 (kann 1-3 Minuten dauern)';
    div.appendChild(status);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return { div, status };
}

async function kiStartVideoGeneration(prompt) {
    const bubble = appendKIVideoBubble(prompt);
    if (!bubble) return;
    const { div, status } = bubble;
    const messages = document.getElementById('kiMessages');
    try {
        const res = await fetch('/api/ki/video/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });

        if (!res.ok) {
            let error = 'Video-Generierung fehlgeschlagen';
            try {
                const data = await res.json();
                if (data?.error) error = data.error;
            } catch {
                try {
                    const text = await res.text();
                    if (text) error = text;
                } catch {}
            }
            status.textContent = '\u274C ' + error;
            return;
        }

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        status.remove();

        const video = document.createElement('video');
        video.src = objectUrl;
        video.controls = true;
        video.playsInline = true;
        video.style.cssText = 'max-width:100%;border-radius:10px;margin-top:6px;';

        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = 'ehoser-ki-video.mp4';
        link.style.cssText = 'display:block;font-size:0.8rem;color:#8ab4c9;margin-top:6px;text-decoration:underline;';
        link.textContent = '\u2B07\uFE0F Video herunterladen';

        div.appendChild(video);
        div.appendChild(link);
        if (messages) messages.scrollTop = messages.scrollHeight;
    } catch (err) {
        status.textContent = '\u274C Verbindungsfehler';
    }
}

function kiHandleVideoGenCommand(reply) {
    const match = reply.match(/VIDEO_GENERIEREN:\s*(.+)/i);
    if (!match) return false;
    const prompt = match[1].trim().replace(/["']/g, '').slice(0, 500);
    const textBefore = reply.replace(/VIDEO_GENERIEREN:\s*.+/i, '').trim();
    if (textBefore) appendKIBubble('ai', kiReplaceNamePlaceholder(textBefore));
    kiStartVideoGeneration(prompt);
    return true;
}

function showKITyping() {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai ki-typing';
    div.id = 'kiTypingIndicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

async function sendKIMessage() {
    const input = document.getElementById('kiInput');
    const sendBtn = document.querySelector('.ki-send-btn');
    const text = input?.value.trim();
    const token = localStorage.getItem('token');
    if (!text && !_kiAttachment) return;

    input.value = '';
    if (sendBtn) sendBtn.disabled = true;

    // â”€â”€ Nachricht aufbauen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let apiMessage; // was an Groq geht (ggf. mit base64 Bild)
    let historyMsg; // was im Verlauf gespeichert wird (kein base64)

    if (_kiAttachment?.type === 'image') {
        // Bild-Bubble im Chat anzeigen
        const msgEl = document.getElementById('kiMessages');
        if (msgEl) {
            const bubble = document.createElement('div');
            bubble.className = 'ki-bubble ki-bubble-user';
            const img = document.createElement('img');
            img.src = _kiAttachment.data;
            img.className = 'ki-bubble-img';
            img.alt = _kiAttachment.name;
            bubble.appendChild(img);
            if (text) { const t = document.createElement('div'); t.style.marginTop='6px'; t.textContent = text; bubble.appendChild(t); }
            msgEl.appendChild(bubble);
            msgEl.scrollTop = msgEl.scrollHeight;
        }
        // Groq Vision Format
        apiMessage = { role: 'user', content: [
            { type: 'text', text: text || 'Was siehst du auf diesem Bild?' },
            { type: 'image_url', image_url: { url: _kiAttachment.data } }
        ]};
        historyMsg = { role: 'user', content: `[Bild: ${_kiAttachment.name}]${text ? ' â€“ ' + text : ''}` };
    } else if (_kiAttachment?.type === 'text') {
        const combined = `Dateiinhalt (${_kiAttachment.name}):\n\`\`\`\n${_kiAttachment.data.slice(0, 8000)}\n\`\`\`${text ? '\n\n' + text : ''}`;
        // Zeige Datei-Badge + Text im Chat
        const msgEl = document.getElementById('kiMessages');
        if (msgEl) {
            const bubble = document.createElement('div');
            bubble.className = 'ki-bubble ki-bubble-user';
            const badge = document.createElement('div');
            badge.className = 'ki-bubble-file-badge';
            badge.textContent = 'ðŸ“„ ' + _kiAttachment.name;
            bubble.appendChild(badge);
            if (text) { const t = document.createElement('div'); t.style.marginTop='4px'; t.textContent = text; bubble.appendChild(t); }
            msgEl.appendChild(bubble);
            msgEl.scrollTop = msgEl.scrollHeight;
        }
        apiMessage = { role: 'user', content: combined };
        historyMsg = { role: 'user', content: combined };
    } else {
        appendKIBubble('user', text);
        apiMessage = { role: 'user', content: text };
        historyMsg = apiMessage;
    }

    kiClearAttachment();

    // Verlauf + API-Nachrichten aufbauen
    const historyForRequest = [..._kiHistory, apiMessage];
    _kiHistory.push(historyMsg);

    const typing = showKITyping();

    try {
        const res = await fetch('/api/ki', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ messages: historyForRequest })
        });

        typing?.remove();

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err?.error?.message || `Fehler ${res.status}`;
            appendKIBubble('error', 'âš ï¸ ' + msg);
            _kiHistory.pop();
            return;
        }

        const data = await res.json();
        const rawReply = data?.choices?.[0]?.message?.content || '(Keine Antwort)';
        _kiHistory.push({ role: 'assistant', content: rawReply });
        if (!kiHandleVideoGenCommand(rawReply) && !kiHandleImageGenCommand(rawReply)) {
            const reply = kiReplaceNamePlaceholder(rawReply);
            appendKIBubble('ai', reply);
        }
        await refreshCurrentProfile();
    } catch (err) {
        typing?.remove();
        appendKIBubble('error', 'âš ï¸ Verbindungsfehler. Bitte versuche es erneut.');
        _kiHistory.pop();
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        input?.focus();
    }
}

function clearKIChat() {
    kiClearAttachment();
    _kiHistory = [{ role: 'system', content: KI_SYSTEM_PROMPT }];
    const messages = document.getElementById('kiMessages');
    if (messages) messages.innerHTML = '';
    appendKIBubble('ai', kiReplaceNamePlaceholder('Verlauf geleert. ðŸ‘‹ Womit kann ich dir helfen, [name]?'));
}
function renderImageSearchResults(hits) {
    const grid = document.getElementById('imageSearchResults');
    if (!grid) return;

    if (!Array.isArray(hits) || !hits.length) {
        grid.innerHTML = '<div class="games-loading">Keine Bilder gefunden.</div>';
        return;
    }

    grid.innerHTML = hits.map((hit) => {
        const preview = escapeAttribute(hit.webformatURL || hit.previewURL || '');
        const pageUrl = escapeAttribute(hit.pageURL || '');
        const tags = escapeHtml(hit.tags || 'Bild');
        const author = escapeHtml(hit.user || 'Unbekannt');
        return `
            <article class="image-result-card">
                <a href="${pageUrl}" target="_blank" rel="noopener noreferrer" class="image-result-link">
                    <img src="${preview}" alt="${tags}" loading="lazy" class="image-result-thumb">
                </a>
                <div class="image-result-meta">
                    <div class="image-result-tags">${tags}</div>
                    <div class="image-result-user">von ${author}</div>
                </div>
            </article>
        `;
    }).join('');
}

async function runImageSearch() {
    const input = document.getElementById('imageSearchInput');
    const status = document.getElementById('imageSearchStatus');
    const grid = document.getElementById('imageSearchResults');
    const token = localStorage.getItem('token');

    if (!token) {
        showAlert('Bitte zuerst anmelden, um die Bildersuche zu nutzen.', 'error');
        showSection('auth');
        return;
    }

    const q = (input?.value || '').trim();
    if (!q) {
        status.textContent = 'Bitte Suchwort eingeben.';
        return;
    }

    imageSearchLastQuery = q;
    status.textContent = 'Suche lÃ¤uft...';
    if (grid) grid.innerHTML = '<div class="games-loading">Bilder werden geladenâ€¦</div>';

    try {
        const params = new URLSearchParams({ q });
        const response = await fetch(`${API_BASE}/pixabay?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await response.json();

        if (!response.ok) {
            status.textContent = `Fehler: ${data.error || 'Suche fehlgeschlagen.'}`;
            if (grid) grid.innerHTML = '';
            return;
        }

        const hits = Array.isArray(data.hits) ? data.hits : [];
        status.textContent = `${hits.length} Treffer fÃ¼r "${q}"`;
        renderImageSearchResults(hits);
    } catch {
        status.textContent = 'Verbindungsfehler bei der Bildersuche.';
        if (grid) grid.innerHTML = '';
    }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('proStatus');
    currentUser = null;
    currentProfile = null;
    allApps = [];
    stopOnlinePolling();
    stopResetStatusPolling();
    document.getElementById('onlineWidget').style.display = 'none';
    location.reload();
}

let onlineInterval = null;
let heartbeatInterval = null;

function startOnlinePolling() {
    fetchOnlineUsers();
    onlineInterval = setInterval(fetchOnlineUsers, 30000);
    heartbeatInterval = setInterval(sendHeartbeat, 60000);
    startScreenSharePolling();
}

function stopOnlinePolling() {
    clearInterval(onlineInterval);
    clearInterval(heartbeatInterval);
    stopScreenSharePolling();
}

async function sendHeartbeat() {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API_BASE}/heartbeat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {});
}

async function fetchOnlineUsers() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/online-users`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const users = await res.json();
        const widget = document.getElementById('onlineWidget');
        const list = document.getElementById('onlineList');
        widget.style.display = '';
        if (users.length === 0) {
            list.innerHTML = '<li style="color:var(--muted)">Niemand online</li>';
        } else {
            list.innerHTML = users.map(u => `<li>${escapeHtml(u.username)}</li>`).join('');
        }
    } catch {}
}

function applyProfileSettings() {
    const settings = currentProfile?.settings;
    if (!settings) {
        applyPersonalizationUI();
        return;
    }

    document.documentElement.dataset.design = settings.design || 'standard';
    if (settings.energySaver) {
        document.body.classList.add('energy-saver');
    } else {
        document.body.classList.remove('energy-saver');
    }

    applyPersonalizationUI();
}

function updatePlanBadge() {
    const el = document.getElementById('planBadge');
    if (!el) return;

    if (currentProfile?.isPro) {
        const until = currentProfile.proUntil ? new Date(currentProfile.proUntil).toLocaleDateString('de-DE') : '';
        el.textContent = until ? `Plan: PRO bis ${until}` : 'Plan: PRO';
        el.classList.add('pro');
    } else {
        el.textContent = 'Plan: Gratis';
        el.classList.remove('pro');
    }
}

function openSettingsModal() {
    if (!currentUser) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    const modal = document.getElementById('settingsModal');
    const p = currentProfile || { settings: { language: 'de', design: 'standard', energySaver: false }, isPro: false };
    document.getElementById('settingLanguage').value = p.settings?.language || 'de';
    document.getElementById('settingDesign').value = p.settings?.design || 'standard';
    document.getElementById('settingEnergySaver').checked = Boolean(p.settings?.energySaver);
    document.getElementById('settingPersonalizationEnabled').checked = p.settings?.personalizationEnabled !== false;
    document.getElementById('inviteLinkWrap').style.display = 'none';
    // Login-Code laden und anzeigen
    const codeDisplay = document.getElementById('myLoginCodeDisplay');
    if (codeDisplay) {
        codeDisplay.textContent = 'â€¢â€¢â€¢â€¢â€¢â€¢';
        codeDisplay.dataset.revealed = 'false';
    }
    const toggleBtn = document.getElementById('toggleCodeBtn');
    if (toggleBtn) toggleBtn.textContent = 'ðŸ‘ Anzeigen';
    fetchLoginCode();
    updatePlanBadge();
    // Aktuelle E-Mail laden
    const emailDisplay = document.getElementById('emailCurrentDisplay');
    if (emailDisplay) {
        fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(r => r.json())
            .then(d => {
                const mail = d.user?.email || null;
                emailDisplay.textContent = mail ? `Verknüpft: ${mail}` : 'Noch keine E-Mail verknüpft.';
                const unlinkRow = document.getElementById('emailUnlinkRow');
                if (unlinkRow) unlinkRow.style.display = mail ? 'block' : 'none';
            }).catch(() => {});
    }
    document.getElementById('emailCodeRow').style.display = 'none';
    // Chat Token laden
    loadChatToken();
    modal.classList.add('show');
}

let _cachedLoginCode = null;
async function fetchLoginCode() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/login-code`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        _cachedLoginCode = data.loginCode || null;
        const codeDisplay = document.getElementById('myLoginCodeDisplay');
        if (codeDisplay && codeDisplay.dataset.revealed === 'true') {
            codeDisplay.textContent = _cachedLoginCode || 'â€“';
        }
    } catch {}
}

function toggleShowLoginCode() {
    const codeDisplay = document.getElementById('myLoginCodeDisplay');
    const btn = document.getElementById('toggleCodeBtn');
    if (!codeDisplay) return;
    if (codeDisplay.dataset.revealed === 'true') {
        codeDisplay.textContent = 'â€¢â€¢â€¢â€¢â€¢â€¢';
        codeDisplay.dataset.revealed = 'false';
        if (btn) btn.textContent = 'ðŸ‘ Anzeigen';
    } else {
        if (_cachedLoginCode) {
            codeDisplay.textContent = _cachedLoginCode;
            codeDisplay.dataset.revealed = 'true';
            if (btn) btn.textContent = 'ðŸ™ˆ Verbergen';
        } else {
            fetchLoginCode().then(() => {
                if (_cachedLoginCode) {
                    codeDisplay.textContent = _cachedLoginCode;
                    codeDisplay.dataset.revealed = 'true';
                    if (btn) btn.textContent = 'ðŸ™ˆ Verbergen';
                }
            });
        }
    }
}

async function copyLoginCode() {
    if (!_cachedLoginCode) await fetchLoginCode();
    if (!_cachedLoginCode) { showAlert('Code konnte nicht geladen werden.', 'error'); return; }
    try {
        await navigator.clipboard.writeText(_cachedLoginCode);
        showAlert('Login-Code kopiert!', 'success');
    } catch {
        showAlert('Kopieren fehlgeschlagen. Bitte manuell kopieren.', 'error');
    }
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.remove('show');
    // E-Mail-Eingaben beim Schließen zurücksetzen
    const emailInput = document.getElementById('emailInput');
    const emailCodeInput = document.getElementById('emailCodeInput');
    const emailCodeRow = document.getElementById('emailCodeRow');
    if (emailInput) emailInput.value = '';
    if (emailCodeInput) emailCodeInput.value = '';
    if (emailCodeRow) emailCodeRow.style.display = 'none';
}

async function loadChatToken() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/chat-token`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        const display = document.getElementById('chatTokenDisplay');
        const val = document.getElementById('chatTokenValue');
        if (data.token && display && val) {
            val.textContent = data.token;
            display.style.display = 'block';
        }
    } catch {}
}

async function createChatToken() {
    const token = localStorage.getItem('token');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }
    const msg = document.getElementById('chatTokenMsg');
    if (msg) msg.textContent = 'Token wird erstellt...';
    try {
        const res = await fetch(`${API_BASE}/me/chat-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { if (msg) msg.textContent = data.error || 'Fehler.'; return; }
        const display = document.getElementById('chatTokenDisplay');
        const val = document.getElementById('chatTokenValue');
        if (display && val) { val.textContent = data.token; display.style.display = 'block'; }
        if (msg) msg.textContent = 'Token wurde erstellt!';
    } catch { if (msg) msg.textContent = 'Netzwerkfehler.'; }
}

function copyChatToken() {
    const val = document.getElementById('chatTokenValue');
    if (!val?.textContent) return;
    navigator.clipboard.writeText(val.textContent).then(() => {
        const msg = document.getElementById('chatTokenMsg');
        if (msg) msg.textContent = 'Token kopiert!';
    });
}

// ─── Inline Chat ──────────────────────────────────────────────────────────────
let _chatCurrentGroupId = null;
let _chatCurrentGroupName = null;
let _chatPollInterval = null;
let _chatLastMsgId = 0;
let _chatGroups = [];
let _chatUserSearchTimer = null;

async function initChatSection() {
    _chatCurrentGroupId = null;
    clearInterval(_chatPollInterval);
    document.getElementById('chatEmptyState').style.display = 'flex';
    document.getElementById('chatConv').style.display = 'none';
    await chatLoadGroups();
}

async function chatLoadGroups() {
    const token = localStorage.getItem('token');
    if (!token) return;
    const list = document.getElementById('chatGroupList');
    try {
        const res = await fetch(`${API_BASE}/chat/groups`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        _chatGroups = data.groups || [];
        if (!_chatGroups.length) {
            list.innerHTML = '<div class="chat-loading" style="color:#6a9bb8;font-size:0.9rem;padding:16px;">Noch keine Gespräche.<br>Suche einen Nutzer oben.</div>';
            return;
        }
        list.innerHTML = _chatGroups.map(g => `
            <button class="chat-group-item" onclick="openChatGroup('${escapeAttribute(g.id)}','${escapeAttribute(g.name)}')">
                <div class="chat-group-avatar">${escapeHtml(g.name.charAt(0).toUpperCase())}</div>
                <div class="chat-group-info">
                    <div class="chat-group-name">${escapeHtml(g.name)}</div>
                    <div class="chat-group-sub">Tippen zum öffnen</div>
                </div>
            </button>
        `).join('');
    } catch {
        list.innerHTML = '<div class="chat-loading" style="color:#e57373;">Fehler beim Laden.</div>';
    }
}

function chatSearchUsers(query) {
    const dropdown = document.getElementById('chatUserDropdown');
    clearTimeout(_chatUserSearchTimer);
    if (!query || query.length < 2) {
        dropdown.style.display = 'none';
        return;
    }
    _chatUserSearchTimer = setTimeout(async () => {
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const res = await fetch(`${API_BASE}/chat/users/search?q=${encodeURIComponent(query)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            const users = data.users || [];
            if (!users.length) {
                dropdown.innerHTML = '<div class="chat-dd-item chat-dd-empty">Kein Nutzer gefunden</div>';
                dropdown.style.display = 'block';
                return;
            }
            dropdown.innerHTML = users.map(u =>
                `<div class="chat-dd-item" onclick="chatStartDM('${escapeAttribute(u)}')">${escapeHtml(u)}</div>`
            ).join('');
            dropdown.style.display = 'block';
        } catch {
            dropdown.style.display = 'none';
        }
    }, 300);
}

async function chatStartDM(targetUsername) {
    const token = localStorage.getItem('token');
    if (!token) return;
    document.getElementById('chatUserDropdown').style.display = 'none';
    document.getElementById('chatDmInput').value = '';

    // Schauen ob bereits Gespräch existiert
    const existing = _chatGroups.find(g => g.name === targetUsername || g.name === currentUser?.username + ' & ' + targetUsername || g.name === targetUsername + ' & ' + currentUser?.username);
    if (existing) {
        openChatGroup(existing.id, existing.name);
        return;
    }

    // Neues Gespräch erstellen
    const groupName = targetUsername;
    const myUsername = currentUser?.username;
    if (!myUsername) return;

    try {
        const res = await fetch(`${API_BASE}/chat/groups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                name: groupName,
                memberKeys: { [myUsername]: 'plain', [targetUsername]: 'plain' }
            })
        });
        const data = await res.json();
        if (!res.ok) {
            showAlert(data.error || 'Gespräch konnte nicht erstellt werden.', 'error');
            return;
        }
        await chatLoadGroups();
        openChatGroup(data.id, data.name);
    } catch {
        showAlert('Netzwerkfehler beim Erstellen des Gesprächs.', 'error');
    }
}

function openChatGroup(groupId, groupName) {
    _chatCurrentGroupId = groupId;
    _chatCurrentGroupName = groupName;
    _chatLastMsgId = 0;
    document.getElementById('chatEmptyState').style.display = 'none';
    document.getElementById('chatConv').style.display = 'flex';
    document.getElementById('chatConvName').textContent = groupName;
    document.getElementById('chatConvStatus').textContent = '● Online';
    document.getElementById('chatMessages').innerHTML = '';
    clearInterval(_chatPollInterval);
    chatFetchMessages();
    _chatPollInterval = setInterval(chatFetchMessages, 3000);
    setTimeout(() => document.getElementById('chatMsgInput')?.focus(), 50);
    // Highlight aktive Gruppe
    document.querySelectorAll('.chat-group-item').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector(`.chat-group-item[onclick*="${groupId}"]`);
    if (btn) btn.classList.add('active');
}

function closeChatConv() {
    clearInterval(_chatPollInterval);
    _chatCurrentGroupId = null;
    document.getElementById('chatConv').style.display = 'none';
    document.getElementById('chatEmptyState').style.display = 'flex';
}

async function chatFetchMessages() {
    if (!_chatCurrentGroupId) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        let url = `${API_BASE}/chat/messages/${_chatCurrentGroupId}`;
        if (_chatLastMsgId) url += `?after=${_chatLastMsgId}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        const msgs = data.messages || [];
        if (!msgs.length) return;
        const container = document.getElementById('chatMessages');
        const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
        msgs.forEach(m => {
            _chatLastMsgId = Math.max(_chatLastMsgId, m.id);
            const isMe = m.sender === currentUser?.username;
            const div = document.createElement('div');
            div.className = `chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}`;
            const time = new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            div.innerHTML = `
                ${!isMe ? `<div class="chat-msg-sender">${escapeHtml(m.sender)}</div>` : ''}
                <div class="chat-msg-bubble">${escapeHtml(m.encrypted_content)}</div>
                <div class="chat-msg-time">${time}</div>
            `;
            container.appendChild(div);
        });
        if (wasAtBottom) container.scrollTop = container.scrollHeight;
    } catch {}
}

async function sendChatMsg() {
    if (!_chatCurrentGroupId) return;
    const input = document.getElementById('chatMsgInput');
    const text = input?.value.trim();
    if (!text) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    input.value = '';
    input.style.height = 'auto';
    try {
        await fetch(`${API_BASE}/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ groupId: _chatCurrentGroupId, encryptedContent: text })
        });
        await chatFetchMessages();
    } catch {
        showAlert('Nachricht konnte nicht gesendet werden.', 'error');
    }
}

document.addEventListener('click', e => {
    const dropdown = document.getElementById('chatUserDropdown');
    const input = document.getElementById('chatDmInput');
    if (dropdown && input && !input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

// ─── Psychologischer Support (PS) ────────────────────────────────────────────

let _psName = '';
let _psAnswers = []; // { question, answer }
let _psChatHistory = []; // { role, content }
let _psAllSummary = '';

const PS_FIXED_QUESTIONS = [
    'Wie geht es dir heute?',
    'Wie ging es dir in den letzten Wochen?',
    'Was ist deine größte Angst?',
    'Was ist dein größter Wunsch?',
    'Hast du einen Zwang, etwas nicht zu können?'
];

function _psSaveState() {
    try {
        localStorage.setItem('ps_chat', JSON.stringify({
            name: _psName,
            history: _psChatHistory,
            summary: _psAllSummary
        }));
    } catch {}
}

function _psLoadState() {
    try {
        const raw = localStorage.getItem('ps_chat');
        if (!raw) return false;
        const saved = JSON.parse(raw);
        if (!saved?.history?.length) return false;
        _psName = saved.name || '';
        _psChatHistory = saved.history;
        _psAllSummary = saved.summary || '';
        return true;
    } catch { return false; }
}

function openPsHelp() {
    const overlay = document.getElementById('psOverlay');
    if (!overlay) return;

    // Wenn gespeicherter Chat vorhanden → direkt Chat zeigen
    if (_psLoadState()) {
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        showPsScreen('psScreenChat');
        const chatMessages = document.getElementById('psChatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
            _psChatHistory.forEach(m => appendPsChatMessage(m.role, m.content));
        }
        return;
    }

    // Kein gespeicherter Chat → Neu starten
    _psName = '';
    _psAnswers = [];
    _psChatHistory = [];
    _psAllSummary = '';
    showPsScreen('psScreenName');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closePsOverlay() {
    const overlay = document.getElementById('psOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
}

function resetPsChat() {
    if (!confirm('Chat wirklich loeschen und neu starten?')) return;
    localStorage.removeItem('ps_chat');
    _psName = '';
    _psAnswers = [];
    _psChatHistory = [];
    _psAllSummary = '';
    closePsOverlay();
}

function showPsScreen(id) {
    ['psScreenName', 'psScreenSurvey', 'psScreenAnalyzing', 'psScreenResult', 'psScreenChat']
        .forEach(s => {
            const el = document.getElementById(s);
            if (el) el.style.display = s === id ? 'flex' : 'none';
        });
}

function startPsSurvey() {
    const nameInput = document.getElementById('psFirstNameInput');
    const name = nameInput?.value.trim();
    if (!name) { showAlert('Bitte gib deinen Vornamen ein.', 'error'); return; }
    _psName = name;
    _psAnswers = [];
    showPsSurveyQuestion(0, PS_FIXED_QUESTIONS);
}

function showPsSurveyQuestion(index, questions) {
    const numEl = document.getElementById('psSurveyNum');
    const totalEl = document.getElementById('psSurveyTotal');
    const questionEl = document.getElementById('psSurveyQuestion');
    const answerEl = document.getElementById('psSurveyAnswer');
    const nextBtn = document.getElementById('psNextBtn');
    const bar = document.getElementById('psSurveyBar');

    if (numEl) numEl.textContent = index + 1;
    if (totalEl) totalEl.textContent = questions.length;
    if (questionEl) questionEl.textContent = questions[index];
    if (answerEl) answerEl.value = '';
    if (bar) bar.style.width = `${Math.round((index / questions.length) * 100)}%`;
    if (nextBtn) nextBtn.onclick = () => submitPsSurveyAnswer(index, questions);
    showPsScreen('psScreenSurvey');
}

async function submitPsSurveyAnswer(index, questions) {
    const answerEl = document.getElementById('psSurveyAnswer');
    const answer = answerEl?.value.trim();
    if (!answer) { showAlert('Bitte schreib eine Antwort.', 'error'); return; }

    _psAnswers.push({ question: questions[index], answer });

    if (index + 1 < questions.length) {
        // More questions in this phase
        showPsSurveyQuestion(index + 1, questions);
    } else if (questions === PS_FIXED_QUESTIONS) {
        // Fixed questions done → AI generates follow-up questions
        await fetchPsFollowUpQuestions();
    } else {
        // All personalized questions done → show result
        await showPsResult();
    }
}

async function fetchPsFollowUpQuestions() {
    showPsScreen('psScreenAnalyzing');
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
        const res = await fetch(`${API_BASE}/ps/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: _psName, answers: _psAnswers.slice(0, 4) })
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.questions)) {
            showAlert('KI-Analyse fehlgeschlagen. Weiter mit Standard-Fragen.', 'error');
            await showPsResult();
            return;
        }
        showPsSurveyQuestion(0, data.questions);
    } catch {
        await showPsResult();
    }
}

async function showPsResult() {
    showPsScreen('psScreenResult');
    // Build summary for AI chat context
    _psAllSummary = _psAnswers.map((a, i) => `Frage ${i + 1}: ${a.question}\nAntwort: ${a.answer}`).join('\n\n');

    // Small delay for effect
    await new Promise(r => setTimeout(r, 2000));

    // Open chat and get initial AI analysis
    await initPsChat();
}

async function initPsChat() {
    showPsScreen('psScreenChat');
    const chatMessages = document.getElementById('psChatMessages');
    if (chatMessages) chatMessages.innerHTML = '';
    _psChatHistory = [];

    // AI sends opening message
    const openingMessage = `Hallo ${_psName}, ich habe deine Antworten gelesen. Danke, dass du dich mir anvertraust. Ich bin hier, um dir zuzuhören und dir zu helfen. Lass uns gemeinsam schauen, wie es dir geht.`;
    appendPsChatMessage('assistant', openingMessage);
    _psChatHistory.push({ role: 'assistant', content: openingMessage });
    _psSaveState();

    // AI analyzes and responds
    await sendPsChatToAI(null);
}

function appendPsChatMessage(role, text) {
    const chatMessages = document.getElementById('psChatMessages');
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.style.cssText = `margin:8px 0;padding:12px 16px;border-radius:14px;max-width:85%;word-wrap:break-word;line-height:1.5;font-size:0.95rem;color:#fff;${role === 'user' ? 'background:rgba(77,159,255,0.2);border:1px solid rgba(77,159,255,0.35);margin-left:auto;text-align:right;' : 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);'}`;
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendPsChatToAI(userMessage) {
    const token = localStorage.getItem('token');
    if (!token) return;

    if (userMessage) {
        _psChatHistory.push({ role: 'user', content: userMessage });
        appendPsChatMessage('user', userMessage);
        _psSaveState();
    }

    // Typing indicator
    const chatMessages = document.getElementById('psChatMessages');
    const typing = document.createElement('div');
    typing.id = 'psTyping';
    typing.style.cssText = 'padding:10px 16px;color:#8ab4c9;font-style:italic;font-size:0.9rem;';
    typing.textContent = '...';
    if (chatMessages) chatMessages.appendChild(typing);

    try {
        const res = await fetch(`${API_BASE}/ps/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                name: _psName,
                messages: _psChatHistory.filter(m => m.role === 'user' || m.role === 'assistant'),
                allAnswersSummary: _psAllSummary
            })
        });
        const data = await res.json();
        typing?.remove();
        if (!res.ok) { appendPsChatMessage('assistant', 'Entschuldigung, ich konnte gerade nicht antworten. Versuch es nochmal.'); return; }
        const reply = data.reply || '';
        _psChatHistory.push({ role: 'assistant', content: reply });
        appendPsChatMessage('assistant', reply);
        _psSaveState();
        await refreshCurrentProfile();
    } catch {
        typing?.remove();
        appendPsChatMessage('assistant', 'Verbindungsfehler. Bitte versuche es erneut.');
    }
}

async function sendPsChat() {
    const input = document.getElementById('psChatInput');
    const message = input?.value.trim();
    if (!message) return;
    if (input) input.value = '';
    await sendPsChatToAI(message);
}

function psChatKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendPsChat();
    }
}

async function unlinkEmail() {
    if (!confirm('E-Mail-Adresse wirklich entfernen?')) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/unlink-email`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Fehler beim Entfernen.', 'error'); return; }
        document.getElementById('emailCurrentDisplay').textContent = 'Noch keine E-Mail verknüpft.';
        document.getElementById('emailUnlinkRow').style.display = 'none';
        showAlert('E-Mail wurde entfernt.', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

// ── E-Mail Verknüpfung ────────────────────────────────────────────────────────
async function sendEmailCode() {
    const email = document.getElementById('emailInput')?.value?.trim();
    if (!email) { showAlert('Bitte eine E-Mail-Adresse eingeben.', 'error'); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/link-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Fehler beim Senden.', 'error'); return; }
        document.getElementById('emailCodeRow').style.display = 'block';
        showAlert('Code wurde gesendet!', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

async function verifyEmailCode() {
    const code = document.getElementById('emailCodeInput')?.value?.trim();
    if (!code || code.length !== 6) { showAlert('Bitte den 6-stelligen Code eingeben.', 'error'); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Falscher Code.', 'error'); return; }
        document.getElementById('emailCurrentDisplay').textContent = `Verknüpft: ${data.email}`;
        document.getElementById('emailCodeRow').style.display = 'none';
        document.getElementById('emailInput').value = '';
        document.getElementById('emailCodeInput').value = '';
        showAlert('E-Mail erfolgreich verknüpft!', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

async function saveAccountSettings() {
    const token = localStorage.getItem('token');
    if (!token) return;

    const payload = {
        language: document.getElementById('settingLanguage').value,
        design: document.getElementById('settingDesign').value,
        energySaver: document.getElementById('settingEnergySaver').checked,
        personalizationEnabled: document.getElementById('settingPersonalizationEnabled').checked
    };

    try {
        const response = await fetch(`${API_BASE}/me/settings`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Einstellungen konnten nicht gespeichert werden.', 'error');
            return;
        }
        currentProfile = data.profile;
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showLoggedInUI();
        closeSettingsModal();
        showAlert('Einstellungen gespeichert.', 'success');
    } catch {
        showAlert('Netzwerkfehler beim Speichern.', 'error');
    }
}

async function createReferralInvite() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const response = await fetch(`${API_BASE}/referral/create`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Referral-Link konnte nicht erstellt werden.', 'error');
            return;
        }
        document.getElementById('inviteLinkWrap').style.display = 'grid';
        document.getElementById('inviteLinkInput').value = data.inviteUrl;
        showAlert('Link erstellt. Wenn 1 Person registriert, bekommt ihr beide 2 Tage PRO.', 'success');
    } catch {
        showAlert('Referral-Link konnte nicht erstellt werden.', 'error');
    }
}

async function copyInviteLink() {
    const input = document.getElementById('inviteLinkInput');
    if (!input?.value) return;
    try {
        await navigator.clipboard.writeText(input.value);
        showAlert('Einladungslink kopiert.', 'success');
    } catch {
        input.select();
        document.execCommand('copy');
    }
}

function openFacewarpModeModal() {
    document.getElementById('facewarpModeModal').classList.add('show');
}

function closeFacewarpModeModal() {
    document.getElementById('facewarpModeModal').classList.remove('show');
}

function openFacewarpWithTier(tier) {
    const safeTier = tier === 'pro' ? 'pro' : 'basic';
    window.location.href = `/facewarp/?tier=${safeTier}`;
}

function showAlert(message, type) {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;

    const mainContent = document.querySelector('.main-content');
    mainContent.insertBefore(alertDiv, mainContent.firstChild);

    setTimeout(() => alertDiv.remove(), 3500);
}

window.onclick = function onWindowClick(evt) {
    const modal = document.getElementById('appModal');
    if (evt.target === modal) {
        modal.classList.remove('show');
    }
    const settingsModal = document.getElementById('settingsModal');
    if (evt.target === settingsModal) {
        closeSettingsModal();
    }
    const facewarpModeModal = document.getElementById('facewarpModeModal');
    if (evt.target === facewarpModeModal) {
        closeFacewarpModeModal();
    }
    const gameModal = document.getElementById('gameModal');
    if (evt.target === gameModal) {
        closeGameModal();
    }
};

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

// â”€â”€â”€ Online Spiele â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let gamesAllLoaded = [];
let gamesFiltered = [];
let gamesCurrentPage = 1;
let gamesCurrentCategory = 'all';
let gamesSearchText = '';

// â”€â”€â”€ Game Timer Variablen (15min Limit fÃ¼r Gratis) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _gameTimerInterval = null;
let _gameSecondsLeft = 0;
let _gameStartTime = null;
let _gameLimitSeconds = 900; // 15 Min = 900 Sekunden fÃ¼r Gratis

async function loadGames() {
    const grid = document.getElementById('gamesGrid');
    grid.innerHTML = '<div class="games-loading">Spiele werden geladenâ€¦</div>';

    try {
        const res = await fetch(`${API_BASE}/games?page=${gamesCurrentPage}`);
        if (!res.ok) throw new Error('Feed nicht verfÃ¼gbar');
        const data = await res.json();

        if (!Array.isArray(data) || !data.length) {
            grid.innerHTML = '<div class="games-loading">Keine Spiele gefunden.</div>';
            document.getElementById('gamesNextBtn').disabled = true;
            return;
        }

        gamesAllLoaded = data;
        buildGameCategoryFilter(data);
        gamesFiltered = data;
        applyGamesFilter();

        document.getElementById('gamesPageInfo').textContent = `Seite ${gamesCurrentPage}`;
        document.getElementById('gamesPrevBtn').disabled = gamesCurrentPage <= 1;
        document.getElementById('gamesNextBtn').disabled = data.length < 10;
    } catch (err) {
        grid.innerHTML = `<div class="games-loading" style="color:#b63f2d">Fehler: ${escapeHtml(err.message)}</div>`;
    }
}

function buildGameCategoryFilter(games) {
    const categories = ['all', ...new Set(games.map(g => g.category).filter(Boolean).sort())];
    const container = document.getElementById('gamesCategoryFilter');
    container.innerHTML = categories.map(c =>
        `<button class="filter-btn${c === gamesCurrentCategory ? ' active' : ''}" 
            onclick="filterGamesByCategory('${escapeAttribute(c)}', this)">${escapeHtml(c === 'all' ? 'Alle' : c)}</button>`
    ).join('');
}

function filterGamesByCategory(category, btn) {
    gamesCurrentCategory = category;
    document.querySelectorAll('#gamesCategoryFilter .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyGamesFilter();
}

function filterGames() {
    gamesSearchText = document.getElementById('gamesSearch').value.trim().toLowerCase();
    applyGamesFilter();
}

function applyGamesFilter() {
    let result = [...gamesAllLoaded];

    if (gamesSearchText) {
        result = result.filter(g =>
            (g.title || '').toLowerCase().includes(gamesSearchText) ||
            (g.description || '').toLowerCase().includes(gamesSearchText) ||
            (g.tags || '').toLowerCase().includes(gamesSearchText) ||
            (g.category || '').toLowerCase().includes(gamesSearchText)
        );
    }

    if (gamesCurrentCategory !== 'all') {
        result = result.filter(g => g.category === gamesCurrentCategory);
    }

    gamesFiltered = result;
    displayGames(gamesFiltered);
}

function displayGames(games) {
    const grid = document.getElementById('gamesGrid');

    if (!games.length) {
        grid.innerHTML = '<div class="games-loading">Keine Spiele gefunden.</div>';
        return;
    }

    grid.innerHTML = games.map(g => {
        const title = escapeHtml(g.title || 'Unbekannt');
        const category = escapeHtml(g.category || '');
        const tags = (g.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            .slice(0, 4).map(t => `<span class="game-tag">${escapeHtml(t)}</span>`).join('');
        const desc = escapeHtml((g.description || '').replace(/&[a-z]+;/gi, ' ').substring(0, 120));
        const thumb = escapeAttribute(g.thumb || '');
        const gameUrl = escapeAttribute(g.url || '');
        const gTitle = escapeAttribute(g.title || '');

        return `
        <article class="game-card" onclick="openGame('${gameUrl}', '${gTitle}')">
            <div class="game-thumb-wrap">
                <img class="game-thumb" src="${thumb}" alt="${title}" loading="lazy" onerror="this.style.display='none'">
                <div class="game-play-overlay">â–¶</div>
            </div>
            <div class="game-info">
                <h3 class="game-title">${title}</h3>
                ${category ? `<span class="game-category">${category}</span>` : ''}
                <p class="game-desc">${desc}${(g.description || '').length > 120 ? 'â€¦' : ''}</p>
                <div class="game-tags">${tags}</div>
            </div>
        </article>`;
    }).join('');
}

function _formatGameTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `â±ï¸ ${mins}:${secs.toString().padStart(2, '0')}`;
}

function _updateGameTimer() {
    if (!_gameStartTime) return;
    
    const elapsed = Math.floor((Date.now() - _gameStartTime) / 1000);
    _gameSecondsLeft = Math.max(0, _gameLimitSeconds - elapsed);
    
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.textContent = _formatGameTime(_gameSecondsLeft);
        badge.classList.toggle('warning', _gameSecondsLeft <= 60);
    }
    
    if (_gameSecondsLeft <= 0) {
        _stopGameTimer();
        alert('â±ï¸ Deine 15 Minuten sind vorbei! Jetzt Vollzugang freischalten fÃ¼r unbegrenzte Spielzeit.');
        closeGameModal();
    }
}

function _startGameTimer() {
    if (_gameTimerInterval) clearInterval(_gameTimerInterval);
    _gameStartTime = Date.now();
    _gameSecondsLeft = _gameLimitSeconds;
    
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.style.display = 'block';
        badge.classList.remove('warning');
    }
    
    _gameTimerInterval = setInterval(_updateGameTimer, 500);
}

function _stopGameTimer() {
    if (_gameTimerInterval) {
        clearInterval(_gameTimerInterval);
        _gameTimerInterval = null;
    }
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.style.display = 'none';
    }
}

function openGame(url, title) {
    if (!url) return;
    
    // Wenn kein Pro â†’ Timer starten (15 Min)
    if (currentProfile && !currentProfile.isPro) {
        _startGameTimer();
    } else {
        _stopGameTimer();
        const badge = document.getElementById('gameTimerBadge');
        if (badge) badge.style.display = 'none';
    }
    
    document.getElementById('gameFrame').src = url;
    document.getElementById('gameModal').classList.add('show');
}

function closeGameModal() {
    _stopGameTimer();
    document.getElementById('gameFrame').src = '';
    document.getElementById('gameModal').classList.remove('show');
    // ZurÃ¼ck zu Spieleauswahl
    showSection('games');
}

function changeGamesPage(delta) {
    gamesCurrentPage = Math.max(1, gamesCurrentPage + delta);
    gamesAllLoaded = [];
    gamesFiltered = [];
    gamesCurrentCategory = 'all';
    gamesSearchText = '';
    document.getElementById('gamesSearch').value = '';
    loadGames();
}

// â”€â”€â”€ BildschirmÃ¼bertragung (Nutzer = Sharer / WebRTC Answerer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _srSession = null;
let _srOffer = null;
let _srPc = null;
let _srStream = null;
let _srPollInterval = null;
let _srMouseHandler = null;

function startScreenSharePolling() {
    if (_srPollInterval) return;
    _srPollInterval = setInterval(_pollShareRequest, 2500);
}

function stopScreenSharePolling() {
    clearInterval(_srPollInterval);
    _srPollInterval = null;
}

async function _pollShareRequest() {
    const token = localStorage.getItem('token');
    if (!token || _srPc) return;
    try {
        const res = await fetch(`${API_BASE}/screenshare/pending`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.pending && data.sessionId && data.offer) {
            stopScreenSharePolling();
            _srSession = data.sessionId;
            _srOffer = data.offer;
            document.getElementById('shareRequestPopup').style.display = 'flex';
        }
    } catch {}
}

async function acceptShareRequest() {
    document.getElementById('shareRequestPopup').style.display = 'none';
    const token = localStorage.getItem('token');
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser',
                frameRate: { ideal: 30 },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false,
            preferCurrentTab: true,
            selfBrowserSurface: 'include'
        });
        _srStream = stream;

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        _srPc = pc;

        // Video-Track hinzufÃ¼gen
        stream.getTracks().forEach(track => {
            pc.addTrack(track, stream);
            track.onended = () => endShareSession();
        });

        // Maus-DataChannel empfangen (wird vom Admin erstellt)
        pc.ondatachannel = (event) => {
            if (event.channel.label !== 'mouse') return;
            const ch = event.channel;
            ch.onopen = () => _startMouseTracking(ch);
            ch.onclose = () => _stopMouseTracking();
        };

        pc.onconnectionstatechange = () => {
            if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) endShareSession();
        };

        // Offer setzen, Answer erstellen
        await pc.setRemoteDescription(new RTCSessionDescription(_srOffer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Warten bis ICE-Gathering abgeschlossen
        const finalAnswer = await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve(pc.localDescription);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') resolve(pc.localDescription);
            };
            setTimeout(() => resolve(pc.localDescription), 5000);
        });

        const res = await fetch(`${API_BASE}/screenshare/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession, answer: finalAnswer, accept: true })
        });
        if (!res.ok) { endShareSession(); return; }

        document.getElementById('shareIndicator').style.display = 'flex';
    } catch (err) {
        endShareSession();
        startScreenSharePolling();
    }
}

async function declineShareRequest() {
    document.getElementById('shareRequestPopup').style.display = 'none';
    const token = localStorage.getItem('token');
    if (_srSession && token) {
        await fetch(`${API_BASE}/screenshare/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession, accept: false })
        }).catch(() => {});
    }
    _srSession = null;
    _srOffer = null;
    startScreenSharePolling();
}

function _startMouseTracking(channel) {
    let lastSend = 0;
    _srMouseHandler = (e) => {
        const now = Date.now();
        if (now - lastSend < 33) return; // ~30fps
        lastSend = now;
        if (channel.readyState !== 'open') return;
        channel.send(JSON.stringify({
            x: e.clientX / window.innerWidth,
            y: e.clientY / window.innerHeight
        }));
    };
    document.addEventListener('mousemove', _srMouseHandler);
}

function _stopMouseTracking() {
    if (_srMouseHandler) {
        document.removeEventListener('mousemove', _srMouseHandler);
        _srMouseHandler = null;
    }
}

async function endShareSession() {
    _stopMouseTracking();
    if (_srStream) { _srStream.getTracks().forEach(t => t.stop()); _srStream = null; }
    if (_srPc) { _srPc.close(); _srPc = null; }
    const token = localStorage.getItem('token');
    if (_srSession && token) {
        await fetch(`${API_BASE}/screenshare/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession })
        }).catch(() => {});
        _srSession = null;
    }
    document.getElementById('shareIndicator').style.display = 'none';
    startScreenSharePolling();
}


// ─── Game Creator ─────────────────────────────────────────────────────────────
let _gameCurrentCode = '';

function openGameCreator() {
    if (!currentProfile?.isPro) {
        showAlert('Spiele erstellen ist nur für PRO-Nutzer verfügbar.', 'error');
        return;
    }
    const overlay = document.getElementById('gameCreatorOverlay');
    if (overlay) { overlay.style.display = 'flex'; }
}

function closeGameCreator() {
    const overlay = document.getElementById('gameCreatorOverlay');
    if (overlay) overlay.style.display = 'none';
}

function _gameSetStatus(msg) {
    const el = document.getElementById('gameStatus');
    if (el) el.textContent = msg;
}

function _gameShowLoading(show) {
    const empty = document.getElementById('gamePreviewEmpty');
    const loading = document.getElementById('gamePreviewLoading');
    const frame = document.getElementById('gamePreviewFrame');
    if (show) {
        if (empty) empty.style.display = 'none';
        if (loading) { loading.style.display = 'flex'; }
        if (frame) frame.style.display = 'none';
    } else {
        if (loading) loading.style.display = 'none';
    }
}

function _gameShowFrame(code) {
    const frame = document.getElementById('gamePreviewFrame');
    const empty = document.getElementById('gamePreviewEmpty');
    const dlBtn = document.getElementById('gameDownloadBtn');
    if (!frame) return;
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    frame.src = url;
    frame.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (dlBtn) dlBtn.style.display = '';
}

function _gameAddHistoryBubble(role, text) {
    const history = document.getElementById('gamePromptHistory');
    if (!history) return;
    const div = document.createElement('div');
    div.className = 'game-history-bubble ' + role;
    div.textContent = (role === 'user' ? '👤 ' : '🤖 ') + text;
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
}

async function sendGamePrompt() {
    const input = document.getElementById('gamePromptInput');
    const sendBtn = document.getElementById('gameSendBtn');
    const prompt = input?.value?.trim();
    if (!prompt) return;

    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Generiere...';

    const isImprovement = !!_gameCurrentCode;
    _gameAddHistoryBubble('user', isImprovement ? '🔧 Verbessern: ' + prompt : prompt);
    _gameSetStatus(isImprovement ? 'KI verbessert dein Spiel...' : 'KI programmiert dein Spiel...');
    _gameShowLoading(true);

    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/game/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ prompt, currentCode: _gameCurrentCode || undefined })
        });
        const data = await res.json();
        if (!res.ok || !data.code) {
            _gameShowLoading(false);
            const errMsg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || 'Unbekannter Fehler');
            _gameSetStatus('Fehler: ' + errMsg);
            _gameAddHistoryBubble('ai', 'Fehler: ' + errMsg);
            return;
        }
        _gameCurrentCode = data.code;
        _gameShowLoading(false);
        _gameShowFrame(data.code);
        _gameSetStatus('Spiel bereit! ' + (isImprovement ? 'Verbesserung angewendet.' : ''));
        _gameAddHistoryBubble('ai', isImprovement ? 'Spiel wurde verbessert!' : 'Spiel erfolgreich generiert!');
    } catch (err) {
        _gameShowLoading(false);
        _gameSetStatus('Verbindungsfehler. Bitte versuche es erneut.');
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = _gameCurrentCode ? '🔧 Verbessern' : '✨ Spiel generieren';
    }
}

function downloadGame() {
    if (!_gameCurrentCode) return;
    const blob = new Blob([_gameCurrentCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ehoser-spiel.html';
    a.click();
    URL.revokeObjectURL(url);
}

// ── Mode-Suchleiste ───────────────────────────────────────────────────────────
function filterModeCards(query) {
    const q = (query || '').toLowerCase().trim();
    const cards = document.querySelectorAll('#modeCardsGrid .mode-card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.classList.toggle('hidden', q.length > 0 && !text.includes(q));
    });
}

// ── QR-Code Generator ─────────────────────────────────────────────────────────
let _qrDebounce = null;

function generateQR() {
    clearTimeout(_qrDebounce);
    _qrDebounce = setTimeout(_doGenerateQR, 150);
}

function _doGenerateQR() {
    const input = document.getElementById('qrInput');
    const canvas = document.getElementById('qrCanvas');
    const output = document.getElementById('qrOutput');
    const actions = document.getElementById('qrActions');
    const empty = document.getElementById('qrEmpty');
    const text = input ? input.value.trim() : '';

    if (!text) {
        if (output) output.classList.remove('visible');
        if (actions) actions.style.display = 'none';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    if (typeof QRCode === 'undefined') {
        if (empty) { empty.textContent = 'QR-Bibliothek wird geladen…'; empty.style.display = ''; }
        return;
    }

    QRCode.toCanvas(canvas, text, { width: 260, margin: 2, color: { dark: '#000', light: '#fff' } }, function(err) {
        if (err) {
            if (empty) { empty.textContent = 'Fehler: ' + err.message; empty.style.display = ''; }
            return;
        }
        if (output) output.classList.add('visible');
        if (actions) actions.style.display = 'flex';
    });
}

function downloadQR() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'qr-code.png';
    a.click();
}

async function copyQRToClipboard() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    try {
        canvas.toBlob(async blob => {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showAlert('QR-Code in die Zwischenablage kopiert!', 'success');
        });
    } catch {
        showAlert('Kopieren nicht unterstützt – bitte herunterladen.', 'error');
    }
}

// ── Taschenrechner ────────────────────────────────────────────────────────────
let _calcExpr = '';
let _calcHistory = [];

function calcInput(val) {
    _calcExpr += val;
    _calcRender();
}

function calcClear() {
    _calcExpr = '';
    _calcRender();
}

function calcDel() {
    _calcExpr = _calcExpr.slice(0, -1);
    _calcRender();
}

function calcEquals() {
    if (!_calcExpr) return;
    try {
        // Sichere Auswertung: nur Zahlen, Operatoren, Math-Funktionen erlaubt
        const sanitized = _calcExpr
            .replace(/sqrt\(/g, 'Math.sqrt(')
            .replace(/sin\(/g, 'Math.sin(')
            .replace(/cos\(/g, 'Math.cos(')
            .replace(/tan\(/g, 'Math.tan(')
            .replace(/log\(/g, 'Math.log10(')
            .replace(/\*\*/g, '**');
        // Nur sichere Zeichen erlauben
        if (/[^0-9+\-*/().^eMath.PIE\s]/.test(sanitized.replace(/Math\.(sqrt|sin|cos|tan|log10|PI|E)/g, ''))) {
            throw new Error('Ungültige Zeichen');
        }
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + sanitized + ')')();
        const displayResult = Number.isFinite(result) ? +result.toPrecision(12) : 'Fehler';
        _calcHistory.unshift(_calcExpr + ' = ' + displayResult);
        if (_calcHistory.length > 20) _calcHistory.pop();
        _calcExpr = String(displayResult);
        _calcRender(displayResult);
        _calcRenderHistory();
    } catch {
        const resultEl = document.getElementById('calcResult');
        if (resultEl) resultEl.textContent = 'Fehler';
    }
}

function _calcRender(result) {
    const exprEl = document.getElementById('calcExpression');
    const resultEl = document.getElementById('calcResult');
    if (exprEl) exprEl.textContent = _calcExpr || '';
    if (resultEl) {
        if (result !== undefined) {
            resultEl.textContent = result;
        } else {
            // Live-Vorschau
            try {
                const sanitized = _calcExpr
                    .replace(/sqrt\(/g, 'Math.sqrt(')
                    .replace(/sin\(/g, 'Math.sin(')
                    .replace(/cos\(/g, 'Math.cos(')
                    .replace(/tan\(/g, 'Math.tan(')
                    .replace(/log\(/g, 'Math.log10(');
                // eslint-disable-next-line no-new-func
                const r = Function('"use strict"; return (' + sanitized + ')')();
                resultEl.textContent = Number.isFinite(r) ? +r.toPrecision(12) : (_calcExpr || '0');
            } catch {
                resultEl.textContent = _calcExpr || '0';
            }
        }
    }
}

function _calcRenderHistory() {
    const histEl = document.getElementById('calcHistory');
    if (!histEl) return;
    if (_calcHistory.length === 0) { histEl.classList.remove('visible'); return; }
    histEl.classList.add('visible');
    histEl.innerHTML = _calcHistory.map(h => `<div class="calc-history-item">${h}</div>`).join('');
}

// ── Notizen ───────────────────────────────────────────────────────────────────
let _notesData = [];

function _notesLoad() {
    try {
        _notesData = JSON.parse(localStorage.getItem('ehoser_notes') || '[]');
    } catch { _notesData = []; }
}

function _notesSave() {
    localStorage.setItem('ehoser_notes', JSON.stringify(_notesData));
}

function _notesRender() {
    const grid = document.getElementById('notesGrid');
    const empty = document.getElementById('notesEmpty');
    if (!grid) return;
    grid.innerHTML = '';
    if (_notesData.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    _notesData.forEach((note, idx) => {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.innerHTML = `
            <input class="note-title-input" placeholder="Titel…" value="${_escapeAttr(note.title)}" oninput="notesUpdateField(${idx},'title',this.value)">
            <textarea class="note-body-input" placeholder="Notiz hier eingeben…" oninput="notesUpdateField(${idx},'content',this.value)">${_escapeHtmlText(note.content)}</textarea>
            <div class="note-footer">
                <span class="note-date">${new Date(note.created).toLocaleDateString('de-DE')}</span>
                <button class="note-delete" onclick="notesDelete(${idx})">🗑 Löschen</button>
            </div>`;
        grid.appendChild(card);
    });
}

function _escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _escapeHtmlText(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function notesAddNew() {
    _notesLoad();
    _notesData.unshift({ id: Date.now(), title: '', content: '', created: Date.now() });
    _notesSave();
    _notesRender();
    // Fokus auf den Titel der neuen Notiz
    setTimeout(() => document.querySelector('.note-title-input')?.focus(), 50);
}

function notesUpdateField(idx, field, value) {
    if (_notesData[idx]) {
        _notesData[idx][field] = value;
        _notesSave();
    }
}

function notesDelete(idx) {
    _notesData.splice(idx, 1);
    _notesSave();
    _notesRender();
}

// ═══════════════════════════════════════════════════════════════
// ██████  PASSWORT-GENERATOR
// ═══════════════════════════════════════════════════════════════
function pwdGenerate() {
    const len = parseInt(document.getElementById('pwdLen').value);
    const upper = document.getElementById('pwdUpper').checked;
    const lower = document.getElementById('pwdLower').checked;
    const nums  = document.getElementById('pwdNums').checked;
    const syms  = document.getElementById('pwdSyms').checked;
    let chars = '';
    if (upper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (lower) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (nums)  chars += '0123456789';
    if (syms)  chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    if (!chars) { chars = 'abcdefghijklmnopqrstuvwxyz'; }
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    let pwd = '';
    for (let i = 0; i < len; i++) pwd += chars[arr[i] % chars.length];
    document.getElementById('pwdOutput').textContent = pwd;
    // Stärke-Anzeige
    const strength = [upper, lower, nums, syms].filter(Boolean).length;
    const labels = ['', 'Schwach', 'Mittel', 'Stark', 'Sehr Stark'];
    const colors = ['', '#e53e3e', '#dd6b20', '#38a169', '#0e8a9b'];
    const el = document.getElementById('pwdStrength');
    el.textContent = labels[strength] || '';
    el.style.color = colors[strength] || '';
}
function pwdCopy() {
    const t = document.getElementById('pwdOutput').textContent;
    if (t && t !== 'Passwort erscheint hier…') {
        navigator.clipboard.writeText(t).then(() => showAlert('Passwort kopiert!', 'success'));
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  FARBPALETTEN-GENERATOR
// ═══════════════════════════════════════════════════════════════
let _paletteColors = [];
function paletteGenerate() {
    const baseH = Math.floor(Math.random() * 360);
    const schemes = ['analogous', 'complementary', 'triadic', 'splitComp', 'monochromatic'];
    const scheme = schemes[Math.floor(Math.random() * schemes.length)];
    let hues = [];
    if (scheme === 'analogous')       hues = [baseH, baseH+30, baseH+60, baseH+90, baseH+120];
    else if (scheme === 'complementary') hues = [baseH, baseH+30, baseH+60, baseH+180, baseH+210];
    else if (scheme === 'triadic')    hues = [baseH, baseH+120, baseH+240, baseH+60, baseH+180];
    else if (scheme === 'splitComp')  hues = [baseH, baseH+150, baseH+210, baseH+30, baseH+330];
    else hues = [baseH, baseH, baseH, baseH, baseH];
    const sats = scheme === 'monochromatic' ? [20, 40, 60, 80, 100] : [60, 70, 75, 65, 80];
    const lights = scheme === 'monochromatic' ? [80, 65, 50, 35, 20] : [80, 60, 45, 60, 35];
    _paletteColors = hues.map((h, i) => {
        h = ((h % 360) + 360) % 360;
        const s = sats[i], l = lights[i];
        return { hsl: `hsl(${h},${s}%,${l}%)`, hex: hslToHex(h, s, l) };
    });
    const grid = document.getElementById('paletteGrid');
    grid.innerHTML = _paletteColors.map((c, i) => `
        <div class="palette-swatch" style="background:${c.hsl};" onclick="navigator.clipboard.writeText('${c.hex}').then(()=>showAlert('${c.hex} kopiert!','success'))">
            <span class="palette-hex">${c.hex}</span>
        </div>`).join('');
}
function paletteCopyCSS() {
    const css = _paletteColors.map((c, i) => `--color-${i+1}: ${c.hex};`).join('\n');
    navigator.clipboard.writeText(`:root {\n${css}\n}`).then(() => showAlert('CSS kopiert!', 'success'));
}
function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════
// ██████  JSON FORMATTER
// ═══════════════════════════════════════════════════════════════
function jsonFormat() {
    const input = document.getElementById('jsonInput').value.trim();
    const out = document.getElementById('jsonOutput');
    const status = document.getElementById('jsonStatus');
    if (!input) { out.textContent = ''; status.textContent = ''; return; }
    try {
        const parsed = JSON.parse(input);
        out.textContent = JSON.stringify(parsed, null, 2);
        status.textContent = '✅ Gültiges JSON';
        status.style.color = '#38a169';
    } catch (e) {
        out.textContent = '';
        status.textContent = '❌ ' + e.message;
        status.style.color = '#e53e3e';
    }
}
function jsonMinify() {
    const input = document.getElementById('jsonInput').value.trim();
    const out = document.getElementById('jsonOutput');
    const status = document.getElementById('jsonStatus');
    try {
        const parsed = JSON.parse(input);
        out.textContent = JSON.stringify(parsed);
        status.textContent = '✅ Minifiziert';
        status.style.color = '#38a169';
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.style.color = '#e53e3e';
    }
}
function jsonClear() {
    document.getElementById('jsonInput').value = '';
    document.getElementById('jsonOutput').textContent = '';
    document.getElementById('jsonStatus').textContent = '';
}

// ═══════════════════════════════════════════════════════════════
// ██████  STOPPUHR & TIMER
// ═══════════════════════════════════════════════════════════════
let _swRunning = false, _swStart = 0, _swElapsed = 0, _swTimer = null, _swLaps = [];
let _cdRunning = false, _cdTimer = null, _cdRemaining = 0;

function swSwitchTab(tab) {
    document.getElementById('swPanel').style.display = tab === 'sw' ? '' : 'none';
    document.getElementById('cdPanel').style.display = tab === 'cd' ? '' : 'none';
    document.querySelectorAll('.sw-tab').forEach(b => b.classList.toggle('active', b.textContent === (tab === 'sw' ? 'Stoppuhr' : 'Countdown')));
}
function swToggle() {
    if (_swRunning) {
        clearInterval(_swTimer);
        _swElapsed += Date.now() - _swStart;
        _swRunning = false;
        document.getElementById('swStartBtn').textContent = '▶ Start';
    } else {
        _swStart = Date.now();
        _swRunning = true;
        _swTimer = setInterval(swTick, 100);
        document.getElementById('swStartBtn').textContent = '⏸ Pause';
    }
}
function swTick() {
    const total = _swElapsed + (Date.now() - _swStart);
    const ms = Math.floor((total % 1000) / 100);
    const s  = Math.floor(total / 1000) % 60;
    const m  = Math.floor(total / 60000) % 60;
    const h  = Math.floor(total / 3600000);
    document.getElementById('swDisplay').textContent =
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}`;
}
function swLap() {
    if (!_swRunning) return;
    const total = _swElapsed + (Date.now() - _swStart);
    _swLaps.push(total);
    const laps = document.getElementById('swLaps');
    const ms = Math.floor((total % 1000) / 100);
    const s  = Math.floor(total / 1000) % 60;
    const m  = Math.floor(total / 60000) % 60;
    laps.innerHTML = `<div class="sw-lap">🏁 Runde ${_swLaps.length}: ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}</div>` + laps.innerHTML;
}
function swReset() {
    clearInterval(_swTimer);
    _swRunning = false; _swElapsed = 0; _swLaps = [];
    document.getElementById('swDisplay').textContent = '00:00:00.0';
    document.getElementById('swStartBtn').textContent = '▶ Start';
    document.getElementById('swLaps').innerHTML = '';
}
function cdToggle() {
    if (_cdRunning) {
        clearInterval(_cdTimer); _cdRunning = false;
        document.getElementById('cdStartBtn').textContent = '▶ Start';
    } else {
        const m = parseInt(document.getElementById('cdMin').value) || 0;
        const s = parseInt(document.getElementById('cdSec').value) || 0;
        if (_cdRemaining <= 0) _cdRemaining = m * 60000 + s * 1000;
        if (_cdRemaining <= 0) return;
        _cdRunning = true;
        document.getElementById('cdStartBtn').textContent = '⏸ Pause';
        _cdTimer = setInterval(() => {
            _cdRemaining -= 1000;
            if (_cdRemaining <= 0) {
                _cdRemaining = 0; clearInterval(_cdTimer); _cdRunning = false;
                document.getElementById('cdStartBtn').textContent = '▶ Start';
                cdTick();
                // Beep
                const ctx = new AudioContext();
                const osc = ctx.createOscillator(); osc.connect(ctx.destination);
                osc.frequency.value = 880; osc.start(); osc.stop(ctx.currentTime + 0.4);
            }
            cdTick();
        }, 1000);
    }
}
function cdTick() {
    const m = Math.floor(_cdRemaining / 60000);
    const s = Math.floor((_cdRemaining % 60000) / 1000);
    document.getElementById('cdDisplay').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function cdReset() {
    clearInterval(_cdTimer); _cdRunning = false; _cdRemaining = 0;
    document.getElementById('cdDisplay').textContent = '00:00';
    document.getElementById('cdStartBtn').textContent = '▶ Start';
}

// ═══════════════════════════════════════════════════════════════
// ██████  TEXT ENCODER / DECODER
// ═══════════════════════════════════════════════════════════════
function encUpdate() {
    const input = document.getElementById('encInput').value;
    const mode = document.querySelector('input[name="encMode"]:checked').value;
    let out = '';
    try {
        if (mode === 'b64e')   out = btoa(unescape(encodeURIComponent(input)));
        else if (mode === 'b64d') out = decodeURIComponent(escape(atob(input)));
        else if (mode === 'rot13') out = input.replace(/[a-zA-Z]/g, c => {
            const base = c <= 'Z' ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
        });
        else if (mode === 'url')  out = encodeURIComponent(input);
        else if (mode === 'urld') out = decodeURIComponent(input);
    } catch (e) { out = '❌ Fehler: ' + e.message; }
    document.getElementById('encOutput').value = out;
}

// ═══════════════════════════════════════════════════════════════
// ██████  EINHEITEN-UMRECHNER
// ═══════════════════════════════════════════════════════════════
const _unitsData = {
    length:  { m:1, km:0.001, cm:100, mm:1000, mi:0.000621371, ft:3.28084, inch:39.3701, yd:1.09361 },
    weight:  { kg:1, g:1000, mg:1e6, lb:2.20462, oz:35.274, t:0.001 },
    data:    { B:1, KB:1/1024, MB:1/1024**2, GB:1/1024**3, TB:1/1024**4, bit:8 },
    speed:   { 'km/h':1, 'm/s':0.277778, 'mph':0.621371, knots:0.539957 },
    temp:    null
};
function unitsUpdateCat() {
    const cat = document.getElementById('unitsCat').value;
    const fromSel = document.getElementById('unitsFromUnit');
    const toSel   = document.getElementById('unitsToUnit');
    let keys = [];
    if (cat === 'temp') keys = ['°C','°F','K'];
    else keys = Object.keys(_unitsData[cat]);
    const opts = keys.map(k => `<option value="${k}">${k}</option>`).join('');
    fromSel.innerHTML = opts; toSel.innerHTML = opts;
    if (keys.length > 1) toSel.selectedIndex = 1;
    unitsConvert();
}
function unitsConvert() {
    const cat = document.getElementById('unitsCat').value;
    const val = parseFloat(document.getElementById('unitsFrom').value);
    const from = document.getElementById('unitsFromUnit').value;
    const to   = document.getElementById('unitsToUnit').value;
    if (isNaN(val)) return;
    let result;
    if (cat === 'temp') {
        let celsius;
        if (from === '°C') celsius = val;
        else if (from === '°F') celsius = (val - 32) * 5/9;
        else celsius = val - 273.15;
        if (to === '°C') result = celsius;
        else if (to === '°F') result = celsius * 9/5 + 32;
        else result = celsius + 273.15;
    } else {
        const table = _unitsData[cat];
        const base = val / table[from];
        result = base * table[to];
    }
    document.getElementById('unitsTo').value = parseFloat(result.toPrecision(7));
}

// ═══════════════════════════════════════════════════════════════
// ██████  ZUFALLSGENERATOR
// ═══════════════════════════════════════════════════════════════
function rngRollDice() {
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const val = (arr[0] % 6) + 1;
    const faces = ['', '⚀','⚁','⚂','⚃','⚄','⚅'];
    document.getElementById('rngDice').textContent = faces[val] + ' ' + val;
}
function rngRollNum() {
    const min = parseInt(document.getElementById('rngMin').value) || 1;
    const max = parseInt(document.getElementById('rngMax').value) || 100;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngNum').textContent = min + (arr[0] % (max - min + 1));
}
function rngFlipCoin() {
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngCoin').textContent = arr[0] % 2 === 0 ? '🪙 Kopf' : '🪙 Zahl';
}
function rngPickName() {
    const lines = document.getElementById('rngNameList').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngName').textContent = '🎉 ' + lines[arr[0] % lines.length];
}

// ═══════════════════════════════════════════════════════════════
// ██████  TON-GENERATOR
// ═══════════════════════════════════════════════════════════════
let _toneCtx = null, _toneOsc = null, _toneGain = null, _tonePlaying = false;
function toneUpdate() {
    const freq = parseFloat(document.getElementById('toneFreq').value);
    const vol  = parseFloat(document.getElementById('toneVol').value);
    const wave = document.getElementById('toneWave').value;
    document.getElementById('toneFreqLabel').textContent = freq + ' Hz';
    if (_toneOsc) { _toneOsc.frequency.value = freq; _toneOsc.type = wave; }
    if (_toneGain) _toneGain.gain.value = vol;
}
function toneSetFreq(f) {
    document.getElementById('toneFreq').value = f;
    toneUpdate();
}
function toneToggle() {
    if (_tonePlaying) {
        _toneOsc?.stop();
        _toneOsc = null;
        _tonePlaying = false;
        document.getElementById('tonePlayBtn').textContent = '▶ Play';
    } else {
        _toneCtx = _toneCtx || new AudioContext();
        _toneGain = _toneCtx.createGain();
        _toneGain.gain.value = parseFloat(document.getElementById('toneVol').value);
        _toneGain.connect(_toneCtx.destination);
        _toneOsc = _toneCtx.createOscillator();
        _toneOsc.type = document.getElementById('toneWave').value;
        _toneOsc.frequency.value = parseFloat(document.getElementById('toneFreq').value);
        _toneOsc.connect(_toneGain);
        _toneOsc.start();
        _tonePlaying = true;
        document.getElementById('tonePlayBtn').textContent = '⏹ Stop';
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  ZEICHENPAD
// ═══════════════════════════════════════════════════════════════
let _drawCtx = null, _drawTool = 'pen', _drawMouseDown = false;
function drawInit() {
    const canvas = document.getElementById('drawCanvas');
    if (_drawCtx) return;
    canvas.width = canvas.offsetWidth || 800;
    canvas.height = canvas.offsetHeight || 500;
    _drawCtx = canvas.getContext('2d');
    _drawCtx.fillStyle = '#1a2332';
    _drawCtx.fillRect(0, 0, canvas.width, canvas.height);
    const getPos = (e) => {
        const r = canvas.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const down = (e) => { _drawMouseDown = true; const p = getPos(e); _drawCtx.beginPath(); _drawCtx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => {
        if (!_drawMouseDown) return;
        const p = getPos(e);
        _drawCtx.lineWidth = document.getElementById('drawSize').value;
        _drawCtx.lineCap = 'round';
        if (_drawTool === 'eraser') { _drawCtx.globalCompositeOperation = 'destination-out'; _drawCtx.strokeStyle = 'rgba(0,0,0,1)'; }
        else { _drawCtx.globalCompositeOperation = 'source-over'; _drawCtx.strokeStyle = document.getElementById('drawColor').value; }
        _drawCtx.lineTo(p.x, p.y); _drawCtx.stroke(); e.preventDefault();
    };
    const up = () => { _drawMouseDown = false; };
    canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move); canvas.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, {passive:false}); canvas.addEventListener('touchmove', move, {passive:false}); canvas.addEventListener('touchend', up);
}
function drawSetTool(t) { _drawTool = t; }
function drawClear() { if (_drawCtx) { const c = document.getElementById('drawCanvas'); _drawCtx.globalCompositeOperation = 'source-over'; _drawCtx.fillStyle = '#1a2332'; _drawCtx.fillRect(0, 0, c.width, c.height); } }
function drawExport() {
    const canvas = document.getElementById('drawCanvas');
    const a = document.createElement('a'); a.download = 'zeichnung.png'; a.href = canvas.toDataURL(); a.click();
}

// ═══════════════════════════════════════════════════════════════
// ██████  HABIT TRACKER
// ═══════════════════════════════════════════════════════════════
let _habits = [];
function habitsLoad() { try { _habits = JSON.parse(localStorage.getItem('ehoser_habits') || '[]'); } catch(e) { _habits = []; } }
function habitsSave() { localStorage.setItem('ehoser_habits', JSON.stringify(_habits)); }
function habitsRender() {
    habitsLoad();
    const today = new Date().toISOString().split('T')[0];
    const grid = document.getElementById('habitsGrid');
    const empty = document.getElementById('habitsEmpty');
    if (!_habits.length) { grid.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    grid.innerHTML = _habits.map((h, i) => {
        const doneTodday = h.daysCompleted && h.daysCompleted.includes(today);
        return `<div class="habit-card ${doneTodday ? 'habit-done' : ''}">
            <div class="habit-name">${escapeHtml(h.name)}</div>
            <div class="habit-streak">🔥 ${h.streak || 0} Tage Streak</div>
            <div class="habit-actions">
                <button class="btn-primary" onclick="habitToggle(${i})">${doneTodday ? '✅ Erledigt' : '⬜ Heute erledigen'}</button>
                <button class="btn-secondary" onclick="habitDelete(${i})">🗑</button>
            </div>
        </div>`;
    }).join('');
}
function habitAdd() {
    const name = prompt('Gewohnheit (z.B. Sport, Lesen, Wasser trinken):');
    if (!name || !name.trim()) return;
    habitsLoad();
    _habits.push({ name: name.trim(), streak: 0, daysCompleted: [] });
    habitsSave(); habitsRender();
}
function habitToggle(i) {
    habitsLoad();
    const today = new Date().toISOString().split('T')[0];
    const h = _habits[i];
    if (!h.daysCompleted) h.daysCompleted = [];
    if (h.daysCompleted.includes(today)) {
        h.daysCompleted = h.daysCompleted.filter(d => d !== today);
        h.streak = Math.max(0, (h.streak || 1) - 1);
    } else {
        h.daysCompleted.push(today);
        h.streak = (h.streak || 0) + 1;
    }
    habitsSave(); habitsRender();
}
function habitDelete(i) {
    habitsLoad();
    _habits.splice(i, 1);
    habitsSave(); habitsRender();
}

// ═══════════════════════════════════════════════════════════════
// ██████  TEXT TOOLS
// ═══════════════════════════════════════════════════════════════
function ttUpdate() {
    const v = document.getElementById('ttInput').value;
    const words = v.trim() ? v.trim().split(/\s+/).length : 0;
    document.getElementById('ttStats').textContent = `Wörter: ${words} · Zeichen: ${v.length} · Zeilen: ${v.split('\n').length}`;
}
function ttTransform(action) {
    const el = document.getElementById('ttInput');
    let v = el.value;
    if (action === 'upper')  v = v.toUpperCase();
    else if (action === 'lower')  v = v.toLowerCase();
    else if (action === 'title')  v = v.replace(/\b\w/g, c => c.toUpperCase());
    else if (action === 'reverse') v = v.split('').reverse().join('');
    else if (action === 'trim')   v = v.split('\n').map(l => l.trim()).join('\n');
    else if (action === 'nodup')  v = [...new Set(v.split('\n'))].join('\n');
    else if (action === 'slug')   v = v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    el.value = v;
    ttUpdate();
}

// ═══════════════════════════════════════════════════════════════
// ██████  GRADIENT GENERATOR
// ═══════════════════════════════════════════════════════════════
function gradUpdate() {
    const type  = document.getElementById('gradType').value;
    const angle = document.getElementById('gradAngle').value;
    document.getElementById('gradAngleLabel').textContent = angle + '°';
    const c1 = document.getElementById('gradC1').value;
    const c2 = document.getElementById('gradC2').value;
    const c3 = document.getElementById('gradC3').value;
    let css;
    if (type === 'linear')       css = `linear-gradient(${angle}deg, ${c1}, ${c2}, ${c3})`;
    else if (type === 'radial')  css = `radial-gradient(circle, ${c1}, ${c2}, ${c3})`;
    else                          css = `conic-gradient(from ${angle}deg, ${c1}, ${c2}, ${c3})`;
    document.getElementById('gradPreview').style.background = css;
    document.getElementById('gradCode').textContent = `background: ${css};`;
}

// ═══════════════════════════════════════════════════════════════
// ██████  JS SANDBOX
// ═══════════════════════════════════════════════════════════════
function sandboxRun() {
    const code = document.getElementById('sandboxInput').value;
    const out  = document.getElementById('sandboxOutput');
    const logs = [];
    const fakeConsole = { log: (...a) => logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' ')), warn: (...a) => logs.push('⚠️ ' + a.join(' ')), error: (...a) => logs.push('❌ ' + a.join(' ')) };
    try {
        const fn = new Function('console', code);
        const ret = fn(fakeConsole);
        if (ret !== undefined) logs.push('→ ' + (typeof ret === 'object' ? JSON.stringify(ret, null, 2) : String(ret)));
        out.innerHTML = logs.map(l => `<div class="sandbox-line">${escapeHtml(l)}</div>`).join('') || '<div class="sandbox-line" style="color:#8ab4c9;">Kein Output</div>';
    } catch(e) {
        out.innerHTML = `<div class="sandbox-line" style="color:#e53e3e;">❌ ${escapeHtml(e.message)}</div>`;
    }
}
function sandboxClear() {
    document.getElementById('sandboxInput').value = '';
    document.getElementById('sandboxOutput').innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════
// ██████  REGEX TESTER
// ═══════════════════════════════════════════════════════════════
function regexTest() {
    const pattern = document.getElementById('regexPattern').value;
    const flags   = document.getElementById('regexFlags').value;
    const text    = document.getElementById('regexInput').value;
    const hl      = document.getElementById('regexHighlight');
    const matches = document.getElementById('regexMatches');
    if (!pattern) { hl.innerHTML = escapeHtml(text); matches.textContent = ''; return; }
    try {
        const re = new RegExp(pattern, flags);
        const found = [...text.matchAll(re)];
        hl.innerHTML = escapeHtml(text).replace(new RegExp(escapeHtml(pattern), flags), m => `<mark class="regex-mark">${m}</mark>`);
        matches.textContent = found.length ? `${found.length} Match${found.length > 1 ? 'es' : ''}: ${found.map(m => '"' + m[0] + '"').slice(0, 10).join(', ')}` : 'Keine Matches';
        matches.style.color = found.length ? '#38a169' : '#e53e3e';
    } catch(e) {
        hl.textContent = '';
        matches.textContent = '❌ ' + e.message;
        matches.style.color = '#e53e3e';
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  GLÜCKSRAD
// ═══════════════════════════════════════════════════════════════
let _wheelAngle = 0, _wheelSpinning = false;
const _wheelColors = ['#0e8a9b','#f47c2a','#a855f7','#38a169','#e53e3e','#ecc94b','#3182ce','#dd6b20','#2f855a','#b794f4'];
function wheelDraw() {
    const canvas = document.getElementById('wheelCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const entries = document.getElementById('wheelEntries').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!entries.length) return;
    const cx = canvas.width / 2, cy = canvas.height / 2, r = Math.min(cx, cy) - 10;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = (Math.PI * 2) / entries.length;
    entries.forEach((e, i) => {
        const start = _wheelAngle + i * step, end = start + step;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, end);
        ctx.fillStyle = _wheelColors[i % _wheelColors.length];
        ctx.fill(); ctx.strokeStyle = '#1a2332'; ctx.lineWidth = 2; ctx.stroke();
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(start + step / 2);
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(10, 16 - entries.length)}px "Space Grotesk"`;
        ctx.fillText(e.length > 12 ? e.slice(0, 12) + '…' : e, r - 10, 5);
        ctx.restore();
    });
    // Pointer
    ctx.beginPath(); ctx.moveTo(cx + r - 5, cy - 8); ctx.lineTo(cx + r + 15, cy); ctx.lineTo(cx + r - 5, cy + 8);
    ctx.fillStyle = '#fff'; ctx.fill();
}
function wheelSpin() {
    if (_wheelSpinning) return;
    const entries = document.getElementById('wheelEntries').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (entries.length < 2) return;
    _wheelSpinning = true;
    document.getElementById('wheelSpinBtn').disabled = true;
    document.getElementById('wheelResult').textContent = '';
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const totalRot = (Math.PI * 2 * (5 + arr[0] % 5)) + (Math.PI * 2 * (arr[0] % entries.length) / entries.length);
    const duration = 3000 + arr[0] % 2000;
    const start = performance.now(); const startAngle = _wheelAngle;
    function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 4);
        _wheelAngle = startAngle + totalRot * ease;
        wheelDraw();
        if (t < 1) { requestAnimationFrame(frame); }
        else {
            _wheelSpinning = false;
            document.getElementById('wheelSpinBtn').disabled = false;
            const step = (Math.PI * 2) / entries.length;
            const norm = ((-_wheelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const idx = Math.floor(norm / step) % entries.length;
            document.getElementById('wheelResult').textContent = '🎉 ' + entries[(entries.length - 1 - idx + entries.length) % entries.length];
        }
    }
    requestAnimationFrame(frame);
}

// ═══════════════════════════════════════════════════════════════
// ██████  HASH GENERATOR
// ═══════════════════════════════════════════════════════════════
async function hashUpdate() {
    const text = document.getElementById('hashInput').value;
    const results = document.getElementById('hashResults');
    if (!text) { results.innerHTML = ''; return; }
    const enc = new TextEncoder();
    const data = enc.encode(text);
    const algos = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
    const hashes = await Promise.all(algos.map(async alg => {
        const buf = await crypto.subtle.digest(alg, data);
        const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
        return { alg, hex };
    }));
    results.innerHTML = hashes.map(h => `
        <div class="hash-row">
            <span class="hash-algo">${h.alg}</span>
            <code class="hash-val">${h.hex}</code>
            <button class="btn-secondary" onclick="navigator.clipboard.writeText('${h.hex}').then(()=>showAlert('${h.alg} kopiert!','success'))">📋</button>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// ██████  TIPP-TEST
// ═══════════════════════════════════════════════════════════════
const _typingTexts = [
    'Der schnelle braune Fuchs springt über den faulen Hund. Packe jetzt zwölf Boxkämpfer und halte sie zurück.',
    'Technologie verändert die Welt schneller als je zuvor. Jeden Tag entstehen neue Innovationen die unser Leben revolutionieren.',
    'ehoser ist eine Plattform für Kreativität und Technologie. Hier findest du Tools die deinen Alltag einfacher machen.',
    'JavaScript ist eine der beliebtesten Programmiersprachen der Welt. Mit ihr lassen sich moderne Webanwendungen entwickeln.',
    'Musik ist die universelle Sprache der Menschheit. Sie verbindet Kulturen und Generationen auf der ganzen Welt.'
];
let _typingWords = [], _typingIdx = 0, _typingTimer = null, _typingSeconds = 60, _typingStarted = false, _typingCorrect = 0, _typingTotal = 0;
function typingReset() {
    clearInterval(_typingTimer);
    _typingStarted = false; _typingSeconds = 60; _typingIdx = 0; _typingCorrect = 0; _typingTotal = 0;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const text = _typingTexts[arr[0] % _typingTexts.length];
    _typingWords = text.split(' ');
    document.getElementById('typingTime').textContent = '60';
    document.getElementById('typingWPM').textContent = '0';
    document.getElementById('typingAcc').textContent = '100';
    document.getElementById('typingInput').value = '';
    document.getElementById('typingInput').disabled = false;
    document.getElementById('typingResult').textContent = '';
    typingRenderWords();
}
function typingRenderWords() {
    const el = document.getElementById('typingWords');
    el.innerHTML = _typingWords.map((w, i) => `<span class="tw${i === _typingIdx ? ' tw-cur' : (i < _typingIdx ? ' tw-done' : '')}">${escapeHtml(w)}</span>`).join(' ');
    const cur = el.querySelector('.tw-cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function typingCheck() {
    if (!_typingStarted) {
        _typingStarted = true;
        _typingTimer = setInterval(() => {
            _typingSeconds--;
            document.getElementById('typingTime').textContent = _typingSeconds;
            const elapsed = 60 - _typingSeconds;
            if (elapsed > 0) document.getElementById('typingWPM').textContent = Math.round(_typingCorrect / (elapsed / 60));
            if (_typingSeconds <= 0) {
                clearInterval(_typingTimer);
                document.getElementById('typingInput').disabled = true;
                const acc = _typingTotal ? Math.round(_typingCorrect / _typingTotal * 100) : 0;
                document.getElementById('typingResult').textContent = `Fertig! ${_typingCorrect} WPM · ${acc}% Genauigkeit`;
            }
        }, 1000);
    }
    const input = document.getElementById('typingInput').value;
    if (input.endsWith(' ') || input === _typingWords[_typingIdx]) {
        const typed = input.trim();
        _typingTotal++;
        if (typed === _typingWords[_typingIdx]) _typingCorrect++;
        _typingIdx++;
        document.getElementById('typingInput').value = '';
        if (_typingIdx >= _typingWords.length) {
            clearInterval(_typingTimer);
            document.getElementById('typingInput').disabled = true;
            const elapsed = Math.max(1, 60 - _typingSeconds);
            const acc = Math.round(_typingCorrect / _typingTotal * 100);
            document.getElementById('typingWPM').textContent = Math.round(_typingCorrect / (elapsed / 60));
            document.getElementById('typingResult').textContent = `🎉 Text abgeschlossen! ${Math.round(_typingCorrect / (elapsed / 60))} WPM · ${acc}% Genauigkeit`;
        }
        typingRenderWords();
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  KAMERA
// ═══════════════════════════════════════════════════════════════
let _cameraStream = null, _cameraFacing = 'user';
async function cameraStart() {
    if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
    try {
        _cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _cameraFacing }, audio: false });
        const video = document.getElementById('cameraVideo');
        video.srcObject = _cameraStream;
        document.getElementById('cameraCanvas').style.display = 'none';
        video.style.display = '';
        document.getElementById('cameraSaveBtn').style.display = 'none';
    } catch(e) {
        showAlert('Kamera konnte nicht gestartet werden: ' + e.message, 'error');
    }
}
function cameraFlip() {
    _cameraFacing = _cameraFacing === 'user' ? 'environment' : 'user';
    cameraStart();
}
function cameraSnap() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const filter = document.getElementById('cameraFilter').value;
    ctx.filter = filter || 'none';
    ctx.drawImage(video, 0, 0);
    canvas.style.display = '';
    video.style.display = 'none';
    document.getElementById('cameraSaveBtn').style.display = '';
}
function cameraApplyFilter() {
    const video = document.getElementById('cameraVideo');
    video.style.filter = document.getElementById('cameraFilter').value;
}
function cameraSave() {
    const canvas = document.getElementById('cameraCanvas');
    const a = document.createElement('a'); a.download = 'foto.png'; a.href = canvas.toDataURL(); a.click();
}

// ═══════════════════════════════════════════════════════════════
// ██████  COUNTDOWN
// ═══════════════════════════════════════════════════════════════
let _cdEventTimer = null;
function cdStart() {
    clearInterval(_cdEventTimer);
    const name = document.getElementById('cdEventName').value.trim() || 'Event';
    const target = new Date(document.getElementById('cdTargetDate').value).getTime();
    if (!target || isNaN(target)) { showAlert('Bitte ein gültiges Datum wählen.', 'error'); return; }
    document.getElementById('cdEventLabel').textContent = '⏳ bis ' + name;
    document.getElementById('cdTimerDisplay').style.display = '';
    const tick = () => {
        const diff = target - Date.now();
        if (diff <= 0) {
            clearInterval(_cdEventTimer);
            document.getElementById('cdTimerDisplay').innerHTML = '<span style="color:#38a169;font-size:2rem;">🎉 Jetzt!</span>';
            return;
        }
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        document.getElementById('cdTimerDisplay').innerHTML =
            `<span class="cd-unit"><strong>${d}</strong><small>Tage</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(h).padStart(2,'0')}</strong><small>Std</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(m).padStart(2,'0')}</strong><small>Min</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(s).padStart(2,'0')}</strong><small>Sek</small></span>`;
    };
    tick(); _cdEventTimer = setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════════════════════
// ██████  METRONOM
// ═══════════════════════════════════════════════════════════════
let _metroCtx = null, _metroRunning = false, _metroBeat = 0, _metroBeats = 4, _metroNext = 0, _metroWorker = null;
function metroInit() {
    metroRenderDots();
}
function metroUpdateBpm() {
    const bpm = document.getElementById('metroBpm').value;
    document.getElementById('metroBpmDisplay').textContent = bpm + ' BPM';
    if (_metroRunning) { metroStop(); metroStart(); }
}
function metroUpdateBeats() {
    _metroBeats = parseInt(document.getElementById('metroBeats').value);
    _metroBeat = 0;
    metroRenderDots();
}
function metroRenderDots() {
    const dots = document.getElementById('metroDots');
    dots.innerHTML = Array.from({length: _metroBeats}, (_, i) =>
        `<div class="metro-dot ${i === _metroBeat ? 'metro-dot-active' : ''}" id="metroDot${i}"></div>`).join('');
}
function metroToggle() {
    if (_metroRunning) metroStop(); else metroStart();
}
function metroStart() {
    _metroCtx = _metroCtx || new AudioContext();
    _metroRunning = true; _metroBeat = 0;
    document.getElementById('metroStartBtn').textContent = '⏹ Stop';
    const bpm = parseInt(document.getElementById('metroBpm').value);
    const interval = 60 / bpm * 1000;
    metroClick();
    _metroWorker = setInterval(() => {
        _metroBeat = (_metroBeat + 1) % _metroBeats;
        metroRenderDots();
        metroClick();
    }, interval);
}
function metroStop() {
    clearInterval(_metroWorker); _metroRunning = false;
    document.getElementById('metroStartBtn').textContent = '▶ Start';
}
function metroClick() {
    if (!_metroCtx) return;
    const osc = _metroCtx.createOscillator();
    const gain = _metroCtx.createGain();
    osc.connect(gain); gain.connect(_metroCtx.destination);
    osc.frequency.value = _metroBeat === 0 ? 1000 : 800;
    gain.gain.setValueAtTime(0.3, _metroCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _metroCtx.currentTime + 0.1);
    osc.start(_metroCtx.currentTime); osc.stop(_metroCtx.currentTime + 0.1);
}