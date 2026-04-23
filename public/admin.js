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

    formData.append('icon', iconFile);
    formData.append('apk', apkFile);

    try {
        const response = await fetch(`${window.location.origin}/api/admin/apps`, {
            method: 'POST',
            headers: {
                'x-admin-key': accessCode
            },
            body: formData
        });

        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Upload fehlgeschlagen.', 'error');
            return;
        }

        setStatus('App erfolgreich hochgeladen und im Store sichtbar.', 'success');
        form.reset();
    } catch (error) {
        setStatus('Server nicht erreichbar.', 'error');
    }
});

function setStatus(message, type) {
    statusBox.innerHTML = '';
    if (!message) {
        return;
    }

    const node = document.createElement('div');
    node.className = `alert alert-${type}`;
    node.textContent = message;
    statusBox.appendChild(node);
}
