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

function switchAuthTab(tab, btn) {
    document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
    if (tab !== 'login') {
        document.getElementById('helpRequestForm').style.display = 'none';
        document.getElementById('resetCompleteForm').style.display = 'none';
    }
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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
        startOnlinePolling();
        document.getElementById('loginForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Splash Screen nach Animation entfernen (21s Gesamt + 0.5s Puffer)
    const splash = document.getElementById('introSplash');
    if (splash) {
        setTimeout(() => {
            splash.remove();
            document.body.classList.remove('splash-active');
            document.body.style.overflow = '';
        }, 21500);
    }

    const ref = new URLSearchParams(window.location.search).get('ref');
    pendingReferral = ref || localStorage.getItem('pendingReferralCode') || null;
    if (pendingReferral) {
        localStorage.setItem('pendingReferralCode', pendingReferral);
        const referralInput = document.getElementById('referralCode');
        if (referralInput) referralInput.value = pendingReferral;
    }

    const token = localStorage.getItem('token');
    if (token) {
        verifyToken(token);
        return;
    }
    showSection('mode-select');
});

async function verifyToken(token) {
    try {
        const response = await fetch(`${API_BASE}/verify-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });

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
    navLinks.innerHTML = `
        <a href="#" onclick="showSection('store')" class="nav-link">Store</a>
        <a href="#" onclick="showSection('my-apps')" class="nav-link">Meine Apps</a>
        <a href="admin.html" class="nav-link">${adminLabel}</a>
        <button onclick="openSettingsModal()" class="btn-small" style="width:auto;padding:8px 12px;">Einstellungen</button>
        <span class="plan-badge ${currentProfile?.isPro ? 'pro' : ''}">${plan}</span>
        <span class="hello-user">Hallo, ${escapeHtml(currentUser.username)}.</span>
        <button onclick="logout()" class="logout-btn">Abmelden</button>
    `;
}

async function loadApps() {
    try {
        const response = await fetch(`${API_BASE}/apps`);
        const apps = await response.json();
        allApps = Array.isArray(apps) ? apps : [];
        displayApps(allApps);
    } catch (err) {
        showAlert('Apps konnten nicht geladen werden.', 'error');
    }
}

function displayApps(apps) {
    const appsList = document.getElementById('appsList');

    if (!apps.length) {
        appsList.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <h3>Keine Apps gefunden</h3>
                <p>Versuche eine andere Suche oder Kategorie.</p>
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

    displayApps(filtered);
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
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/unlock-code`);
        const data = await res.json();
        _unlockCode = data.code;
        document.getElementById('unlockCodeDisplay').textContent = _unlockCode;
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
        showSection('auth');
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
    } else if (mode === 'facewarp') {
        openFacewarpModeModal();
    } else if (mode === 'chat') {
        window.location.href = '/chat/';
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
    if (!settings) return;

    document.documentElement.dataset.design = settings.design || 'standard';
    if (settings.energySaver) {
        document.body.classList.add('energy-saver');
    } else {
        document.body.classList.remove('energy-saver');
    }
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
}

async function saveAccountSettings() {
    const token = localStorage.getItem('token');
    if (!token) return;

    const payload = {
        language: document.getElementById('settingLanguage').value,
        design: document.getElementById('settingDesign').value,
        energySaver: document.getElementById('settingEnergySaver').checked
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

// ─── Online Spiele ────────────────────────────────────────────────────────────
let gamesAllLoaded = [];
let gamesFiltered = [];
let gamesCurrentPage = 1;
let gamesCurrentCategory = 'all';
let gamesSearchText = '';

// ─── Game Timer Variablen (15min Limit für Gratis) ─────────────────────────
let _gameTimerInterval = null;
let _gameSecondsLeft = 0;
let _gameStartTime = null;
let _gameLimitSeconds = 900; // 15 Min = 900 Sekunden für Gratis

async function loadGames() {
    const grid = document.getElementById('gamesGrid');
    grid.innerHTML = '<div class="games-loading">Spiele werden geladen…</div>';

    try {
        const res = await fetch(`${API_BASE}/games?page=${gamesCurrentPage}`);
        if (!res.ok) throw new Error('Feed nicht verfügbar');
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
                <div class="game-play-overlay">▶</div>
            </div>
            <div class="game-info">
                <h3 class="game-title">${title}</h3>
                ${category ? `<span class="game-category">${category}</span>` : ''}
                <p class="game-desc">${desc}${(g.description || '').length > 120 ? '…' : ''}</p>
                <div class="game-tags">${tags}</div>
            </div>
        </article>`;
    }).join('');
}

function _formatGameTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
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
        alert('⏱️ Deine 15 Minuten sind vorbei! Jetzt Vollzugang freischalten für unbegrenzte Spielzeit.');
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
    
    // Wenn kein Pro → Timer starten (15 Min)
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
    // Zurück zu Spieleauswahl
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

// ─── Bildschirmübertragung (Nutzer = Sharer / WebRTC Answerer) ────────────────
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

        // Video-Track hinzufügen
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

