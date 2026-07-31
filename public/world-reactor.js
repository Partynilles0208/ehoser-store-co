import { Reactor } from 'https://esm.sh/@reactor-team/js-sdk';

let reactor = null;

window.startReactorWorld = async ({ token, prompt, image }) => {
    const video = document.getElementById('worldVideo');
    const canvas = document.getElementById('worldCanvas');
    if (!video || !token) throw new Error('Reactor-Session konnte nicht gestartet werden.');

    reactor = new Reactor({ modelName: 'reactor/lingbot' });
    reactor.on('trackReceived', (name, track) => {
        if (name !== 'main_video') return;
        video.srcObject = new MediaStream([track]);
        video.play().catch(() => {});
    });
    reactor.on('statusChanged', async (status) => {
        if (status !== 'ready') return;
        await reactor.sendCommand('set_prompt', { prompt });
        await reactor.sendCommand('set_image', { image });
        await reactor.sendCommand('start', {});
    });
    await reactor.connect(token);

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
