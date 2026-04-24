const ADMIN_CODE = 'nils2014!';
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

    if (code !== ADMIN_CODE) {
        setStatus('Falscher Admin-Code.', 'error');
        return;
    }

    activeAdminCode = code;
    secureArea.style.display = '';
    setStatus('Admin-Bereich freigeschaltet.', 'success');
    await Promise.all([loadRegisteredUsers(), loadResetRequests()]);
    clearInterval(adminRefreshInterval);
    adminRefreshInterval = setInterval(() => {
        loadRegisteredUsers();
        loadResetRequests();
    }, 8000);
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('', '');

    if (activeAdminCode !== ADMIN_CODE) {
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
                    <span>${escapeHtml(user.username)}</span>
                    <button class="btn-small" onclick="deleteUser(${user.id}, '${escapeJs(user.username)}')">Loeschen</button>
                </li>`
            )
            .join('');
    } catch (error) {
        setStatus(`Fehler beim Laden der Nutzer: ${error.message}`, 'error');
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
