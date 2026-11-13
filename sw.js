/* Service Worker: legt alle Dateien der App im Gerät ab, damit sie ohne Internet läuft.
   WICHTIG: Bei jeder Änderung an der App die Versionsnummer in CACHE erhöhen. */
var CACHE = 'inventur-v2';
var DATEIEN = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/barcode-detector.js',
  'vendor/zxing_reader.wasm'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE)
      .then(function (c) { /* cache: 'reload' = am HTTP-Cache vorbei, sonst könnte eine alte Datei in den neuen Cache geraten */
        return c.addAll(DATEIEN.map(function (d) { return new Request(d, { cache: 'reload' }); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys()
      .then(function (namen) {
        return Promise.all(namen.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Cache zuerst, sonst Netz. */
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (treffer) {
      if (treffer) return treffer;
      return fetch(req).catch(function () {
        if (req.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
