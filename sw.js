/* Service worker Jejak Pajak (versi web/PWA). Kerangka aplikasi disimpan supaya bisa dibuka tanpa internet.
   index.html diambil dari jaringan lebih dulu (maks. 4 detik) supaya perbaikan aplikasi langsung sampai;
   data aturan diambil aplikasi sendiri dari GitHub dan disimpan di IndexedDB, tidak lewat sini. */
const CACHE = 'jejak-pajak-2300c84d74';
const INTI = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './ikon-192.png', './ikon-512.png', './ikon-maskable-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(INTI)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('jejak-pajak-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function dariJaringan(req){
  return new Promise((ok, gagal) => {
    const t = setTimeout(() => gagal(new Error('lambat')), 4000);
    fetch(req).then(r => { clearTimeout(t); if(!r.ok) return gagal(new Error('HTTP ' + r.status));
      const salin = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', salin)); ok(r); }, e => { clearTimeout(t); gagal(e); });
  });
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET' || u.origin !== location.origin) return;   // data GitHub dan huruf: langsung ke jaringan
  if(e.request.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname)){
    e.respondWith(dariJaringan(e.request).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
