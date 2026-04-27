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
        // GSI script noch nicht geladen (async), nach kurzer Verz�gerung erneut versuchen
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

    // Config noch nicht geladen � kurz warten und neu pr�fen
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
    const defaultTitle = 'Ehoser � Offizielle Website';
    const defaultSubtitle = 'Willkommen auf der offiziellen Website von Ehoser. Hier findest du exklusive Apps im APK Store, kostenlose Online-Spiele, KI-Tools, den Face-Warp-Editor und vieles mehr � alles an einem Ort, entwickelt von Nils Becker.';

    document.body.dataset.personalizationTone = personalization?.tone || 'neutral';
    document.body.dataset.personalizationLayout = personalization?.layout || 'standard';
    document.body.dataset.personalizationPrimaryMode = personalization?.highlightModes?.[0] || 'default';
    document.body.classList.toggle('personalized-ui', Boolean(personalization));

    if (titleEl) {
        titleEl.textContent = currentUser ? `Ehoser f�r ${currentUser.username}` : defaultTitle;
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
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

// -- reCAPTCHA entfernt � Vote-Screen oder direkt starten ---------------------
function showCaptcha() {
    applyUpdateFeatures(true);
    startApp();
    startRepoUpdatePolling();
}

// -- Update-Abstimmung ---------------------------------------------------------
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
                if (voteMsg) voteMsg.textContent = 'Bitte anmelden um abstimmen zu k�nnen.';
            } else if (myVote) {
                voteBtn.disabled = true;
                voteBtn.style.opacity = '0.5';
                voteBtn.textContent = '? Bereits abgestimmt';
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

    // Polling alle 5s � wenn 10 erreicht: alle Seiten refreshen
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
    if (btn) { btn.disabled = true; btn.textContent = '? Abstimmen�'; }

    try {
        const res = await fetch(`${API_BASE}/vote`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) {
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '? Bereits abgestimmt'; }
            if (msg) msg.textContent = data.error || 'Fehler.';
            return;
        }
        if (btn) { btn.textContent = '? Stimme gez�hlt!'; btn.style.background = 'linear-gradient(135deg,#1a7a3a,#2dbe6c)'; }
        if (msg) msg.textContent = `${data.count} von 10 Stimmen � danke!`;
        loadVoteStatus();

        if (data.unlocked) {
            if (msg) msg.textContent = '?? Update freigeschaltet! Du kannst es jetzt laden.';
        }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = '??? F�r Update abstimmen'; }
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

            // 15.6s: Finaler Blitz ist am Peak ? Splash weg, Seite erscheint sofort
            setTimeout(() => {
                splash.remove();
                document.body.classList.remove('splash-active');
                document.body.style.overflow = '';
                sessionStorage.setItem('intro_shown', '1');
                // Wei�es Body-Overlay f�r den Blitz-�bergang
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
            // Token abgelaufen/ungültig – Token NICHT löschen!
            // User kann sich erneut anmelden → Token wird dann überschrieben
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
        // 🔥 Pro-Status in localStorage speichern für FaceWarp/Chat
        localStorage.setItem('proStatus', currentProfile?.isPro ? '1' : '0');
        applyProfileSettings();
        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
    } catch (err) {
        // Netzwerkfehler: Token NICHT löschen, Seite trotzdem zeigen
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
        showAlert('Passwörter stimmen nicht überein.', 'error');
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
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
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
        return '<span class="emoji-icon">📱</span>';
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
        document.getElementById('unlockCodeDisplay').textContent = '–';
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
    btn.textContent = '✓ Kopiert!';
    btn.classList.add('copied');
    setTimeout(() => {
        btn.textContent = '📋 Kopieren';
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
        // Registrierung nötig
        const token = localStorage.getItem('token');
        if (!token) {
            showAlert('Bitte zuerst anmelden, um ehoser KI zu nutzen.', 'error');
            showSection('auth');
            return;
        }
        showSection('ki');
        // Name bereits bekannt → direkt Chat öffnen, sonst Modal zeigen
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



// WMO Wetter-Code → Emoji + Beschreibung (Open-Meteo)
function weatherCodeInfo(code) {
    const map = {
        0:  ['☀️', 'Klarer Himmel'],
        1:  ['🌤️', 'Überwiegend klar'],
        2:  ['⛅', 'Teilweise bewölkt'],
        3:  ['☁️', 'Bedeckt'],
        45: ['🌫️', 'Nebel'],
        48: ['🌫️', 'Gefrierender Nebel'],
        51: ['🌦️', 'Leichter Nieselregen'],
        53: ['🌦️', 'Nieselregen'],
        55: ['🌧️', 'Starker Nieselregen'],
        61: ['🌧️', 'Leichter Regen'],
        63: ['🌧️', 'Regen'],
        65: ['🌧️', 'Starker Regen'],
        71: ['🌨️', 'Leichter Schneefall'],
        73: ['🌨️', 'Schneefall'],
        75: ['❄️', 'Starker Schneefall'],
        77: ['🌨️', 'Schneekörner'],
        80: ['🌦️', 'Leichte Schauer'],
        81: ['🌧️', 'Schauer'],
        82: ['⛈️', 'Starke Schauer'],
        85: ['🌨️', 'Schneeschauer'],
        86: ['❄️', 'Starke Schneeschauer'],
        95: ['⛈️', 'Gewitter'],
        96: ['⛈️', 'Gewitter mit Hagel'],
        99: ['⛈️', 'Gewitter mit starkem Hagel'],
    };
    return map[code] || ['🌡️', `Wetter-Code ${code}`];
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

    status.textContent = 'Suche Ort…';
    result.innerHTML = '';

    try {
        // 1. Geocoding (kein API Key nötig)
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de&format=json`);
        const geoData = await geoRes.json();

        if (!geoData.results?.length) {
            status.textContent = `Ort „${city}" nicht gefunden.`;
            return;
        }

        const { latitude, longitude, name, country, admin1 } = geoData.results[0];
        status.textContent = 'Lade Wetterdaten…';

        // 2. Wetterdaten (kein API Key nötig)
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
        const visKm     = cur.visibility != null ? `${Math.round(cur.visibility / 1000)} km` : '–';
        const [icon, desc] = weatherCodeInfo(cur.weather_code);
        const location  = [name, admin1, country].filter(Boolean).join(', ');

        result.innerHTML = `
            <div class="weather-card">
                <div class="weather-card-city">${escapeHtml(name)}</div>
                <div class="weather-card-country">${escapeHtml([admin1, country].filter(Boolean).join(', '))}</div>
                <div class="weather-card-icon" style="font-size:5rem;line-height:1">${icon}</div>
                <div class="weather-card-desc">${escapeHtml(desc)}</div>
                <div class="weather-card-temp">${temp}°C</div>
                <div class="weather-card-feels">Gefühlt wie ${feels}°C</div>
                <div class="weather-card-stats">
                    <div class="weather-stat">
                        <span class="weather-stat-label">💧 Luftfeucht.</span>
                        <span class="weather-stat-value">${humidity}%</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">💨 Wind</span>
                        <span class="weather-stat-value">${wind} km/h</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">👁️ Sichtweite</span>
                        <span class="weather-stat-value">${visKm}</span>
                    </div>
                </div>
            </div>`;
    } catch (err) {
        status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.';
    }
}

// ─── Karte (Leaflet + OpenStreetMap + Nominatim) ──────────────────────────────
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
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    });
    _mapSatLayer = window.L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri',
        maxZoom: 19
    });
    _mapNormalLayer.addTo(_map);

    // Dropdown schließen bei Klick auf Karte
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

// Dropdown schließen bei Klick außerhalb
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

// ─── YouTube (YouTube Data API v3) ────────────────────────────────────────────
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
    if (status) status.textContent = 'Suche läuft…';
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
                ${_ytPrevPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytPrevPageToken}')">← Zurück</button>` : ''}
                ${_ytNextPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytNextPageToken}')">Weiter →</button>` : ''}
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
        badge = '▶ Video';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">▶</div></div>`;
    } else if (kind === 'youtube#playlist') {
        id = item.id.playlistId;
        onclickAttr = `openYTPlayer('${id}', this.querySelector('.yt-card-title').textContent, 'playlist')`;
        badge = '📋 Playlist';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">▶</div></div>`;
    } else {
        id = item.id.channelId;
        onclickAttr = `window.open('https://www.youtube.com/channel/${id}','_blank')`;
        badge = '📺 Kanal';
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

// ─── KI Chat (Groq – Llama 3.3 70B) ──────────────────────────────────────────
// API Key liegt serverseitig in GROQ_API_KEY (Vercel Environment Variable)
let _kiHistory = []; // { role: 'user'|'assistant'|'system', content: string }
let _kiAttachment = null; // { type: 'image'|'text', data: string, name: string }

const KI_SYSTEM_PROMPT = `Du bist ehoser KI, ein freundlicher und sympathischer KI-Assistent, der exklusiv auf den Servern von ehoser läuft. ehoser ist eine private Plattform mit APK Store, Spielen, Chat und weiteren Features.
Deine Persönlichkeit ist locker, nett und ein kleines bisschen charmant – aber nicht übertrieben. Keine Kosenamen wie "Schatz" oder "Süße". Sprich den Nutzer normal aber herzlich an.
Wenn du den Nutzer persönlich ansprechen möchtest, schreibe ausschließlich [name] anstelle des echten Namens (zum Beispiel: "Hey [name], wie kann ich helfen?"). Verwende niemals den echten Namen direkt.
Antworte IMMER ausschließlich auf Deutsch, egal in welcher Sprache der Nutzer schreibt. Keine Ausnahmen.
Halte deine Antworten kurz und knapp – maximal 3-4 Sätze.
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

    // Anhang-Button nur für PRO sichtbar
    const attachBtn = document.getElementById('kiAttachBtn');
    if (attachBtn) attachBtn.style.display = localStorage.getItem('proStatus') === '1' ? 'flex' : 'none';

    // Nur beim ersten Mal initialisieren
    if (_kiHistory.length === 0) {
        _kiHistory = [{ role: 'system', content: KI_SYSTEM_PROMPT }];
        const greeting = kiReplaceNamePlaceholder(`Hallo, [name]! 👋 Ich bin ehoser KI, dein persönlicher Assistent auf dem ehoser Server. Wie kann ich dir heute helfen?`);
        appendKIBubble('ai', greeting);
    }
    setTimeout(() => document.getElementById('kiInput')?.focus(), 50);
}

function kiHandleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        showAlert('Datei zu groß (max. 4 MB).', 'error');
        event.target.value = '';
        return;
    }
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onload = (e) => {
        _kiAttachment = { type: isImage ? 'image' : 'text', data: e.target.result, name: file.name };
        document.getElementById('kiAttachPreview').style.display = 'flex';
        document.getElementById('kiAttachName').textContent = '📎 ' + file.name;
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
    // Direkt von Pollinations laden � kein Backend-Proxy, kein Vercel-Timeout
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

    // ── Nachricht aufbauen ──────────────────────────────────────
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
        historyMsg = { role: 'user', content: `[Bild: ${_kiAttachment.name}]${text ? ' – ' + text : ''}` };
    } else if (_kiAttachment?.type === 'text') {
        const combined = `Dateiinhalt (${_kiAttachment.name}):\n\`\`\`\n${_kiAttachment.data.slice(0, 8000)}\n\`\`\`${text ? '\n\n' + text : ''}`;
        // Zeige Datei-Badge + Text im Chat
        const msgEl = document.getElementById('kiMessages');
        if (msgEl) {
            const bubble = document.createElement('div');
            bubble.className = 'ki-bubble ki-bubble-user';
            const badge = document.createElement('div');
            badge.className = 'ki-bubble-file-badge';
            badge.textContent = '📄 ' + _kiAttachment.name;
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
            appendKIBubble('error', '⚠️ ' + msg);
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
        appendKIBubble('error', '⚠️ Verbindungsfehler. Bitte versuche es erneut.');
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
    appendKIBubble('ai', kiReplaceNamePlaceholder('Verlauf geleert. 👋 Womit kann ich dir helfen, [name]?'));
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
    status.textContent = 'Suche läuft...';
    if (grid) grid.innerHTML = '<div class="games-loading">Bilder werden geladen…</div>';

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
        status.textContent = `${hits.length} Treffer für "${q}"`;
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
        codeDisplay.textContent = '••••••';
        codeDisplay.dataset.revealed = 'false';
    }
    const toggleBtn = document.getElementById('toggleCodeBtn');
    if (toggleBtn) toggleBtn.textContent = '👁 Anzeigen';
    fetchLoginCode();
    updatePlanBadge();
    // Aktuelle E-Mail laden
    const emailDisplay = document.getElementById('emailCurrentDisplay');
    if (emailDisplay) {
        fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(r => r.json())
            .then(d => {
                const mail = d.user?.email || null;
                emailDisplay.textContent = mail ? `Verkn�pft: ${mail}` : 'Noch keine E-Mail verkn�pft.';
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
            codeDisplay.textContent = _cachedLoginCode || '–';
        }
    } catch {}
}

function toggleShowLoginCode() {
    const codeDisplay = document.getElementById('myLoginCodeDisplay');
    const btn = document.getElementById('toggleCodeBtn');
    if (!codeDisplay) return;
    if (codeDisplay.dataset.revealed === 'true') {
        codeDisplay.textContent = '••••••';
        codeDisplay.dataset.revealed = 'false';
        if (btn) btn.textContent = '👁 Anzeigen';
    } else {
        if (_cachedLoginCode) {
            codeDisplay.textContent = _cachedLoginCode;
            codeDisplay.dataset.revealed = 'true';
            if (btn) btn.textContent = '🙈 Verbergen';
        } else {
            fetchLoginCode().then(() => {
                if (_cachedLoginCode) {
                    codeDisplay.textContent = _cachedLoginCode;
                    codeDisplay.dataset.revealed = 'true';
                    if (btn) btn.textContent = '🙈 Verbergen';
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
    // E-Mail-Eingaben beim Schlie�en zur�cksetzen
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

// --- Inline Chat --------------------------------------------------------------
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
            list.innerHTML = '<div class="chat-loading" style="color:#6a9bb8;font-size:0.9rem;padding:16px;">Noch keine Gespr�che.<br>Suche einen Nutzer oben.</div>';
            return;
        }
        list.innerHTML = _chatGroups.map(g => `
            <button class="chat-group-item" onclick="openChatGroup('${escapeAttribute(g.id)}','${escapeAttribute(g.name)}')">
                <div class="chat-group-avatar">${escapeHtml(g.name.charAt(0).toUpperCase())}</div>
                <div class="chat-group-info">
                    <div class="chat-group-name">${escapeHtml(g.name)}</div>
                    <div class="chat-group-sub">Tippen zum �ffnen</div>
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

    // Schauen ob bereits Gespr�ch existiert
    const existing = _chatGroups.find(g => g.name === targetUsername || g.name === currentUser?.username + ' & ' + targetUsername || g.name === targetUsername + ' & ' + currentUser?.username);
    if (existing) {
        openChatGroup(existing.id, existing.name);
        return;
    }

    // Neues Gespr�ch erstellen
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
            showAlert(data.error || 'Gespr�ch konnte nicht erstellt werden.', 'error');
            return;
        }
        await chatLoadGroups();
        openChatGroup(data.id, data.name);
    } catch {
        showAlert('Netzwerkfehler beim Erstellen des Gespr�chs.', 'error');
    }
}

function openChatGroup(groupId, groupName) {
    _chatCurrentGroupId = groupId;
    _chatCurrentGroupName = groupName;
    _chatLastMsgId = 0;
    document.getElementById('chatEmptyState').style.display = 'none';
    document.getElementById('chatConv').style.display = 'flex';
    document.getElementById('chatConvName').textContent = groupName;
    document.getElementById('chatConvStatus').textContent = '? Online';
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
            const initial = (m.sender || '?')[0].toUpperCase();
            div.innerHTML = `
                <div class="chat-msg-avatar">${initial}</div>
                <div class="chat-msg-body">
                    <div class="chat-msg-sender">
                        ${escapeHtml(m.sender)}
                        <span class="chat-msg-time-inline">${time}</span>
                    </div>
                    <div class="chat-msg-bubble">${escapeHtml(m.encrypted_content)}</div>
                </div>
            `;
            container.appendChild(div);
        });
