/* ==========================================================================
   mecra — basit service worker (PWA kabuğu)
   Amaç: uygulama kabuğunu (HTML/CSS/JS/ikon) çevrimdışı önbelleğe almak.
   Feed'ler DAİMA ağdan gelir; onları önbelleğe almıyoruz (taze içerik önemli).
   ========================================================================== */

// Kabuk dosyaları her değiştiğinde bu sürümü artır → eski önbellek atılır, taze sunulur.
const CACHE = 'mecra-shell-v9';

// Uygulama kabuğu — çevrimdışı açılış için gereken statik dosyalar.
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

// Kurulum: kabuğu önbelleğe al.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Etkinleşme: eski sürüm önbelleklerini temizle.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Getirme stratejisi:
//  - Feed/proxy istekleri: her zaman ağdan (önbelleğe alma).
//  - Kabuk dosyaları: önce önbellek, yoksa ağ (çevrimdışı da açılsın).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Yabancı istekler (proxy/feed/görsel) → doğrudan ağa, dokunma.
  if (!sameOrigin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // Aynı köken statik dosyayı fırsattan önbelleğe ekle.
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'));   // çevrimdışı yedeği
    })
  );
});
