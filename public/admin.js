let activeAdminCode = null;

const accessForm = document.getElementById('adminAccessForm');
const secureArea = document.getElementById('adminSecureArea');
const form = document.getElementById('uploadForm');
const statusBox = document.getElementById('uploadStatus');
const usersList = document.getElementById('registeredUsersList');
const resetRequestsList = document.getElementById('resetRequestsList');
let adminRefreshInterval = null;

accessForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = document.getElementById('adminJoinCode').value.trim();
    if (!code) return;

    try {
        const res = await fetch(`${window.location.origin}/api/admin/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': code }
        });
        if (!res.ok) {
            setStatus('Falscher Admin-Code.', 'error');
            return;
        }

        activeAdminCode = code;
        secureArea.style.display = '';
        setStatus('Admin-Bereich freigeschaltet.', 'success');
        await Promise.all([loadRegisteredUsers(), loadResetRequests(), loadAdminApps()]);
        clearInterval(adminRefreshInterval);
        adminRefreshInterval = setInterval(() => {
            loadRegisteredUsers();
            loadResetRequests();
            loadAdminApps();
        }, 8000);
    } catch (err) {
        setStatus('Verbindungsfehler.', 'error');
    }
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('', '');

    if (!activeAdminCode) {
        setStatus('Bitte zuerst den Admin-Code eingeben.', 'error');
        return;
    }

    const name = document.getElementById('name').value.trim();
    const version = document.getElementById('version').value.trim();
    const category = document.getElementById('category').value;
    const description = document.getElementById('description').value.trim();
    const sourceUrl = document.getElementById('sourceUrl').value.trim();
    const iconFile = document.getElementById('icon').files[0];
    const apkFile = document.getElementById('apk').files[0];

    if (!iconFile || !apkFile) {
        setStatus('Bitte Icon und APK auswählen.', 'error');
        return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Wird hochgeladen...';

    try {
        setStatus('Schritt 1/3: Upload-URLs werden erstellt...', 'info');
        const urlResponse = await fetch(`${window.location.origin}/api/admin/upload-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': activeAdminCode
            },
            body: JSON.stringify({ iconName: iconFile.name, apkName: apkFile.name })
        });

        const urls = await urlResponse.json();
        if (!urlResponse.ok) {
            setStatus(`Fehler: ${urls.error || 'Upload-URLs konnten nicht erstellt werden.'}`, 'error');
            return;
        }

        setStatus('Schritt 2/3: Dateien werden direkt zu Supabase hochgeladen...', 'info');
        const iconUpload = await fetch(urls.icon.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': iconFile.type || 'application/octet-stream' },
            body: iconFile
        });

        if (!iconUpload.ok) {
            setStatus('Icon-Upload fehlgeschlagen.', 'error');
            return;
        }

        const apkUpload = await fetch(urls.apk.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: apkFile
        });

        if (!apkUpload.ok) {
            setStatus('APK-Upload fehlgeschlagen.', 'error');
            return;
        }

        setStatus('Schritt 3/3: App wird gespeichert...', 'info');
        const saveResponse = await fetch(`${window.location.origin}/api/admin/apps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': activeAdminCode
            },
            body: JSON.stringify({
                name,
                version,
                category,
                description,
                sourceUrl,
                iconUrl: urls.icon.publicUrl,
                downloadUrl: urls.apk.publicUrl
            })
        });

        const data = await saveResponse.json();
        if (!saveResponse.ok) {
            setStatus(`Fehler: ${data.error || 'Speichern fehlgeschlagen.'}`, 'error');
            return;
        }

        setStatus('App erfolgreich hochgeladen und gespeichert!', 'success');
        form.reset();
        await loadRegisteredUsers();
    } catch (error) {
        setStatus(`Fehler: ${error.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'App veroeffentlichen';
    }
});

async function loadRegisteredUsers() {
    if (!activeAdminCode) return;

    try {
        const response = await fetch(`${window.location.origin}/api/admin/users`, {
            headers: { 'x-admin-key': activeAdminCode }
        });

        const users = await response.json();
        if (!response.ok) {
            setStatus(users.error || 'Nutzer konnten nicht geladen werden.', 'error');
            return;
        }

        if (!users.length) {
            usersList.innerHTML = '<li>Noch keine Nutzer registriert.</li>';
            return;
        }

        usersList.innerHTML = users
            .map(
                (user) => `
                <li style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                    <span>${escapeHtml(user.username)} ${user.is_pro ? '<strong style="color:#b45309">PRO</strong>' : ''}</span>
                    <span style="display:flex;gap:6px;">
                        <button class="btn-small" onclick="toggleUserPro(${user.id}, ${user.is_pro ? 'false' : 'true'})">${user.is_pro ? 'PRO entfernen' : 'PRO geben'}</button>
                        <button class="btn-small" onclick="requestScreenShare('${escapeJs(user.username)}')">🖥️ Bildschirm</button>
                        <button class="btn-small" onclick="deleteUser(${user.id}, '${escapeJs(user.username)}')">Loeschen</button>
                    </span>
                </li>`
            )
            .join('');
    } catch (error) {
        setStatus(`Fehler beim Laden der Nutzer: ${error.message}`, 'error');
    }
}

async function toggleUserPro(userId, enabled) {
    if (!activeAdminCode) return;
    try {
        const response = await fetch(`${window.location.origin}/api/admin/users/${userId}/pro`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': activeAdminCode
            },
            body: JSON.stringify({ enabled, days: 2 })
        });
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Pro-Status konnte nicht geändert werden.', 'error');
            return;
        }
        setStatus(enabled ? 'PRO wurde aktiviert.' : 'PRO wurde entfernt.', 'success');
        await loadRegisteredUsers();
    } catch (error) {
        setStatus(`Fehler bei PRO-Update: ${error.message}`, 'error');
    }
}

async function loadResetRequests() {
    if (!activeAdminCode) return;

    try {
        const response = await fetch(`${window.location.origin}/api/admin/reset-requests`, {
            headers: { 'x-admin-key': activeAdminCode }
        });

        const requests = await response.json();
        if (!response.ok) {
            setStatus(requests.error || 'Reset-Anfragen konnten nicht geladen werden.', 'error');
            return;
        }

        if (!requests.length) {
            resetRequestsList.innerHTML = '<li>Keine offenen Anfragen.</li>';
            return;
        }

        resetRequestsList.innerHTML = requests
            .map(
                (item) => `
                <li style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                    <span>${escapeHtml(item.username)}</span>
                    <span style="display:flex;gap:6px;">
                        <button class="btn-small" onclick="approveResetRequest(${item.id}, '${escapeJs(item.username)}')">Annehmen</button>
                        <button class="btn-small" onclick="rejectResetRequest(${item.id}, '${escapeJs(item.username)}')">Ablehnen</button>
                    </span>
                </li>`
            )
            .join('');
    } catch (error) {
        setStatus(`Fehler beim Laden der Anfragen: ${error.message}`, 'error');
    }
}

async function deleteUser(userId, username) {
    if (!activeAdminCode) {
        setStatus('Bitte zuerst den Admin-Code eingeben.', 'error');
        return;
    }

    const confirmed = window.confirm(`Nutzer "${username}" wirklich loeschen?`);
    if (!confirmed) {
        return;
    }

    try {
        const response = await fetch(`${window.location.origin}/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: { 'x-admin-key': activeAdminCode }
        });

        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Nutzer konnte nicht geloescht werden.', 'error');
            return;
        }

        setStatus(`Nutzer ${username} wurde geloescht.`, 'success');
        await Promise.all([loadRegisteredUsers(), loadResetRequests()]);
    } catch (error) {
        setStatus(`Fehler beim Loeschen: ${error.message}`, 'error');
    }
}

async function approveResetRequest(requestId, username) {
    try {
        const response = await fetch(`${window.location.origin}/api/admin/reset-requests/${requestId}/approve`, {
            method: 'POST',
            headers: { 'x-admin-key': activeAdminCode }
        });
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Anfrage konnte nicht angenommen werden.', 'error');
            return;
        }
        setStatus(`Reset fuer ${username} angenommen.`, 'success');
        await loadResetRequests();
    } catch (error) {
        setStatus(`Fehler beim Annehmen: ${error.message}`, 'error');
    }
}

async function rejectResetRequest(requestId, username) {
    try {
        const response = await fetch(`${window.location.origin}/api/admin/reset-requests/${requestId}/reject`, {
            method: 'POST',
            headers: { 'x-admin-key': activeAdminCode }
        });
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Anfrage konnte nicht abgelehnt werden.', 'error');
            return;
        }
        setStatus(`Reset fuer ${username} abgelehnt.`, 'success');
        await loadResetRequests();
    } catch (error) {
        setStatus(`Fehler beim Ablehnen: ${error.message}`, 'error');
    }
}

function setStatus(message, type) {
    statusBox.innerHTML = '';
    if (!message) return;
    const node = document.createElement('div');
    node.className = `alert alert-${type}`;
    node.textContent = message;
    statusBox.appendChild(node);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJs(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ─── Apps verwalten ───────────────────────────────────────────────────────────
async function loadAdminApps() {
    if (!activeAdminCode) return;
    const list = document.getElementById('adminAppsList');
    if (!list) return;
    list.innerHTML = '<li style="color:var(--muted)">Lade Apps…</li>';

    try {
        const res = await fetch(`${window.location.origin}/api/apps`);
        if (!res.ok) throw new Error('Apps konnten nicht geladen werden');
        const apps = await res.json();

        if (!apps.length) {
            list.innerHTML = '<li style="color:var(--muted)">Keine Apps im Store.</li>';
            return;
        }

        list.innerHTML = apps.map(app => `
            <li style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                <span style="display:flex;align-items:center;gap:8px;">
                    ${app.icon_url ? `<img src="${escapeHtml(app.icon_url)}" alt="" style="width:28px;height:28px;border-radius:6px;object-fit:cover;">` : ''}
                    <span>${escapeHtml(app.name)} <span style="color:var(--muted);font-size:0.8em">v${escapeHtml(app.version || '?')} · ${escapeHtml(app.category || '')}</span></span>
                </span>
                <button class="btn-small" style="background:#7f1d1d;color:#fff;" onclick="deleteApp(${app.id}, '${escapeJs(app.name)}')">Entfernen</button>
            </li>`).join('');
    } catch (err) {
        if (list) list.innerHTML = `<li style="color:var(--muted)">Fehler: ${escapeHtml(err.message)}</li>`;
    }
}

async function deleteApp(appId, appName) {
    if (!activeAdminCode) return;
    if (!confirm(`App "${appName}" wirklich aus dem Store entfernen?`)) return;

    try {
        const res = await fetch(`${window.location.origin}/api/admin/apps/${appId}`, {
            method: 'DELETE',
            headers: { 'x-admin-key': activeAdminCode }
        });
        const data = await res.json();
        if (!res.ok) {
            setStatus(data.error || 'App konnte nicht entfernt werden.', 'error');
            return;
        }
        setStatus(`App "${appName}" wurde entfernt.`, 'success');
        await loadAdminApps();
    } catch (err) {
        setStatus(`Fehler: ${err.message}`, 'error');
    }
}

// ─── VirusTotal Scan ──────────────────────────────────────────────────────────
async function loadAppsForScan() {
    const list = document.getElementById('vtAppsList');
    list.innerHTML = '<li style="color:var(--muted)">Lade Apps…</li>';

    try {
        const res = await fetch(`${window.location.origin}/api/apps`);
        if (!res.ok) throw new Error('Apps konnten nicht geladen werden');
        const apps = await res.json();

        if (!apps.length) {
            list.innerHTML = '<li style="color:var(--muted)">Keine Apps im Store.</li>';
            return;
        }

        list.innerHTML = apps.map(app => `
            <li class="vt-app-item" id="vt-app-${app.id}">
                <div class="vt-app-info">
                    <strong>${escapeHtml(app.name)}</strong>
                    <span class="vt-app-version">v${escapeHtml(app.version || '?')}</span>
                </div>
                <div class="vt-app-actions">
                    ${app.download_url ? `<button class="btn-small vt-btn" onclick="vtScanUrl('${escapeJs(app.download_url)}', 'apk', ${app.id})">APK scannen</button>` : '<span style="color:var(--muted);font-size:0.8rem">Kein APK</span>'}
                    ${app.source_url ? `<button class="btn-small vt-btn" onclick="vtScanUrl('${escapeJs(app.source_url)}', 'url', ${app.id})">Quell-URL scannen</button>` : ''}
                </div>
                <div id="vt-result-${app.id}" class="vt-result-area"></div>
            </li>
        `).join('');
    } catch (err) {
        list.innerHTML = `<li style="color:var(--danger)">${escapeHtml(err.message)}</li>`;
    }
}

async function vtScanUrl(url, type, appId) {
    const resultArea = document.getElementById(`vt-result-${appId}`);
    resultArea.innerHTML = '<span class="vt-badge vt-scanning">⏳ Wird eingereicht…</span>';

    try {
        const res = await fetch(`${window.location.origin}/api/admin/vt-scan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': activeAdminCode
            },
            body: JSON.stringify({ url })
        });

        const data = await res.json();
        if (!res.ok) {
            resultArea.innerHTML = `<span class="vt-badge vt-error">❌ ${escapeHtml(data.error || 'Fehler')}</span>`;
            return;
        }

        resultArea.innerHTML = '<span class="vt-badge vt-scanning">🔍 Wird gescannt… (bis 30 Sek.)</span>';
        await pollVtResult(data.analysisId, resultArea, 0);
    } catch (err) {
        resultArea.innerHTML = `<span class="vt-badge vt-error">❌ ${escapeHtml(err.message)}</span>`;
    }
}

async function pollVtResult(analysisId, resultArea, attempt) {
    if (attempt >= 10) {
        resultArea.innerHTML = '<span class="vt-badge vt-timeout">⏱ Timeout – VT Analyse läuft noch. Später erneut versuchen.</span>';
        return;
    }

    await new Promise(r => setTimeout(r, 3000));

    try {
        const res = await fetch(`${window.location.origin}/api/admin/vt-result/${encodeURIComponent(analysisId)}`, {
            headers: { 'x-admin-key': activeAdminCode }
        });

        const data = await res.json();
        if (!res.ok) {
            resultArea.innerHTML = `<span class="vt-badge vt-error">❌ ${escapeHtml(data.error || 'Fehler')}</span>`;
            return;
        }

        if (data.status !== 'completed') {
            resultArea.innerHTML = `<span class="vt-badge vt-scanning">🔍 Analysiert… (Versuch ${attempt + 1}/10)</span>`;
            await pollVtResult(analysisId, resultArea, attempt + 1);
            return;
        }

        renderVtResult(data.stats, resultArea);
    } catch (err) {
        resultArea.innerHTML = `<span class="vt-badge vt-error">❌ ${escapeHtml(err.message)}</span>`;
    }
}

function renderVtResult(stats, resultArea) {
    const total = (stats.malicious || 0) + (stats.suspicious || 0) + (stats.harmless || 0) + (stats.undetected || 0);
    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;

    let badgeClass, icon, label;
    if (malicious > 0) {
        badgeClass = 'vt-malicious';
        icon = '🔴';
        label = `GEFÄHRLICH: ${malicious} Erkennungen`;
    } else if (suspicious > 0) {
        badgeClass = 'vt-suspicious';
        icon = '🟡';
        label = `Verdächtig: ${suspicious} Hinweise`;
    } else {
        badgeClass = 'vt-clean';
        icon = '🟢';
        label = 'Sauber';
    }

    resultArea.innerHTML = `
        <span class="vt-badge ${badgeClass}">${icon} ${escapeHtml(label)}</span>
        <span class="vt-stats">${malicious} bösartig · ${suspicious} verdächtig · ${stats.harmless || 0} harmlos · ${stats.undetected || 0} unbekannt (von ${total})</span>
    `;
}

// ─── Bildschirmübertragung (Admin = Viewer / WebRTC Offerer) ──────────────────
let svPc = null;
let svSession = null;
let svPoll = null;

async function requestScreenShare(username) {
    if (!activeAdminCode) { setStatus('Bitte zuerst einloggen.', 'error'); return; }

    const modal = document.getElementById('screenViewerModal');
    const title = document.getElementById('screenViewerTitle');
    const statusEl = document.getElementById('screenViewerStatus');
    const videoWrap = document.getElementById('screenVideoWrap');

    // STUN servers für NAT-Traversal
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });
    svPc = pc;

    // Data channel: Nutzer sendet Mausposition hierher
    const mouseChannel = pc.createDataChannel('mouse');
    mouseChannel.onmessage = (e) => {
        try { const { x, y } = JSON.parse(e.data); updateScreenCursor(x, y); } catch {}
    };

    // Eingehender Video-Stream
    pc.ontrack = (event) => {
        const video = document.getElementById('screenVideo');
        if (video && event.streams[0]) {
            video.srcObject = event.streams[0];
            videoWrap.style.display = '';
            statusEl.style.display = 'none';
        }
    };

    pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) closeScreenShare();
    };

    // Video-Empfang anfordern
    pc.addTransceiver('video', { direction: 'recvonly' });

    // Offer erstellen + auf vollständiges ICE-Gathering warten
    await pc.setLocalDescription(await pc.createOffer());
    const offer = await waitIce(pc);

    // Anfrage an Server senden
    title.textContent = `🖥️ ${username}`;
    statusEl.textContent = `Warte auf ${username}…`;
    statusEl.style.display = '';
    videoWrap.style.display = 'none';
    document.getElementById('screenCursor').style.display = 'none';
    modal.style.display = 'flex';

    const res = await fetch(`${window.location.origin}/api/admin/screenshare/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': activeAdminCode },
        body: JSON.stringify({ username, offer })
    });
    const data = await res.json();
    if (!res.ok) {
        setStatus(data.error || 'Fehler beim Senden', 'error');
        closeScreenShare();
        return;
    }
    svSession = data.sessionId;

    // Auf Antwort des Nutzers warten (Polling)
    svPoll = setInterval(async () => {
        try {
            const r = await fetch(`${window.location.origin}/api/admin/screenshare/session/${svSession}`, {
                headers: { 'x-admin-key': activeAdminCode }
            });
            const d = await r.json();

            if (d.status === 'declined') {
                clearInterval(svPoll); svPoll = null;
                closeScreenShare();
                setStatus(`${username} hat die Übertragung abgelehnt.`, 'error');
            } else if (d.status === 'ended') {
                clearInterval(svPoll); svPoll = null;
                closeScreenShare();
            } else if (d.status === 'active' && d.answer) {
                clearInterval(svPoll); svPoll = null;
                await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
            }
        } catch {}
    }, 1500);
}

function waitIce(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve(pc.localDescription);
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') resolve(pc.localDescription);
        };
        setTimeout(() => resolve(pc.localDescription), 5000);
    });
}

function updateScreenCursor(x, y) {
    const cursor = document.getElementById('screenCursor');
    const wrap = document.getElementById('screenVideoWrap');
    if (!cursor || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    cursor.style.left = (x * 100) + '%';
    cursor.style.top = (y * 100) + '%';
    cursor.style.display = 'block';
}

async function closeScreenShare() {
    if (svPoll) { clearInterval(svPoll); svPoll = null; }
    if (svPc) { svPc.close(); svPc = null; }

    if (svSession) {
        await fetch(`${window.location.origin}/api/admin/screenshare/end/${svSession}`, {
            method: 'POST', headers: { 'x-admin-key': activeAdminCode }
        }).catch(() => {});
        svSession = null;
    }

    const modal = document.getElementById('screenViewerModal');
    if (modal) modal.style.display = 'none';
    const video = document.getElementById('screenVideo');
    if (video) video.srcObject = null;
}

