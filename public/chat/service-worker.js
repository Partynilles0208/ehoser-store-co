'use strict';

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const targetUrl = event.notification.data?.url || '/chat/';
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const targetPath = new URL(targetUrl, self.location.origin).pathname;
        const chatWindow = windows.find((client) => new URL(client.url).pathname.startsWith(targetPath));
        if (chatWindow) {
            await chatWindow.focus();
            return;
        }
        await self.clients.openWindow(targetUrl);
    })());
});
