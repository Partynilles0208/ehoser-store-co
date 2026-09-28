'use strict';

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const chatWindow = windows.find((client) => new URL(client.url).pathname.startsWith('/chat'));
        if (chatWindow) {
            await chatWindow.focus();
            return;
        }
        await self.clients.openWindow('./');
    })());
});
