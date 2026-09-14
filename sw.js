// Service worker mínimo — existe só para habilitar "instalar como app" (PWA).
// Não faz cache de nada: toda navegação/reserva continua sempre buscando dados
// ao vivo do Supabase, sem risco de mostrar horários desatualizados.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Lembretes de reserva (Web Push) — enviados pela Edge Function do Supabase.
self.addEventListener('push', (event) => {
    let data = { title: 'WB Coworking', body: 'Você tem uma reserva em breve.' };
    try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {}
    event.waitUntil(self.registration.showNotification(data.title, {
        body: data.body,
        icon: 'img/icon-192.png',
        badge: 'img/icon-192.png',
        data: { url: data.url || '/' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
        for (const c of list) if ('focus' in c) return c.focus();
        if (self.clients.openWindow) return self.clients.openWindow(url);
    }));
});
