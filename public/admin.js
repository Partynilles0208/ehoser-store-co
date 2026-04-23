const form = document.getElementById('uploadForm');
const statusBox = document.getElementById('uploadStatus');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('', '');

    const accessCode = document.getElementById('accessCode').value.trim();
    if (accessCode !== 'Nils2014!') {
        setStatus('Falscher Admin-Zugangscode.', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('name', document.getElementById('name').value.trim());
    formData.append('version', document.getElementById('version').value.trim());
    formData.append('category', document.getElementById('category').value);
    formData.append('description', document.getElementById('description').value.trim());
    formData.append('sourceUrl', document.getElementById('sourceUrl').value.trim());

    const iconFile = document.getElementById('icon').files[0];
    const apkFile = document.getElementById('apk').files[0];

    if (!iconFile || !apkFile) {
        setStatus('Bitte Icon und APK auswählen.', 'error');
        return;
    }

    const maxSize = 4 * 1024 * 1024; // 4MB Vercel Limit
    if (apkFile.size > maxSize) {
        setStatus(`APK ist ${(apkFile.size / 1024 / 1024).toFixed(1)} MB groß. Vercel erlaubt max. 4 MB. Lade die APK direkt in Supabase Storage hoch und trage die URL manuell ein.`, 'error');
        return;
    }

    formData.append('icon', iconFile);
    formData.append('apk', apkFile);

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Wird hochgeladen...';
    setStatus('Upload läuft, bitte warten...', 'info');

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(`${window.location.origin}/api/admin/apps`, {
            method: 'POST',
            headers: { 'x-admin-key': accessCode },
            body: formData,
            signal: controller.signal
        });

        clearTimeout(timeout);
        const data = await response.json();

        if (!response.ok) {
            setStatus(`Fehler: ${data.error || 'Upload fehlgeschlagen.'}`, 'error');
            return;
        }

        setStatus('App erfolgreich hochgeladen und im Store sichtbar.', 'success');
        form.reset();
    } catch (error) {
        if (error.name === 'AbortError') {
            setStatus('Timeout: Der Upload hat zu lange gedauert. APK ist wahrscheinlich zu groß für Vercel (max. 4 MB).', 'error');
        } else {
            setStatus(`Server nicht erreichbar: ${error.message}`, 'error');
        }
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'App veröffentlichen';
    }
});

function setStatus(message, type) {
    statusBox.innerHTML = '';
    if (!message) return;
    const node = document.createElement('div');
    node.className = `alert alert-${type}`;
    node.textContent = message;
    statusBox.appendChild(node);
}
