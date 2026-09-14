// Service worker mínimo — existe só para habilitar "instalar como app" (PWA).
// Não faz cache de nada: toda navegação/reserva continua sempre buscando dados
// ao vivo do Supabase, sem risco de mostrar horários desatualizados.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
