/* Service Worker der Inventur-App – macht die App offline nutzbar.
   Diese Datei bleibt immer gleich. Ein Update der App heißt nur: index.html ersetzen.

   Ablauf beim Öffnen der App:
   - Mit Netz: index.html kommt frisch vom Webspace und wird im Gerät abgelegt.
   - Ohne Netz (oder keine Antwort nach 3 Sekunden): die zuletzt geladene index.html aus dem Gerät. */
var CACHE = 'inventur-seite';
var TIMEOUT_MS = 3000;
var SCOPE = new URL('./', self.location.href);          // z. B. https://example.de/inventur/
var SCHLUESSEL = SCOPE.href;                              // unter dieser Adresse liegt die Seite im Cache

/* Ist das ein Aufruf der App-Seite selbst ( …/  oder  …/index.html )? */
function istAppSeite(url) {
  var u = new URL(url);
  return u.origin === SCOPE.origin && (u.pathname === SCOPE.pathname || u.pathname === SCOPE.pathname + 'index.html');
}

/* Frisch vom Webspace holen (am HTTP-Cache vorbei prüfen) und eine gute Antwort im Gerät ablegen. */
function holenUndMerken(url) {
  return fetch(url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (antwort) {
    var typ = antwort.headers.get('Content-Type') || '';
    if (!antwort.ok || antwort.type !== 'basic' || typ.indexOf('text/html') < 0) return antwort;
    // Eine saubere Kopie (ohne „weitergeleitet“-Markierung), damit sie als Seite benutzt werden darf
    return antwort.blob().then(function (inhalt) {
      var init = { status: antwort.status, statusText: antwort.statusText, headers: { 'Content-Type': typ } };
      var kopie = new Response(inhalt, init);
      return caches.open(CACHE)
        .then(function (c) { return c.put(SCHLUESSEL, kopie); })
        .catch(function () { /* Speicher voll o. ä.: dann eben nur online */ })
        .then(function () { return new Response(inhalt, init); });
    });
  });
}

function ausDemGeraet() {
  return caches.open(CACHE).then(function (c) { return c.match(SCHLUESSEL); });
}

self.addEventListener('install', function (ev) {
  // Seite gleich ablegen; schlägt das fehl, wird sie beim nächsten Öffnen abgelegt
  ev.waitUntil(holenUndMerken(SCHLUESSEL).catch(function () {}).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys()
      .then(function (namen) {
        return Promise.all(namen.filter(function (n) { return /^inventur-v/.test(n); }).map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Netz zuerst (höchstens ca. 3 s warten), sonst die abgelegte Seite. Alles andere geht unverändert ins Netz. */
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET' || req.mode !== 'navigate' || !istAppSeite(req.url)) return;
  var netz = holenUndMerken(req.url);
  ev.waitUntil(netz.catch(function () {})); // auch nach dem Timeout noch fertig ablegen
  ev.respondWith(new Promise(function (fertig) {
    var erledigt = false;
    function nimm(antwort) { if (!erledigt && antwort) { erledigt = true; fertig(antwort); } }
    function ersatz() {
      return ausDemGeraet().catch(function () { return null; }).then(function (gemerkt) {
        if (gemerkt) nimm(gemerkt);
        return gemerkt;
      });
    }
    var uhr = setTimeout(ersatz, TIMEOUT_MS);
    netz.then(function (antwort) {
      clearTimeout(uhr);
      if (antwort.ok) return nimm(antwort);
      // z. B. 404/500 vom Webspace: lieber die abgelegte Seite, sonst die Fehlerseite des Servers
      return ersatz().then(function (gemerkt) { if (!gemerkt) nimm(antwort); });
    }, function () {
      clearTimeout(uhr);
      return ersatz().then(function (gemerkt) { if (!gemerkt) nimm(Response.error()); });
    });
  }));
});
