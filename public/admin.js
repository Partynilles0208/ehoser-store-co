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
        // Schritt 1: Upload-URLs vom Server holen
        setStatus('Schritt 1/3: Verbindung zu Supabase wird vorbereitet...', 'info');
        const urlResponse = await fetch(`${window.location.origin}/api/admin/upload-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': accessCode
            },
            body: JSON.stringify({ iconName: iconFile.name, apkName: apkFile.name })
        });

        const urls = await urlResponse.json();
        if (!urlResponse.ok) {
            setStatus(`Fehler: ${urls.error}`, 'error');
            return;
        }

        // Schritt 2: Icon direkt zu Supabase hochladen
        setStatus('Schritt 2/3: Icon wird hochgeladen...', 'info');
        const iconUpload = await fetch(urls.icon.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': iconFile.type || 'application/octet-stream' },
            body: iconFile
        });
        if (!iconUpload.ok) {
            setStatus('Icon-Upload fehlgeschlagen. Prüfe ob der Bucket "app-icons" in Supabase existiert.', 'error');
            return;
        }

        // Schritt 2b: APK direkt zu Supabase hochladen (kann bei großen Dateien etwas dauern)
        setStatus(`Schritt 2/3: APK wird hochgeladen (${(apkFile.size / 1024 / 1024).toFixed(1)} MB)...`, 'info');
        const apkUpload = await fetch(urls.apk.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: apkFile
        });
        if (!apkUpload.ok) {
            setStatus('APK-Upload fehlgeschlagen. Prüfe ob der Bucket "app-apks" in Supabase existiert.', 'error');
            return;
        }

        // Schritt 3: Metadaten speichern
        setStatus('Schritt 3/3: App wird im Store gespeichert...', 'info');
        const saveResponse = await fetch(`${window.location.origin}/api/admin/apps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': accessCode
            },
            body: JSON.stringify({
                name, version, category, description, sourceUrl,
                iconUrl: urls.icon.publicUrl,
                downloadUrl: urls.apk.publicUrl
            })
        });

        const data = await saveResponse.json();
        if (!saveResponse.ok) {
            setStatus(`Fehler: ${data.error || 'Speichern fehlgeschlagen.'}`, 'error');
            return;
        }

        setStatus('App erfolgreich hochgeladen und im Store sichtbar!', 'success');
        form.reset();
    } catch (error) {
        setStatus(`Fehler: ${error.message}`, 'error');
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
