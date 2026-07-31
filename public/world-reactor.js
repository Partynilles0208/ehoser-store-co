import { Reactor } from '@reactor-team/js-sdk';

let reactor = null;

window.startReactorWorld = async ({ token, prompt, file }) => {
    const video = document.getElementById('worldVideo');
    const canvas = document.getElementById('worldCanvas');
    if (!video || !token) throw new Error('Reactor-Session konnte nicht gestartet werden.');

    const setStatus = (message) => {
        const title = document.getElementById('worldTitle');
        if (title) title.textContent = message;
    };
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    setStatus('Verbinde mit LingBot ...');
    reactor = new Reactor({ modelName: 'reactor/lingbot' });
    reactor.on('trackReceived', (name, track) => {
        if (name !== 'main_video') return;
        setStatus('LingBot-Welt läuft');
        video.srcObject = new MediaStream([track]);
        video.play().catch(() => {});
    });
    reactor.on('command_error', (data) => setStatus(`LingBot-Fehler: ${data?.reason || 'Befehl abgelehnt'}`));
    reactor.on('statusChanged', async (status) => {
        if (status !== 'ready') return;
        resolveReady();
    });
    await reactor.connect(token);
    await readyPromise;
    setStatus('Bild wird an LingBot übertragen ...');
    const imageRef = await reactor.uploadFile(file);
    await reactor.sendCommand('set_prompt', { prompt });
    await reactor.sendCommand('set_image', { image: imageRef });
    await reactor.sendCommand('start', {});
    setStatus('LingBot generiert die Welt ...');

    window.__worldKeys = window.__worldKeys || new Set();
    canvas?.addEventListener('keydown', (event) => window.__worldKeys.add(event.key.toLowerCase()));
    canvas?.addEventListener('keyup', (event) => window.__worldKeys.delete(event.key.toLowerCase()));
    const movement = () => {
        const keys = window.__worldKeys;
        let direction = 'none';
        if (keys.has('w')) direction = 'forward';
        else if (keys.has('s')) direction = 'backward';
        else if (keys.has('a')) direction = 'left';
        else if (keys.has('d')) direction = 'right';
        reactor?.sendCommand('set_movement', { direction }).catch(() => {});
        requestAnimationFrame(movement);
    };
    movement();
};
