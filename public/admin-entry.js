const form = document.getElementById('adminEntryForm');
const statusBox = document.getElementById('adminEntryStatus');
const codeInput = document.getElementById('adminEntryCode');

function setStatus(message, type = 'info') {
    statusBox.innerHTML = `<div class="status ${type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : 'status-info'}">${message}</div>`;
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) {
        setStatus('Bitte Admin-Code eingeben.', 'error');
        return;
    }

    try {
        const res = await fetch(`${window.location.origin}/api/admin/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': code }
        });

        if (!res.ok) {
            setStatus('Falscher Admin-Code. Bitte erneut versuchen.', 'error');
            return;
        }

        sessionStorage.setItem('ehoserAdminCode', code);
        setStatus('Code bestätigt. Weiterleitung...', 'success');
        setTimeout(() => {
            window.location.href = '/admin';
        }, 350);
    } catch (err) {
        setStatus('Verbindungsfehler. Bitte überprüfe den Serverstatus.', 'error');
    }
});

const savedCode = sessionStorage.getItem('ehoserAdminCode');
if (savedCode) {
    codeInput.value = savedCode;
    setStatus('Vorheriger Admin-Code gefunden. Bitte weiter zur Freischaltung.', 'info');
}
