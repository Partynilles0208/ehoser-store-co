const API_BASE = `${window.location.origin}/api`;
let currentUser = null;
let allApps = [];
let currentCategory = 'all';
let resetRequestId = null;
let resetLookupToken = null;
let resetToken = null;
let resetPollInterval = null;

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
    const loginCode = document.getElementById('loginCode').value.trim();

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, loginCode, unlockCode })
        });

        const data = await response.json();

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Anmeldung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        showAlert('Erfolgreich angemeldet!', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('store');
        startOnlinePolling();
        document.getElementById('loginForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
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

        if (!response.ok) {
            localStorage.removeItem('token');
            showSection('mode-select');
            return;
        }

        const data = await response.json();
        currentUser = data.user;
        showLoggedInUI();
        await loadApps();
        showSection('store');
        startOnlinePolling();
    } catch (err) {
        localStorage.removeItem('token');
        showSection('mode-select');
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const unlockCode = document.getElementById('unlockCode').value.trim();
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();

    try {
        const response = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unlockCode, username, email })
        });

        const data = await response.json();

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Registrierung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        window.alert(`Dein Login-Code: ${data.loginCode}\nDiesen Code sicher speichern. Du brauchst ihn fuer jede Anmeldung.`);
        showAlert('Willkommen bei ehoser.', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('store');
        startOnlinePolling();
        document.getElementById('registerForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

function showLoggedInUI() {
    const navLinks = document.getElementById('navLinks');
    const adminLabel = currentUser?.isAdmin ? 'Admin' : 'App hochladen';
    navLinks.innerHTML = `
        <a href="#" onclick="showSection('store')" class="nav-link">Store</a>
        <a href="#" onclick="showSection('my-apps')" class="nav-link">Meine Apps</a>
        <a href="admin.html" class="nav-link">${adminLabel}</a>
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
    if (sectionId === 'my-apps') {
        loadMyApps();
    }
    if (sectionId === 'games') {
        if (!gamesAllLoaded.length) loadGames();
    }
}

function selectMode(mode) {
    if (mode === 'store') {
        showSection('auth');
    } else if (mode === 'games') {
        showSection('games');
    } else if (mode === 'facewarp') {
        window.location.href = '/facewarp/';
    } else {
        showSection('mode-select');
    }
}

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
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
}

function stopOnlinePolling() {
    clearInterval(onlineInterval);
    clearInterval(heartbeatInterval);
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

function openGame(url, title) {
    if (!url) return;
    document.getElementById('gameFrame').src = url;
    document.getElementById('gameModalTitle').textContent = title;
    document.getElementById('gameModal').classList.add('show');
}

function closeGameModal() {
    document.getElementById('gameFrame').src = '';
    document.getElementById('gameModal').classList.remove('show');
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
