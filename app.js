/* Inventur – einfache Offline-Erfassung. Kein Server: alle Daten liegen in IndexedDB auf dem Gerät. */
(function () {
  'use strict';

  var VERSION = 'v5'; // muss zu CACHE in sw.js passen: 'inventur-' + VERSION
  var DB_NAME = 'inventur';
  var DB_VERSION = 1;
  var STANDARD_HERSTELLER = ['Schüco', 'Dormakaba', 'GEZE', 'Record', 'Sonstige'];
  var FOTO_MAX_KANTE = 1600;
  var FOTO_QUALITAET = 0.8;
  var VORSCHAU_KANTE = 160;
  var STUECK_STELLEN = 6;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Zustand ---------- */
  var db = null;
  var zustand = {
    geraet: '',
    hersteller: [],
    aktiv: '',
    letzterExport: 0,
    eintraege: [],      // ohne Foto-Daten, nur Vorschaubild
    entwurfFoto: null,  // { buf, type, thumb }
    fotoLaeuft: false,  // Foto wird gerade verkleinert
    fotoLauf: 0,        // zählt hoch, wenn ein laufendes Foto nicht mehr gebraucht wird
    speichert: false,
    seite: 'erfassen',
    modus: 'scan',      // 'scan' = Kamera, 'hand' = eintippen
    schritt: 'nummer',  // 'nummer' -> 'stueck' -> speichern; 'foto' = ohne Nummer mit Foto
    nummer: '',
    stueck: '',
    scanWert: ''        // roh gelesener Code (für die Scan-Sperre, auch wenn die Nummer korrigiert wurde)
  };

  /* ---------- kleine Helfer ---------- */
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function leeren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function zwei(n) { return (n < 10 ? '0' : '') + n; }
  function datumText(ts) { var d = new Date(ts); return zwei(d.getDate()) + '.' + zwei(d.getMonth() + 1) + '.' + d.getFullYear(); }
  function zeitText(ts, sek) { var d = new Date(ts); return zwei(d.getHours()) + ':' + zwei(d.getMinutes()) + (sek ? ':' + zwei(d.getSeconds()) : ''); }
  function datumIso(ts) { var d = new Date(ts); return d.getFullYear() + '-' + zwei(d.getMonth() + 1) + '-' + zwei(d.getDate()); }
  function warte(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function bereinigen(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); }
  function nurZiffern(s) { return String(s == null ? '' : s).replace(/\D+/g, '').replace(/^0+/, '').slice(0, STUECK_STELLEN); }
  function vibrieren(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* egal */ } }

  function stueckLesen(text) {
    var t = String(text).trim();
    if (!/^\d{1,6}$/.test(t)) return 0;
    return parseInt(t, 10);
  }

  /* ---------- Meldungen (Balken oben) ---------- */
  var meldungTimer = null;
  function meldungWeg() { clearTimeout(meldungTimer); $('meldung').classList.add('versteckt'); }
  function meldung(text, opts) {
    opts = opts || {};
    var m = $('meldung');
    leeren(m);
    m.appendChild(el('span', { class: 'meldung-text' },
      el('span', { class: 'meldung-haupt', text: text }),
      opts.zusatz ? el('small', { text: opts.zusatz }) : null));
    m.className = 'meldung' + (opts.fehler ? ' fehler' : '') + (opts.ok ? ' ok' : '');
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(meldungWeg, opts.dauer || (opts.fehler ? 5000 : 2500));
  }
  function fehlerMeldung(text) { meldung(text, { fehler: true }); }

  /* Bestätigung im Reiter „Erfassen“ (verdeckt keine Bedienelemente) */
  var erfolgTimer = null, erfolgRueckgaengig = null;
  function erfolgWeg() { clearTimeout(erfolgTimer); erfolgRueckgaengig = null; $('erfolg').classList.add('versteckt'); }
  function erfolg(teile, zusatz, rueckgaengigFn, neutral) {
    // teile: Textstücke, die jeweils nicht umbrochen werden („✓ 4711“, „· 12 Stück“)
    var haupt = $('erfolg-haupt');
    leeren(haupt);
    teile.forEach(function (t, i) {
      if (i) haupt.appendChild(document.createTextNode(' '));
      haupt.appendChild(el('span', { class: 'erfolg-teil', text: t }));
    });
    $('erfolg-zusatz').textContent = zusatz || '';
    erfolgRueckgaengig = rueckgaengigFn || null;
    var box = $('erfolg');
    box.className = 'erfolg' + (neutral ? ' neutral' : '');
    meldungWeg();
    clearTimeout(erfolgTimer);
    erfolgTimer = setTimeout(erfolgWeg, rueckgaengigFn ? 8000 : 3000);
  }

  /* ---------- Dialog ---------- */
  var dialogOffen = null;
  function dialog(opts) {
    return new Promise(function (fertig) {
      var hg = $('dialog-hintergrund');
      $('dialog-titel').textContent = opts.titel || '';
      var inhalt = $('dialog-inhalt');
      leeren(inhalt);
      (opts.inhalt || []).forEach(function (n) {
        inhalt.appendChild(typeof n === 'string' ? el('p', { text: n }) : n);
      });
      var kn = $('dialog-knoepfe');
      leeren(kn);
      function schliessen(wert) {
        hg.classList.add('versteckt');
        leeren(inhalt);
        leeren(kn);
        dialogOffen = null;
        fertig(wert);
      }
      dialogOffen = { schliessen: schliessen, schliessbar: opts.schliessbar !== false };
      (opts.knoepfe || [{ text: 'OK', wert: true, klasse: 'knopf-haupt' }]).forEach(function (k) {
        kn.appendChild(el('button', {
          type: 'button',
          class: 'knopf ' + (k.klasse || 'knopf-neutral'),
          'data-wert': String(k.wert),
          text: k.text,
          onclick: function () {
            if (k.pruefen && !k.pruefen()) return;
            schliessen(k.wert);
          }
        }));
      });
      hg.classList.remove('versteckt');
      var fokus = inhalt.querySelector('[data-fokus]');
      if (fokus) { try { fokus.focus(); if (fokus.select) fokus.select(); } catch (e) { /* egal */ } }
    });
  }
  function frage(titel, text, jaText, jaKlasse, neinText) {
    return dialog({
      titel: titel,
      inhalt: Array.isArray(text) ? text : [text],
      knoepfe: [
        { text: jaText, wert: true, klasse: jaKlasse || 'knopf-haupt' },
        { text: neinText || 'Abbrechen', wert: false, klasse: 'knopf-neutral' }
      ]
    });
  }
  /* Enter in einem Dialog-Eingabefeld = erster Knopf */
  function enterKlicktErstenKnopf(feld) {
    feld.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var k = $('dialog-knoepfe').querySelector('button');
      if (k) k.click();
    });
  }

  /* ---------- Datenbank ---------- */
  function dbOeffnen() {
    return new Promise(function (ok, fehler) {
      if (!window.indexedDB) { fehler(new Error('IndexedDB fehlt')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('eintraege')) d.createObjectStore('eintraege', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('fotos')) d.createObjectStore('fotos');
        if (!d.objectStoreNames.contains('einstellungen')) d.createObjectStore('einstellungen');
      };
      req.onsuccess = function () {
        req.result.onversionchange = function () { req.result.close(); };
        ok(req.result);
      };
      req.onerror = function () { fehler(req.error || new Error('Datenbank konnte nicht geöffnet werden')); };
      req.onblocked = function () { fehler(new Error('Datenbank ist blockiert')); };
    });
  }
  /* Führt fn(tx) in einer Transaktion aus; liefert den Rückgabewert von fn (bzw. .result eines Requests) nach Abschluss. */
  function transaktion(stores, modus, fn) {
    return new Promise(function (ok, fehler) {
      var tx;
      try { tx = db.transaction(stores, modus); } catch (e) { fehler(e); return; }
      var ergebnis;
      tx.oncomplete = function () { ok(ergebnis && typeof ergebnis === 'object' && 'result' in ergebnis && 'readyState' in ergebnis ? ergebnis.result : ergebnis); };
      tx.onerror = function () { fehler(tx.error || new Error('Speicherfehler')); };
      tx.onabort = function () { fehler(tx.error || new Error('Speichern abgebrochen')); };
      try { ergebnis = fn(tx); } catch (e) { try { tx.abort(); } catch (e2) { /* egal */ } fehler(e); }
    });
  }
  function einstellungSchreiben(schluessel, wert) {
    return transaktion('einstellungen', 'readwrite', function (tx) { tx.objectStore('einstellungen').put(wert, schluessel); });
  }
  function einstellungLoeschen(schluessel) {
    return transaktion('einstellungen', 'readwrite', function (tx) { tx.objectStore('einstellungen').delete(schluessel); });
  }
  function fotoLesen(id) {
    return transaktion('fotos', 'readonly', function (tx) { return tx.objectStore('fotos').get(id); });
  }
  function speicherFehlerText(e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)))) {
      return 'Der Speicher des Geräts ist voll. Bitte exportieren und Platz schaffen.';
    }
    return 'Speichern hat nicht geklappt. Bitte noch einmal versuchen.';
  }

  /* ---------- Reiter ---------- */
  function zeigeSeite(name) {
    zustand.seite = name;
    ['erfassen', 'hersteller', 'liste'].forEach(function (s) {
      $('seite-' + s).classList.toggle('versteckt', s !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.reiter-knopf'), function (b) {
      var an = b.getAttribute('data-seite') === name;
      b.classList.toggle('aktiv', an);
      if (an) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('haupt').scrollTop = 0;
    window.scrollTo(0, 0);
    if (name === 'erfassen') {
      scan.fehler = false; // beim Zurückkommen die Kamera neu versuchen
      zeigeErfassen();
      if (zustand.modus === 'hand' && zustand.schritt === 'nummer') fokusNummer();
    } else {
      kameraAbgleichen();
    }
  }

  /* ---------- Anzeige ---------- */
  function zeigeKopf() {
    $('geraet-anzeige').textContent = zustand.geraet || '–';
  }

  function zeigeAktivenHersteller() {
    $('hersteller-aktiv').textContent = zustand.aktiv || '–';
  }

  function zeigeHersteller() {
    var liste = $('hersteller-liste');
    leeren(liste);
    if (!zustand.hersteller.length) liste.appendChild(el('div', { class: 'leer', text: 'Noch kein Hersteller. Bitte unten hinzufügen.' }));
    zustand.hersteller.forEach(function (name) {
      var aktiv = name === zustand.aktiv;
      liste.appendChild(el('div', { class: 'hersteller-zeile' },
        el('button', {
          type: 'button',
          class: 'knopf hersteller-knopf' + (aktiv ? ' aktiv' : ''),
          'aria-pressed': aktiv ? 'true' : 'false',
          onclick: function () { herstellerWaehlen(name); }
        }, el('span', { text: name }), aktiv ? el('span', { class: 'haken', text: '✓', 'aria-label': 'gewählt' }) : null),
        el('button', {
          type: 'button',
          class: 'knopf hersteller-weg',
          'aria-label': name + ' löschen',
          text: '✕',
          onclick: function () { herstellerLoeschen(name); }
        })
      ));
    });
    zeigeAktivenHersteller();
    zeigeErfassen();
  }

  function karte(e) {
    var mitte = el('div', { class: 'karte-mitte' },
      el('div', { class: 'karte-nummer' + (e.nummer ? '' : ' ohne'), text: e.nummer || 'ohne Nummer (Foto)' }),
      el('div', { class: 'karte-meta', text: e.hersteller + ' · ' + datumText(e.ts) + ' ' + zeitText(e.ts) }),
      e.bemerkung ? el('div', { class: 'karte-bemerkung', text: e.bemerkung }) : null,
      el('div', { class: 'karte-knoepfe' },
        el('button', { type: 'button', class: 'knopf knopf-neutral', text: 'Bearbeiten', onclick: function () { eintragBearbeiten(e.id); } }),
        el('button', { type: 'button', class: 'knopf knopf-rot-leer', text: 'Löschen', onclick: function () { eintragLoeschen(e.id); } })
      )
    );
    var bild = null;
    if (e.hatFoto) {
      bild = el('img', { class: 'karte-bild', alt: 'Foto ansehen', onclick: function () { fotoZeigen(e.id); } });
      if (e.thumb && /^data:image\//.test(e.thumb)) bild.src = e.thumb;
    }
    return el('div', { class: 'karte', 'data-id': String(e.id) },
      bild,
      mitte,
      el('div', { class: 'karte-rechts' },
        el('div', { class: 'karte-stueck' }, String(e.stueck), el('small', { text: ' Stück' }))
      )
    );
  }

  function zeigeEintraege() {
    var n = zustand.eintraege.length;
    $('zaehler').textContent = n === 1 ? '1 Eintrag' : n + ' Einträge';
    $('reiter-zaehler').textContent = n ? String(n) : '';

    var sortiert = zustand.eintraege.slice().sort(function (a, b) { return b.ts - a.ts || b.id - a.id; });
    var liste = $('liste');
    leeren(liste);
    if (!n) liste.appendChild(el('div', { class: 'leer', text: 'Noch keine Einträge.' }));
    var frag = document.createDocumentFragment();
    sortiert.forEach(function (e) { frag.appendChild(karte(e)); });
    liste.appendChild(frag);

    var info = $('export-info');
    if (!n) info.textContent = '';
    else if (!zustand.letzterExport) info.textContent = 'Noch nicht exportiert.';
    else {
      var neu = zustand.eintraege.filter(function (e) { return (e.geaendert || e.ts) > zustand.letzterExport; }).length;
      info.textContent = 'Letzter Export: ' + datumText(zustand.letzterExport) + ' ' + zeitText(zustand.letzterExport) +
        (neu ? ' – seitdem ' + neu + ' neu/geändert.' : ' – alles exportiert.');
    }
    $('btn-export').disabled = !n || exportLaeuft;
  }

  /* ---------- Hersteller ---------- */
  function herstellerSpeichern() {
    return transaktion('einstellungen', 'readwrite', function (tx) {
      var s = tx.objectStore('einstellungen');
      s.put(zustand.hersteller, 'hersteller');
      s.put(zustand.aktiv, 'aktiv');
    });
  }
  function herstellerWaehlen(name) {
    zustand.aktiv = name;
    zeigeHersteller();
    herstellerSpeichern().then(function () {
      zeigeSeite('erfassen');
    }).catch(function (e) { fehlerMeldung(speicherFehlerText(e)); });
  }
  function herstellerHinzufuegen() {
    var feld = $('f-hersteller-neu');
    var name = bereinigen(feld.value);
    if (!name) { feld.classList.add('fehler'); feld.focus(); return; }
    feld.classList.remove('fehler');
    var vorhanden = zustand.hersteller.filter(function (h) { return h.toLowerCase() === name.toLowerCase(); })[0];
    if (vorhanden) { fehlerMeldung('„' + vorhanden + '“ gibt es schon.'); return; }
    zustand.hersteller.push(name);
    feld.value = '';
    feld.blur();
    zeigeHersteller();
    herstellerSpeichern().then(function () { meldung('„' + name + '“ hinzugefügt. Zum Auswählen antippen.'); })
      .catch(function (e) { fehlerMeldung(speicherFehlerText(e)); });
  }
  function herstellerLoeschen(name) {
    var anzahl = zustand.eintraege.filter(function (e) { return e.hersteller === name; }).length;
    var text = ['Den Hersteller aus der Auswahl entfernen?'];
    if (anzahl) text.push('Die ' + anzahl + ' bereits erfassten Einträge bleiben erhalten.');
    frage('„' + name + '“ löschen?', text, 'Ja, löschen', 'knopf-rot').then(function (ja) {
      if (!ja) return;
      zustand.hersteller = zustand.hersteller.filter(function (h) { return h !== name; });
      if (zustand.aktiv === name) zustand.aktiv = '';
      zeigeHersteller();
      return herstellerSpeichern();
    }).catch(function (e) { fehlerMeldung(speicherFehlerText(e)); });
  }

  /* ---------- Gerätename ---------- */
  function geraetAbfragen(erststart) {
    var feld = el('input', {
      class: 'eingabe', type: 'text', maxlength: '40', autocomplete: 'off', 'data-fokus': true,
      placeholder: 'z. B. Max oder Tablet 2', id: 'f-geraet', enterkeyhint: 'done'
    });
    feld.value = zustand.geraet;
    enterKlicktErstenKnopf(feld);
    var fehler = el('div', { class: 'dialog-fehler' });
    var knoepfe = [{
      text: 'Übernehmen', wert: true, klasse: 'knopf-haupt',
      pruefen: function () {
        if (bereinigen(feld.value)) return true;
        feld.classList.add('fehler');
        fehler.textContent = 'Bitte einen Namen eintragen.';
        return false;
      }
    }];
    if (!erststart) knoepfe.push({ text: 'Abbrechen', wert: false, klasse: 'knopf-neutral' });
    return dialog({
      titel: erststart ? 'Willkommen!' : 'Name / Gerät ändern',
      inhalt: [
        erststart ? 'Wer zählt mit diesem Gerät? Bitte Namen oder Gerätenamen eintragen. Er steht später in der Export-Datei.'
                  : 'Der neue Name gilt für alle Einträge ab jetzt.',
        feld, fehler
      ],
      knoepfe: knoepfe,
      schliessbar: !erststart
    }).then(function (ok) {
      if (!ok) return;
      zustand.geraet = bereinigen(feld.value);
      zeigeKopf();
      return einstellungSchreiben('geraet', zustand.geraet);
    });
  }

  /* ---------- Erfassen: Anzeige und Schritte ---------- */
  function zeigeErfassen() {
    var seite = $('seite-erfassen');
    var schritt = zustand.aktiv ? zustand.schritt : 'ohne';
    seite.setAttribute('data-modus', zustand.modus);
    seite.setAttribute('data-schritt', schritt);
    ['scan', 'hand'].forEach(function (m) {
      var b = $('btn-modus-' + m), an = zustand.modus === m;
      b.classList.toggle('aktiv', an);
      b.setAttribute('aria-pressed', an ? 'true' : 'false');
    });
    var wert = $('nummer-wert');
    wert.textContent = zustand.nummer;
    wert.classList.toggle('lang', zustand.nummer.length > 12);
    $('f-stueck').textContent = zustand.stueck;
    if (zustand.stueck) $('stueck-zeile').classList.remove('fehler');
    zeigeFoto();
    kameraAbgleichen();
  }

  function fokusNummer() {
    try { $('f-nummer').focus(); } catch (e) { /* egal */ }
  }

  /* Bereit für den nächsten Artikel (im gewählten Modus) */
  function neuerArtikel() {
    zustand.schritt = 'nummer';
    zustand.nummer = '';
    zustand.stueck = '';
    $('f-nummer').value = '';
    $('f-nummer').classList.remove('fehler');
    $('stueck-zeile').classList.remove('fehler');
    zeigeErfassen();
    if (zustand.modus === 'hand' && zustand.seite === 'erfassen') fokusNummer();
  }

  function nummerGefunden(nummer, scanWert) {
    zustand.nummer = nummer;
    zustand.scanWert = scanWert || '';
    zustand.schritt = 'stueck';
    zeigeErfassen();
    entwurfMerken();
  }

  function modusSetzen(modus) {
    if (zustand.schritt === 'foto' || zustand.modus === modus) {
      if (modus === 'hand' && zustand.schritt === 'nummer') fokusNummer();
      return;
    }
    zustand.modus = modus;
    scan.fehler = false;
    einstellungSchreiben('modus', modus).catch(function () { /* nur Komfort */ });
    if (zustand.schritt === 'nummer') neuerArtikel();
    else { zeigeErfassen(); entwurfMerken(); }
  }

  function handWeiter() {
    var feld = $('f-nummer');
    var nummer = bereinigen(feld.value);
    if (!nummer) {
      feld.classList.add('fehler');
      fehlerMeldung('Bitte zuerst die Artikelnummer eintippen.');
      fokusNummer();
      return;
    }
    feld.classList.remove('fehler');
    feld.blur();
    nummerGefunden(nummer);
  }

  function nummerKorrigieren() {
    if (zustand.modus === 'hand') {
      $('f-nummer').value = zustand.nummer;
      zustand.schritt = 'nummer';
      zeigeErfassen();
      fokusNummer();
      return;
    }
    var feld = el('input', {
      class: 'eingabe eingabe-nummer', type: 'text', id: 'f-korrektur', autocomplete: 'off', autocapitalize: 'characters',
      autocorrect: 'off', spellcheck: 'false', maxlength: '250', enterkeyhint: 'done', 'data-fokus': true,
      'aria-label': 'Artikelnummer'
    });
    feld.value = zustand.nummer;
    enterKlicktErstenKnopf(feld);
    var fehler = el('div', { class: 'dialog-fehler' });
    dialog({
      titel: 'Artikelnummer ändern',
      inhalt: [feld, fehler],
      knoepfe: [
        {
          text: 'Übernehmen', wert: true, klasse: 'knopf-haupt',
          pruefen: function () {
            if (bereinigen(feld.value)) return true;
            feld.classList.add('fehler');
            fehler.textContent = 'Bitte eine Artikelnummer eintragen.';
            return false;
          }
        },
        { text: 'Abbrechen', wert: false, klasse: 'knopf-neutral' }
      ]
    }).then(function (ok) {
      if (!ok || zustand.schritt !== 'stueck') return;
      zustand.nummer = bereinigen(feld.value);
      zeigeErfassen();
      entwurfMerken();
    });
  }

  function nummerVerwerfen() {
    sperreSetzen(zustand.scanWert || zustand.nummer);
    neuerArtikel();
    entwurfMerken();
  }

  /* ---------- Ziffernblock ---------- */
  function stueckBearbeitbar() {
    return zustand.seite === 'erfassen' && zustand.aktiv && (zustand.schritt === 'stueck' || zustand.schritt === 'foto');
  }
  function ziffer(z) {
    if (!stueckBearbeitbar()) return;
    var s = zustand.stueck;
    if (s.length >= STUECK_STELLEN || (s === '' && z === '0')) return; // nur ganze Zahlen ab 1
    zustand.stueck = s + z;
    $('f-stueck').textContent = zustand.stueck;
    $('stueck-zeile').classList.remove('fehler');
    entwurfMerken();
  }
  function zifferWeg() {
    if (!stueckBearbeitbar()) return;
    zustand.stueck = zustand.stueck.slice(0, -1);
    $('f-stueck').textContent = zustand.stueck;
    entwurfMerken();
  }

  /* ---------- Entwurf (schützt vor Datenverlust bei Neuladen) ---------- */
  var entwurfTimer = null;
  function entwurfSchreiben() {
    clearTimeout(entwurfTimer);
    var s = zustand.schritt;
    if (s === 'stueck' || s === 'foto') {
      return einstellungSchreiben('entwurf', {
        nummer: s === 'stueck' ? zustand.nummer : '',
        stueck: zustand.stueck,
        bemerkung: s === 'foto' ? $('f-beschreibung').value : '',
        foto: s === 'foto',
        modus: zustand.modus
      });
    }
    return einstellungLoeschen('entwurf');
  }
  function entwurfMerken() {
    clearTimeout(entwurfTimer);
    entwurfTimer = setTimeout(function () {
      entwurfSchreiben().catch(function () { /* Entwurf ist nur Komfort */ });
    }, 250);
  }
  /* Entwurf aus der Datenbank übernehmen (auch im Format der Vorversion) */
  function entwurfUebernehmen(entwurf, foto) {
    entwurf = entwurf || {};
    var nummer = bereinigen(entwurf.nummer);
    var bemerkung = bereinigen(entwurf.bemerkung);
    zustand.stueck = nurZiffern(entwurf.stueck);
    if ((foto && foto.buf) || entwurf.foto) {
      if (foto && foto.buf) zustand.entwurfFoto = foto;
      zustand.schritt = 'foto';
      zustand.nummer = '';
      // Vorversion: Foto konnte zusätzlich eine Nummer haben – sie geht nicht verloren
      $('f-beschreibung').value = nummer && entwurf.foto === undefined ? (bemerkung ? nummer + ' – ' + bemerkung : nummer) : bemerkung;
    } else if (nummer) {
      zustand.schritt = 'stueck';
      zustand.nummer = nummer;
    } else {
      zustand.stueck = '';
    }
  }

  /* ---------- Foto ---------- */
  function blobZuBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (ok, fehler) {
      var r = new FileReader();
      r.onload = function () { ok(r.result); };
      r.onerror = function () { fehler(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }
  function bildLaden(url) {
    return new Promise(function (ok, fehler) {
      var img = new Image();
      img.onload = function () { ok(img); };
      img.onerror = function () { fehler(new Error('Bild nicht lesbar')); };
      img.src = url;
    });
  }
  function aufLeinwand(img, maxKante) {
    var b = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var f = Math.min(1, maxKante / Math.max(b, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b * f));
    c.height = Math.max(1, Math.round(h * f));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function leinwandZuBlob(c, qualitaet) {
    return new Promise(function (ok, fehler) {
      if (c.toBlob) {
        c.toBlob(function (b) { if (b) ok(b); else fehler(new Error('Bild konnte nicht gespeichert werden')); }, 'image/jpeg', qualitaet);
      } else {
        try {
          var bin = atob(c.toDataURL('image/jpeg', qualitaet).split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          ok(new Blob([arr], { type: 'image/jpeg' }));
        } catch (e) { fehler(e); }
      }
    });
  }
  /* Verkleinert das Kamerabild auf max. 1600 px Kante (JPEG) und erzeugt ein kleines Vorschaubild. */
  function fotoVerarbeiten(datei) {
    var url = URL.createObjectURL(datei);
    return bildLaden(url).then(function (img) {
      var gross = aufLeinwand(img, FOTO_MAX_KANTE);
      var thumb = aufLeinwand(gross, VORSCHAU_KANTE).toDataURL('image/jpeg', 0.6);
      return leinwandZuBlob(gross, FOTO_QUALITAET).then(blobZuBuffer).then(function (buf) {
        gross.width = gross.height = 0; // Speicher auf iOS früh freigeben
        return { buf: buf, type: 'image/jpeg', thumb: thumb };
      });
    }).then(function (r) { URL.revokeObjectURL(url); return r; },
      function (e) { URL.revokeObjectURL(url); throw e; });
  }
  var vorschau = { foto: null, url: '' };
  function zeigeFoto() {
    var f = zustand.entwurfFoto;
    var knopf = $('btn-foto-neu');
    knopf.classList.toggle('leer', !f);
    knopf.disabled = zustand.fotoLaeuft;
    if (vorschau.foto !== f) {
      // Vorschau in voller Größe statt des kleinen Listenbilds
      if (vorschau.url) URL.revokeObjectURL(vorschau.url);
      vorschau.foto = f;
      vorschau.url = '';
      if (f) {
        try { vorschau.url = URL.createObjectURL(new Blob([f.buf], { type: f.type || 'image/jpeg' })); } catch (e) { vorschau.url = ''; }
        $('foto-bild').src = vorschau.url || f.thumb;
      } else {
        $('foto-bild').removeAttribute('src');
      }
    }
    $('foto-text-lang').textContent = zustand.fotoLaeuft ? 'Foto wird verarbeitet …' : (f ? 'Neues Foto' : 'Foto aufnehmen');
    $('foto-text-kurz').textContent = zustand.fotoLaeuft ? '…' : (f ? 'Neu' : 'Foto');
  }
  /* „Ohne Nummer – mit Foto“: öffnet sofort die Kamera des Geräts */
  function fotoStarten() {
    if (!zustand.aktiv) return;
    if (zustand.schritt !== 'foto') {
      zustand.schritt = 'foto';
      zustand.nummer = '';
      zustand.stueck = '';
      $('f-beschreibung').value = '';
      zeigeErfassen(); // stoppt die eingebettete Kamera, damit die Foto-App sie bekommt
      entwurfMerken();
    }
    fotoAufnehmen();
  }
  function fotoAufnehmen() {
    if (zustand.fotoLaeuft) return;
    var eingabe = $('f-foto');
    eingabe.value = '';
    eingabe.click();
  }
  function fotoGewaehlt() {
    var eingabe = $('f-foto');
    var datei = eingabe.files && eingabe.files[0];
    if (!datei || zustand.schritt !== 'foto') return;
    var lauf = ++zustand.fotoLauf;
    zustand.fotoLaeuft = true;
    zeigeFoto();
    fotoVerarbeiten(datei).then(function (foto) {
      if (lauf !== zustand.fotoLauf) return;
      zustand.entwurfFoto = foto;
      return einstellungSchreiben('entwurfFoto', foto).catch(function () { /* Entwurf ist nur Komfort */ });
    }).catch(function () {
      if (lauf === zustand.fotoLauf) fehlerMeldung('Das Foto konnte nicht verarbeitet werden. Bitte noch einmal aufnehmen.');
    }).then(function () {
      eingabe.value = '';
      if (lauf !== zustand.fotoLauf) return;
      zustand.fotoLaeuft = false;
      zeigeFoto();
    });
  }
  /* Kamera-App ohne Foto geschlossen: wenn noch gar kein Foto da ist, zurück zum vorherigen Modus */
  function fotoAbgebrochen() {
    if (zustand.schritt === 'foto' && !zustand.entwurfFoto && !zustand.fotoLaeuft && !zustand.stueck && !$('f-beschreibung').value) {
      fotoAbbrechen();
    }
  }
  function fotoAbbrechen() {
    zustand.fotoLauf++;
    zustand.fotoLaeuft = false;
    zustand.entwurfFoto = null;
    $('f-beschreibung').value = '';
    $('f-foto').value = '';
    clearTimeout(entwurfTimer);
    transaktion('einstellungen', 'readwrite', function (tx) {
      var s = tx.objectStore('einstellungen');
      s.delete('entwurf');
      s.delete('entwurfFoto');
    }).catch(function () { /* egal */ });
    neuerArtikel();
  }
  function fotoZeigen(id) {
    fotoLesen(id).then(function (foto) {
      if (!foto) { fehlerMeldung('Foto nicht gefunden.'); return; }
      var url = URL.createObjectURL(new Blob([foto.buf], { type: foto.type || 'image/jpeg' }));
      return dialog({
        titel: 'Foto',
        inhalt: [el('img', { class: 'dialog-bild', src: url, alt: 'Foto zum Eintrag' })],
        knoepfe: [{ text: 'Schließen', wert: true, klasse: 'knopf-neutral' }]
      }).then(function () { URL.revokeObjectURL(url); });
    }).catch(function () { fehlerMeldung('Foto konnte nicht geladen werden.'); });
  }

  /* ---------- Speichern ---------- */
  function gleicheNummer(nummer, ohneId) {
    var n = nummer.toLowerCase();
    return zustand.eintraege.filter(function (e) { return e.id !== ohneId && e.nummer && e.nummer.toLowerCase() === n; }).length;
  }

  function speichern() {
    if (zustand.speichert || !stueckBearbeitbar()) return;
    // Sonst würde das Foto erst nach dem Speichern fertig und am nächsten Artikel hängen
    if (zustand.fotoLaeuft) { meldung('Das Foto wird noch verarbeitet. Bitte kurz warten und dann noch einmal „Speichern“ antippen.', { dauer: 3500 }); return; }
    var mitFoto = zustand.schritt === 'foto';
    var nummer = mitFoto ? '' : bereinigen(zustand.nummer);
    var foto = mitFoto ? zustand.entwurfFoto : null;
    var bemerkung = mitFoto ? bereinigen($('f-beschreibung').value) : '';
    var stueck = stueckLesen(zustand.stueck);

    if (mitFoto && !foto) {
      fehlerMeldung('Bitte zuerst ein Foto aufnehmen.');
      return;
    }
    if (!mitFoto && !nummer) { neuerArtikel(); return; }
    if (stueck < 1) {
      $('stueck-zeile').classList.add('fehler');
      fehlerMeldung('Bitte die Stückzahl eintippen (mindestens 1).');
      return;
    }

    var eintrag = {
      ts: Date.now(),
      geraet: zustand.geraet,
      hersteller: zustand.aktiv,
      nummer: nummer,
      stueck: stueck,
      bemerkung: bemerkung,
      hatFoto: !!foto,
      thumb: foto ? foto.thumb : ''
    };
    var schonDa = nummer ? gleicheNummer(nummer, -1) : 0;
    var vorher = { schritt: zustand.schritt, nummer: zustand.nummer, stueck: zustand.stueck, foto: foto, bemerkung: $('f-beschreibung').value };

    zustand.speichert = true;
    clearTimeout(entwurfTimer); // sonst schreibt der Timer den Entwurf nach dem Speichern zurück
    // Sofort bereit für den nächsten Artikel. Der Fokus muss noch im Tipp-Ereignis gesetzt werden,
    // sonst öffnet iOS die Tastatur nicht.
    zustand.entwurfFoto = null;
    $('f-beschreibung').value = '';
    if (nummer) sperreSetzen(zustand.scanWert || nummer);
    neuerArtikel();

    transaktion(['eintraege', 'fotos', 'einstellungen'], 'readwrite', function (tx) {
      var req = tx.objectStore('eintraege').add(eintrag);
      req.onsuccess = function () {
        eintrag.id = req.result;
        if (foto) tx.objectStore('fotos').put({ buf: foto.buf, type: foto.type }, eintrag.id);
      };
      var s = tx.objectStore('einstellungen');
      s.delete('entwurf');
      s.delete('entwurfFoto');
    }).then(function () {
      zustand.eintraege.push(eintrag);
      zeigeEintraege();
      vibrieren(80);
      erfolg(['✓ ' + (nummer || 'Foto-Artikel'), '· ' + stueck + ' Stück'],
        schonDa ? 'bereits ' + schonDa + '× erfasst' : '',
        function () { rueckgaengig(eintrag); });
    }).catch(function (e) {
      // Nichts gespeichert: Eingaben wiederherstellen
      if (zustand.schritt === 'nummer' && !zustand.nummer) {
        zustand.schritt = vorher.schritt;
        zustand.nummer = vorher.nummer;
        zustand.stueck = vorher.stueck;
        zustand.entwurfFoto = vorher.foto;
        $('f-beschreibung').value = vorher.bemerkung;
        zeigeErfassen();
        entwurfMerken();
      }
      fehlerMeldung(speicherFehlerText(e));
    }).then(function () {
      zustand.speichert = false;
    });
  }

  function rueckgaengig(eintrag) {
    if (eintrag.id == null || !eintragFinden(eintrag.id)) return;
    transaktion(['eintraege', 'fotos'], 'readwrite', function (tx) {
      tx.objectStore('eintraege').delete(eintrag.id);
      tx.objectStore('fotos').delete(eintrag.id);
    }).then(function () {
      zustand.eintraege = zustand.eintraege.filter(function (x) { return x.id !== eintrag.id; });
      zeigeEintraege();
      erfolg(['Entfernt:', eintrag.nummer || 'Foto-Artikel', '· ' + eintrag.stueck + ' Stück'], '', null, true);
    }).catch(function (err) { fehlerMeldung(speicherFehlerText(err)); });
  }

  /* ---------- Bearbeiten / Löschen ---------- */
  function eintragFinden(id) { return zustand.eintraege.filter(function (e) { return e.id === id; })[0]; }

  function eintragBearbeiten(id) {
    var e = eintragFinden(id);
    if (!e) return;
    var fNummer = el('input', { class: 'eingabe', type: 'text', id: 'b-nummer', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', maxlength: '250' });
    var fStueck = el('input', { class: 'eingabe', type: 'text', id: 'b-stueck', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off' });
    var fBem = el('input', { class: 'eingabe', type: 'text', id: 'b-bemerkung', maxlength: '200', autocomplete: 'off' });
    var fehler = el('div', { class: 'dialog-fehler' });
    fNummer.value = e.nummer;
    fStueck.value = String(e.stueck);
    fBem.value = e.bemerkung || '';
    dialog({
      titel: 'Eintrag bearbeiten',
      inhalt: [
        el('p', { text: e.hersteller + ' · ' + datumText(e.ts) + ' ' + zeitText(e.ts) }),
        el('label', { class: 'feld-label', for: 'b-nummer', text: 'Artikelnummer' }), fNummer,
        el('label', { class: 'feld-label', for: 'b-stueck', text: 'Stückzahl' }), fStueck,
        el('label', { class: 'feld-label', for: 'b-bemerkung', text: 'Beschreibung' }), fBem,
        fehler
      ],
      knoepfe: [
        {
          text: 'Speichern', wert: true, klasse: 'knopf-haupt',
          pruefen: function () {
            fNummer.classList.remove('fehler');
            fStueck.classList.remove('fehler');
            if (!bereinigen(fNummer.value) && !e.hatFoto) {
              fNummer.classList.add('fehler');
              fehler.textContent = 'Artikelnummer fehlt (kein Foto vorhanden).';
              return false;
            }
            if (stueckLesen(fStueck.value) < 1) {
              fStueck.classList.add('fehler');
              fehler.textContent = 'Stückzahl: mindestens 1, nur ganze Zahlen.';
              return false;
            }
            return true;
          }
        },
        { text: 'Abbrechen', wert: false, klasse: 'knopf-neutral' }
      ]
    }).then(function (ok) {
      if (!ok) return;
      var neu = {};
      Object.keys(e).forEach(function (k) { neu[k] = e[k]; });
      neu.nummer = bereinigen(fNummer.value);
      neu.stueck = stueckLesen(fStueck.value);
      neu.bemerkung = bereinigen(fBem.value);
      neu.geaendert = Date.now();
      return transaktion('eintraege', 'readwrite', function (tx) { tx.objectStore('eintraege').put(neu); }).then(function () {
        var i = zustand.eintraege.indexOf(e);
        if (i >= 0) zustand.eintraege[i] = neu;
        zeigeEintraege();
        meldung('Änderung gespeichert.', { ok: true });
      });
    }).catch(function (err) { fehlerMeldung(speicherFehlerText(err)); });
  }

  function eintragLoeschen(id) {
    var e = eintragFinden(id);
    if (!e) return;
    frage('Eintrag löschen?', [
      (e.nummer || 'ohne Nummer (Foto)') + ' – ' + e.stueck + ' Stück – ' + e.hersteller,
      'Das kann nicht rückgängig gemacht werden.'
    ], 'Ja, löschen', 'knopf-rot').then(function (ja) {
      if (!ja) return;
      return transaktion(['eintraege', 'fotos'], 'readwrite', function (tx) {
        tx.objectStore('eintraege').delete(id);
        tx.objectStore('fotos').delete(id);
      }).then(function () {
        zustand.eintraege = zustand.eintraege.filter(function (x) { return x.id !== id; });
        zeigeEintraege();
        meldung('Eintrag gelöscht.');
      });
    }).catch(function (err) { fehlerMeldung(speicherFehlerText(err)); });
  }

  function allesLoeschen() {
    var n = zustand.eintraege.length;
    if (!n) { meldung('Es gibt keine Einträge.'); return; }
    var offen = zustand.eintraege.filter(function (e) { return (e.geaendert || e.ts) > zustand.letzterExport; }).length;
    var inhalt = ['Damit werden alle ' + n + ' Einträge und alle Fotos von diesem Gerät entfernt.'];
    if (offen) {
      inhalt.push(el('p', {
        class: 'warnung',
        text: zustand.letzterExport
          ? 'Achtung: ' + offen + ' Einträge sind seit dem letzten Export neu oder geändert. Bitte zuerst exportieren!'
          : 'Achtung: Es wurde noch nicht exportiert. Bitte zuerst exportieren – sonst ist die Zählung verloren!'
      }));
    } else {
      inhalt.push('Letzter Export: ' + datumText(zustand.letzterExport) + ' ' + zeitText(zustand.letzterExport) +
        '. Bitte vorher prüfen, ob die Export-Datei im Büro angekommen ist.');
    }
    dialog({
      titel: 'Alles löschen?',
      inhalt: inhalt,
      knoepfe: [
        { text: 'Zuerst exportieren', wert: 'export', klasse: 'knopf-haupt' },
        { text: 'Trotzdem löschen …', wert: 'weiter', klasse: 'knopf-rot-leer' },
        { text: 'Abbrechen', wert: false, klasse: 'knopf-neutral' }
      ]
    }).then(function (wahl) {
      if (wahl === 'export') { exportieren(); return; }
      if (wahl !== 'weiter') return;
      return frage('Wirklich ALLES löschen?', [
        n + ' Einträge werden endgültig gelöscht. Das kann nicht rückgängig gemacht werden.'
      ], 'Ja, alles endgültig löschen', 'knopf-rot', 'Nein, behalten').then(function (ja) {
        if (!ja) return;
        return transaktion(['eintraege', 'fotos'], 'readwrite', function (tx) {
          tx.objectStore('eintraege').clear();
          tx.objectStore('fotos').clear();
        }).then(function () {
          zustand.eintraege = [];
          zeigeEintraege();
          meldung('Alle Einträge gelöscht.');
        });
      });
    }).catch(function (err) { fehlerMeldung(speicherFehlerText(err)); });
  }

  /* ---------- CSV ---------- */
  /* Normales Textfeld: immer in Anführungszeichen; Formel-Zeichen am Anfang werden mit ' entschärft. */
  function csvFeld(wert) {
    var s = String(wert == null ? '' : wert);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  /* Artikelnummer: als Text-Formel ="…" – so behält Excel führende Nullen und lange Nummern (EAN)
     exakt bei. Der Inhalt steht als Zeichenkette in der Formel und wird nie ausgeführt. */
  function csvNummer(wert) {
    var s = String(wert == null ? '' : wert);
    if (!s) return '';
    if (s.length > 250 || /[\r\n]/.test(s)) return csvFeld(s); // Excel-Grenze für Text in Formeln
    return '"=""' + s.replace(/"/g, '""""') + '"""';
  }
  function dateiSicher(s) {
    var ers = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
    var t = String(s).replace(/[äöüÄÖÜß]/g, function (c) { return ers[c]; })
      .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return t || 'Geraet';
  }
  function fotoDateiname(e) {
    return dateiSicher(e.geraet || zustand.geraet) + '_' + ('0000' + e.id).slice(-Math.max(4, String(e.id).length)) + '.jpg';
  }
  function csvErzeugen(eintraege) {
    var zeilen = ['Datum;Uhrzeit;Gerät/Mitarbeiter;Hersteller;Artikelnummer;Stückzahl;Bemerkung;Foto-Dateiname'];
    eintraege.forEach(function (e) {
      zeilen.push([
        datumText(e.ts),
        zeitText(e.ts, true),
        csvFeld(e.geraet),
        csvFeld(e.hersteller),
        csvNummer(e.nummer),
        String(e.stueck),
        csvFeld(e.bemerkung || ''),
        e.hatFoto ? csvFeld(fotoDateiname(e)) : ''
      ].join(';'));
    });
    return '\uFEFF' + zeilen.join('\r\n') + '\r\n';
  }

  /* ---------- ZIP (ohne Kompression – JPEGs sind schon komprimiert) ---------- */
  var crcTabelle = null;
  function crc32(bytes) {
    if (!crcTabelle) {
      crcTabelle = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTabelle[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTabelle[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(text) {
    if (window.TextEncoder) return new TextEncoder().encode(text);
    var s = unescape(encodeURIComponent(text)), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  /* dateien: [{ name, daten: Uint8Array, zeit: ms }] -> Blob */
  function zipErzeugen(dateien) {
    var teile = [], zentral = [], offset = 0;
    dateien.forEach(function (d) {
      var name = utf8(d.name);
      var t = new Date(d.zeit || Date.now());
      var dosZeit = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1);
      var dosDatum = ((Math.max(1980, t.getFullYear()) - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
      var crc = crc32(d.daten), groesse = d.daten.length;

      var lokal = new DataView(new ArrayBuffer(30));
      lokal.setUint32(0, 0x04034b50, true);
      lokal.setUint16(4, 20, true);
      lokal.setUint16(6, 0x0800, true); // Dateinamen in UTF-8
      lokal.setUint16(8, 0, true);      // gespeichert, nicht komprimiert
      lokal.setUint16(10, dosZeit, true);
      lokal.setUint16(12, dosDatum, true);
      lokal.setUint32(14, crc, true);
      lokal.setUint32(18, groesse, true);
      lokal.setUint32(22, groesse, true);
      lokal.setUint16(26, name.length, true);
      lokal.setUint16(28, 0, true);
      teile.push(lokal.buffer, name, d.daten);

      var z = new DataView(new ArrayBuffer(46));
      z.setUint32(0, 0x02014b50, true);
      z.setUint16(4, 20, true);
      z.setUint16(6, 20, true);
      z.setUint16(8, 0x0800, true);
      z.setUint16(10, 0, true);
      z.setUint16(12, dosZeit, true);
      z.setUint16(14, dosDatum, true);
      z.setUint32(16, crc, true);
      z.setUint32(20, groesse, true);
      z.setUint32(24, groesse, true);
      z.setUint16(28, name.length, true);
      z.setUint32(42, offset, true);
      zentral.push(z.buffer, name);

      offset += 30 + name.length + groesse;
    });
    var zentralGroesse = 0;
    zentral.forEach(function (t) { zentralGroesse += t.byteLength; });
    var ende = new DataView(new ArrayBuffer(22));
    ende.setUint32(0, 0x06054b50, true);
    ende.setUint16(8, dateien.length, true);
    ende.setUint16(10, dateien.length, true);
    ende.setUint32(12, zentralGroesse, true);
    ende.setUint32(16, offset, true);
    return new Blob(teile.concat(zentral, [ende.buffer]), { type: 'application/zip' });
  }

  /* ---------- Export ---------- */
  var exportLaeuft = false;
  function exportieren() {
    if (exportLaeuft) return;
    var eintraege = zustand.eintraege.slice().sort(function (a, b) { return a.ts - b.ts || a.id - b.id; });
    if (!eintraege.length) { meldung('Es gibt noch nichts zu exportieren.'); return; }
    exportLaeuft = true;
    var knopf = $('btn-export');
    knopf.disabled = true;
    knopf.textContent = 'Export wird erstellt …';

    var jetzt = Date.now();
    var basis = 'inventur_' + dateiSicher(zustand.geraet) + '_' + datumIso(jetzt);
    var dateien = [{ name: basis + '.csv', daten: utf8(csvErzeugen(eintraege)), zeit: jetzt }];
    var mitFoto = eintraege.filter(function (e) { return e.hatFoto; });
    var fehlend = 0;

    var kette = Promise.resolve();
    mitFoto.forEach(function (e) {
      kette = kette.then(function () { return fotoLesen(e.id); }).then(function (foto) {
        if (!foto) { fehlend++; return; }
        dateien.push({ name: 'fotos/' + fotoDateiname(e), daten: new Uint8Array(foto.buf), zeit: e.ts });
      });
    });

    kette.then(function () {
      var blob = zipErzeugen(dateien);
      dateien = null;
      var zipName = basis + '.zip';
      var url = URL.createObjectURL(blob);
      // Als exportiert gilt erst, wenn die Datei wirklich heruntergeladen oder geteilt wurde
      var exportGemerkt = function () {
        zustand.letzterExport = jetzt;
        einstellungSchreiben('letzterExport', jetzt).catch(function () { /* egal */ });
        zeigeEintraege();
      };

      var inhalt = [
        eintraege.length + (eintraege.length === 1 ? ' Eintrag' : ' Einträge') + ' und ' +
          (mitFoto.length - fehlend) + (mitFoto.length - fehlend === 1 ? ' Foto' : ' Fotos') + ' in der Datei:',
        el('p', {}, el('strong', { text: zipName })),
        el('a', { class: 'knopf knopf-haupt knopf-breit', id: 'export-download', href: url, download: zipName, text: 'Datei herunterladen', onclick: exportGemerkt })
      ];
      if (fehlend) inhalt.splice(1, 0, el('p', { class: 'warnung', text: fehlend + ' Foto(s) konnten nicht gelesen werden.' }));

      var datei = null;
      try { datei = new File([blob], zipName, { type: 'application/zip' }); } catch (e) { datei = null; }
      var teilbar = false;
      try { teilbar = !!(datei && navigator.canShare && navigator.canShare({ files: [datei] })); } catch (e) { teilbar = false; }
      if (teilbar) {
        inhalt.push(el('button', {
          type: 'button', class: 'knopf knopf-neutral knopf-breit', id: 'export-teilen',
          text: 'Teilen / Senden …',
          onclick: function () {
            navigator.share({ files: [datei], title: zipName }).then(exportGemerkt).catch(function (err) {
              if (err && err.name !== 'AbortError') fehlerMeldung('Teilen hat nicht geklappt. Bitte „Datei herunterladen“ benutzen.');
            });
          }
        }));
      }
      inhalt.push(el('p', { class: 'hinweis', text: 'Die Daten bleiben auf dem Gerät, bis sie hier gelöscht werden.' }));

      return dialog({
        titel: 'Export fertig',
        inhalt: inhalt,
        knoepfe: [{ text: 'Schließen', wert: true, klasse: 'knopf-neutral' }]
      }).then(function () {
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000); // laufenden Download nicht abschneiden
      });
    }).catch(function () {
      fehlerMeldung('Export hat nicht geklappt. Bitte noch einmal versuchen.');
    }).then(function () {
      exportLaeuft = false;
      knopf.disabled = false;
      knopf.textContent = 'Exportieren (Datei fürs Büro)';
      zeigeEintraege();
    });
  }

  /* ---------- Scanner (Kamerabild direkt im Reiter „Erfassen“) ---------- */
  var WUNSCH_FORMATE = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e',
    'databar', 'databar_expanded', 'databar_limited', 'qr_code', 'micro_qr_code', 'data_matrix', 'aztec', 'pdf417'];
  var MUSS_FORMATE = ['code_128', 'code_39', 'ean_13', 'qr_code', 'data_matrix'];
  var FORMATE_2D = ['qr_code', 'micro_qr_code', 'data_matrix', 'aztec', 'pdf417'];
  var SPERRE_MS = 4000;  // gleicher Code löst frühestens nach dieser Zeit wieder aus …
  var WEG_RUNDEN = 5;    // … oder wenn er in so vielen Erkennungs-Runden hintereinander fehlte
  var WEG_MS = 800;      //     und dabei mindestens so lange aus dem Bild war

  var scan = {
    aktiv: false, stream: null, spur: null, licht: false, lauf: 0, detektor: null, nativ: false, audio: null,
    fehler: false,       // Kamerafehler wird angezeigt – nicht von selbst neu starten
    erkennen: false,     // false = Erkennung pausiert (Treffer wird gerade bearbeitet)
    sperreWert: '', sperreBis: 0, fehltRunden: 0, fehltSeit: 0
  };
  var ersatzVersprechen = null;

  function sperreSetzen(wert) {
    scan.sperreWert = wert || '';
    scan.sperreBis = Date.now() + SPERRE_MS;
    scan.fehltRunden = 0;
    scan.fehltSeit = 0;
  }
  /* Nach jeder Erkennungs-Runde: ist der gesperrte Code noch im Bild? */
  function sperrePruefen(werte, jetzt) {
    if (!scan.sperreWert) return;
    if (jetzt > scan.sperreBis) { scan.sperreWert = ''; return; }
    if (werte.indexOf(scan.sperreWert) >= 0) { scan.fehltRunden = 0; scan.fehltSeit = 0; return; }
    if (!scan.fehltSeit) scan.fehltSeit = jetzt;
    scan.fehltRunden++;
    if (scan.fehltRunden >= WEG_RUNDEN && jetzt - scan.fehltSeit >= WEG_MS) scan.sperreWert = '';
  }

  function skriptLaden(src) {
    return new Promise(function (ok, fehler) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { s.remove(); fehler(new Error('Skript nicht ladbar: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function formateWaehlen(unterstuetzt) {
    return WUNSCH_FORMATE.filter(function (f) { return unterstuetzt.indexOf(f) >= 0; });
  }
  /* Ersatz-Decoder (ZXing als WebAssembly, lokal im Ordner vendor/) – für iOS und Geräte ohne eingebauten Scanner. */
  function ersatzDetektor() {
    if (!ersatzVersprechen) {
      ersatzVersprechen = skriptLaden('vendor/barcode-detector.js').then(function () {
        var api = window.BarcodeDetectionAPI;
        api.prepareZXingModule({ overrides: { locateFile: function () { return 'vendor/zxing_reader.wasm'; } } });
        return api.BarcodeDetector.getSupportedFormats().then(function (f) {
          return new api.BarcodeDetector({ formats: formateWaehlen(f) });
        });
      });
      ersatzVersprechen.catch(function () { ersatzVersprechen = null; });
    }
    return ersatzVersprechen;
  }
  function detektorHolen() {
    if (scan.detektor) return Promise.resolve(scan.detektor);
    var nativ = Promise.resolve(null);
    if ('BarcodeDetector' in window && window.BarcodeDetector.getSupportedFormats) {
      nativ = window.BarcodeDetector.getSupportedFormats().then(function (f) {
        var reicht = MUSS_FORMATE.every(function (m) { return f.indexOf(m) >= 0; });
        return reicht ? new window.BarcodeDetector({ formats: formateWaehlen(f) }) : null;
      }).catch(function () { return null; });
    }
    return nativ.then(function (d) {
      if (d) { scan.nativ = true; scan.detektor = d; return d; }
      return ersatzDetektor().then(function (e) { scan.nativ = false; scan.detektor = e; return e; });
    });
  }

  function kameraFehlerText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') {
      return 'Die Kamera ist für diese Seite nicht erlaubt. Bitte in den Browser-Einstellungen den Kamera-Zugriff erlauben – oder die Nummer eintippen.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'Keine Kamera gefunden. Bitte die Nummer eintippen.';
    if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return 'Die Kamera wird gerade von einer anderen App benutzt. Bitte die andere App schließen und noch einmal versuchen.';
    return 'Die Kamera konnte nicht gestartet werden. Bitte die Nummer eintippen.';
  }

  function piepen() {
    try {
      var ctx = scan.audio;
      if (!ctx || ctx.state !== 'running') return;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 1320;
      g.gain.value = 0.15;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.12);
    } catch (e) { /* Ton ist nur Zugabe */ }
  }
  /* Ton muss durch ein Antippen freigeschaltet werden (iOS) */
  function tonFreischalten() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !scan.audio) scan.audio = new AC();
      if (scan.audio && scan.audio.state === 'suspended') scan.audio.resume();
    } catch (e) { /* egal */ }
  }

  function kameraSoll() {
    return zustand.seite === 'erfassen' && !document.hidden && !!zustand.aktiv && !!db && !dialogOffenStart &&
      zustand.modus === 'scan' && (zustand.schritt === 'nummer' || zustand.schritt === 'stueck') && !scan.fehler;
  }
  /* Startet/stoppt die Kamera passend zum Zustand (Reiter, Modus, Schritt, Sichtbarkeit) */
  function kameraAbgleichen() {
    var soll = kameraSoll();
    if (soll && !scan.aktiv) kameraStarten();
    else if (!soll && scan.aktiv) kameraStoppen();
    var vorher = scan.erkennen;
    scan.erkennen = soll && zustand.schritt === 'nummer';
    if (scan.erkennen && !vorher && scan.sperreWert) sperreSetzen(scan.sperreWert); // Sperrzeit zählt ab jetzt
  }

  function kameraStoppen() {
    scan.aktiv = false;
    scan.erkennen = false;
    scan.lauf++;
    var video = $('scanner-video');
    if (scan.stream) {
      scan.stream.getTracks().forEach(function (t) { try { t.onended = null; t.stop(); } catch (e) { /* egal */ } });
    }
    scan.stream = null;
    scan.spur = null;
    scan.licht = false;
    try { video.pause(); } catch (e) { /* egal */ }
    video.srcObject = null;
    video.removeAttribute('src');
    $('btn-licht').classList.add('versteckt');
    $('kamera-text').textContent = 'Kamera ist aus';
  }

  function kameraFehler(text) {
    kameraStoppen();
    scan.fehler = true;
    $('kamera-fehler-text').textContent = text;
    $('kamera-fehler').classList.remove('versteckt');
    $('kamera-text').classList.add('versteckt');
  }
  function kameraNochmal() {
    scan.fehler = false;
    $('kamera-fehler').classList.add('versteckt');
    $('kamera-text').classList.remove('versteckt');
    kameraAbgleichen();
  }

  function kameraStarten() {
    if (scan.aktiv) return;
    $('kamera-fehler').classList.add('versteckt');
    $('kamera-text').classList.remove('versteckt');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      kameraFehler(window.isSecureContext === false
        ? 'Die Kamera funktioniert nur über eine sichere Adresse (https). Bitte die Nummer eintippen.'
        : 'Dieses Gerät erlaubt hier keinen Kamera-Zugriff. Bitte die Nummer eintippen.');
      return;
    }
    scan.aktiv = true;
    var lauf = ++scan.lauf;
    var video = $('scanner-video');
    var text = $('kamera-text');
    text.textContent = 'Kamera startet …';

    var kamera = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    var detektor = detektorHolen();
    detektor.catch(function () { /* wird unten behandelt */ });

    kamera.then(function (stream) {
      if (lauf !== scan.lauf) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      scan.stream = stream;
      scan.spur = stream.getVideoTracks()[0] || null;
      video.srcObject = stream;
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay greift trotzdem */ });
      try {
        var faehig = scan.spur && scan.spur.getCapabilities ? scan.spur.getCapabilities() : {};
        if (faehig && faehig.torch) {
          $('btn-licht').textContent = 'Licht an';
          $('btn-licht').classList.remove('versteckt');
        }
      } catch (e) { /* kein Licht */ }
      if (scan.spur) {
        scan.spur.onended = function () {
          if (lauf === scan.lauf && scan.aktiv) kameraFehler('Die Kamera wurde beendet. Bitte noch einmal versuchen – oder die Nummer eintippen.');
        };
      }

      return detektor.then(function (d) {
        if (lauf !== scan.lauf) return;
        text.textContent = 'Code in den Rahmen halten';
        return scanSchleife(lauf, d);
      }, function () {
        if (lauf !== scan.lauf) return;
        kameraFehler('Der Scanner konnte nicht geladen werden. Bitte die App einmal mit Internet öffnen – oder die Nummer eintippen.');
      });
    }, function (e) {
      if (lauf !== scan.lauf) return;
      kameraFehler(kameraFehlerText(e));
    }).catch(function () {
      if (lauf !== scan.lauf) return;
      kameraFehler('Beim Scannen ist ein Fehler aufgetreten. Bitte noch einmal versuchen – oder die Nummer eintippen.');
    });
  }

  function scanSchleife(lauf, detektor) {
    var video = $('scanner-video');
    var letzter = '', fehler = 0;
    function runde() {
      if (lauf !== scan.lauf || !scan.aktiv) return Promise.resolve();
      if (!scan.erkennen) { letzter = ''; return warte(150).then(runde); }
      if (video.readyState < 2 || !video.videoWidth) return warte(100).then(runde);
      return detektor.detect(video).then(function (codes) {
        fehler = 0;
        if (lauf !== scan.lauf) return;
        if (!scan.erkennen) return runde();
        var gelesen = (codes || []).filter(function (c) { return c && c.rawValue && bereinigen(c.rawValue); });
        sperrePruefen(gelesen.map(function (c) { return bereinigen(c.rawValue); }), Date.now());
        var treffer = gelesen.filter(function (c) { return bereinigen(c.rawValue) !== scan.sperreWert; })[0];
        if (!treffer) { letzter = ''; return warte(80).then(runde); }
        // Strichcodes müssen zweimal hintereinander gleich gelesen werden (gegen Fehllesungen)
        if (FORMATE_2D.indexOf(treffer.format) < 0 && treffer.rawValue !== letzter) {
          letzter = treffer.rawValue;
          return warte(40).then(runde);
        }
        letzter = '';
        scanTreffer(treffer.rawValue);
        return warte(100).then(runde);
      }, function (e) {
        if (lauf !== scan.lauf) return;
        fehler++;
        // Eingebauter Scanner defekt/nicht verfügbar -> auf mitgelieferten Decoder umschalten
        if (scan.nativ && fehler >= 3) {
          return ersatzDetektor().then(function (ers) {
            scan.nativ = false;
            scan.detektor = ers;
            detektor = ers;
            fehler = 0;
            return runde();
          });
        }
        if (fehler >= 25) throw e;
        return warte(150).then(runde);
      });
    }
    return runde();
  }

  function scanTreffer(wert) {
    var nummer = bereinigen(wert);
    if (!nummer || zustand.schritt !== 'nummer') return;
    scan.erkennen = false; // Erkennung pausiert, bis gespeichert oder verworfen wird
    piepen();
    vibrieren(120);
    nummerGefunden(nummer, nummer);
  }

  function lichtUmschalten() {
    if (!scan.spur) return;
    var an = !scan.licht;
    scan.spur.applyConstraints({ advanced: [{ torch: an }] }).then(function () {
      scan.licht = an;
      $('btn-licht').textContent = an ? 'Licht aus' : 'Licht an';
    }).catch(function () { $('btn-licht').classList.add('versteckt'); });
  }

  /* ---------- Tastatur (Ziffern, Löschen, Enter = Speichern) ---------- */
  function tasteGedrueckt(ev) {
    if (dialogOffen || !stueckBearbeitbar()) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (/^[0-9]$/.test(ev.key)) { ev.preventDefault(); ziffer(ev.key); }
    else if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); zifferWeg(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); speichern(); }
  }

  /* ---------- Updates: neue Version sichtbar machen, ohne Eingaben zu verlieren ---------- */
  var UPDATE_RELOAD = 'inventur-update-reload';   // sessionStorage: Zeitpunkt des letzten Update-Neuladens
  var UPDATE_EINGABE = 'inventur-update-eingabe'; // sessionStorage: angefangene Textfelder über das Neuladen retten
  var UPDATE_PRUEF_ABSTAND = 60000;
  var update = { reg: null, letztePruefung: 0, verfuegbar: false, laedt: false };
  var startBereit = Promise.resolve();

  function sitzungLesen(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function sitzungSchreiben(k, v) {
    try { window.sessionStorage.setItem(k, v); return window.sessionStorage.getItem(k) === v; } catch (e) { return false; }
  }
  function sitzungLoeschen(k) { try { window.sessionStorage.removeItem(k); } catch (e) { /* egal */ } }

  /* Ist gerade etwas angefangen, das ein Neuladen stören würde? */
  function eingabeLaeuft() {
    if (!db || dialogOffen || dialogOffenStart) return true;
    if (zustand.speichert || zustand.fotoLaeuft) return true;
    if (zustand.schritt !== 'nummer' || zustand.nummer || zustand.stueck || zustand.entwurfFoto) return true;
    if (bereinigen($('f-nummer').value) || bereinigen($('f-beschreibung').value) || bereinigen($('f-hersteller-neu').value)) return true;
    if (erfolgRueckgaengig) return true; // „Rückgängig“ ist noch möglich
    return false;
  }

  function updateBalkenZeigen() {
    update.verfuegbar = true;
    $('update-balken').classList.remove('versteckt');
  }

  /* Entwurf sichern, dann neu laden */
  function updateLaden() {
    if (update.laedt) return;
    if (zustand.speichert || zustand.fotoLaeuft) {
      meldung(zustand.fotoLaeuft ? 'Das Foto wird noch verarbeitet. Bitte gleich noch einmal tippen.' : 'Es wird noch gespeichert. Bitte gleich noch einmal tippen.', { dauer: 3500 });
      return;
    }
    update.laedt = true;
    sitzungSchreiben(UPDATE_RELOAD, String(Date.now()));
    sitzungSchreiben(UPDATE_EINGABE, JSON.stringify({
      nummer: zustand.schritt === 'nummer' ? $('f-nummer').value : '',
      herstellerNeu: $('f-hersteller-neu').value
    }));
    var sichern = db ? entwurfSchreiben() : Promise.resolve();
    sichern.catch(function () { /* Entwurf ist nur Komfort */ }).then(function () { location.reload(); });
  }

  /* Neuer Service Worker hat übernommen */
  function updateUebernommen() {
    if (update.verfuegbar || update.laedt) return;
    startBereit.then(function () {
      if (update.verfuegbar || update.laedt) return;
      var letzter = sitzungLesen(UPDATE_RELOAD);
      // Endlos-Schutz: nur automatisch neu laden, wenn das nicht gerade erst passiert ist
      // (und sessionStorage funktioniert – sonst lässt sich das nicht prüfen).
      var autoErlaubt = sitzungSchreiben('inventur-update-test', '1') &&
        !(letzter && Date.now() - Number(letzter) < 30000);
      sitzungLoeschen('inventur-update-test');
      if (autoErlaubt && !eingabeLaeuft()) updateLaden();
      else updateBalkenZeigen();
    });
  }

  function updatePruefen() {
    if (!update.reg || document.visibilityState !== 'visible') return;
    var jetzt = Date.now();
    if (jetzt - update.letztePruefung < UPDATE_PRUEF_ABSTAND) return;
    update.letztePruefung = jetzt;
    update.reg.update().catch(function () { /* offline – später wieder */ });
  }

  /* Nach einem Update-Neuladen die angefangenen Textfelder zurückholen */
  function updateEingabeZurueck() {
    var roh = sitzungLesen(UPDATE_EINGABE);
    if (!roh) return;
    sitzungLoeschen(UPDATE_EINGABE);
    var e;
    try { e = JSON.parse(roh) || {}; } catch (x) { return; }
    if (typeof e.nummer === 'string' && e.nummer && zustand.schritt === 'nummer') $('f-nummer').value = e.nummer.slice(0, 250);
    if (typeof e.herstellerNeu === 'string' && e.herstellerNeu) $('f-hersteller-neu').value = e.herstellerNeu.slice(0, 60);
  }

  function serviceWorkerEinrichten() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    var sw = navigator.serviceWorker;
    var hatteController = !!sw.controller;
    sw.addEventListener('controllerchange', function () {
      if (!hatteController) { hatteController = true; return; } // Erststart: nichts zu tun
      updateUebernommen();
    });
    document.addEventListener('visibilitychange', updatePruefen);
    window.addEventListener('load', function () {
      sw.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        update.reg = reg;
        update.letztePruefung = Date.now(); // register() prüft selbst schon
      }).catch(function () { /* App läuft auch ohne */ });
    });
  }

  /* ---------- Start ---------- */
  var dialogOffenStart = false; // beim ersten Start (Name eintragen) bleibt die Kamera aus

  function ereignisse() {
    Array.prototype.forEach.call(document.querySelectorAll('.reiter-knopf'), function (b) {
      b.addEventListener('click', function () { zeigeSeite(b.getAttribute('data-seite')); });
    });
    $('hersteller-anzeige').addEventListener('click', function () { zeigeSeite('hersteller'); });
    $('btn-hersteller-waehlen').addEventListener('click', function () { zeigeSeite('hersteller'); });

    $('btn-modus-scan').addEventListener('click', function () { modusSetzen('scan'); });
    $('btn-modus-hand').addEventListener('click', function () { modusSetzen('hand'); });

    $('btn-licht').addEventListener('click', lichtUmschalten);
    $('btn-zur-hand').addEventListener('click', function () { modusSetzen('hand'); });
    $('btn-kamera-nochmal').addEventListener('click', kameraNochmal);
    document.addEventListener('visibilitychange', kameraAbgleichen);
    window.addEventListener('pagehide', function () { if (scan.aktiv) kameraStoppen(); });
    window.addEventListener('pageshow', function (ev) { if (ev.persisted) kameraAbgleichen(); });
    document.addEventListener('pointerdown', tonFreischalten, true);
    document.addEventListener('keydown', tonFreischalten, true);

    $('f-nummer').addEventListener('input', function () { this.classList.remove('fehler'); });
    $('f-nummer').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); handWeiter(); } });
    $('btn-weiter').addEventListener('click', handWeiter);
    $('nummer-anzeige').addEventListener('click', nummerKorrigieren);
    $('btn-verwerfen').addEventListener('click', nummerVerwerfen);

    // Ziffernblock: Tasten nehmen keinen Fokus (sonst löst Enter die zuletzt getippte Taste erneut aus)
    $('tasten').addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    Array.prototype.forEach.call(document.querySelectorAll('#tasten [data-ziffer]'), function (b) {
      b.addEventListener('click', function () { ziffer(b.getAttribute('data-ziffer')); });
    });
    $('btn-ziffer-weg').addEventListener('click', zifferWeg);
    $('btn-speichern').addEventListener('click', speichern);
    document.addEventListener('keydown', tasteGedrueckt);

    $('btn-foto').addEventListener('click', fotoStarten);
    $('btn-foto-neu').addEventListener('click', fotoAufnehmen);
    $('btn-foto-abbrechen').addEventListener('click', fotoAbbrechen);
    $('f-foto').addEventListener('change', fotoGewaehlt);
    $('f-foto').addEventListener('cancel', fotoAbgebrochen);
    $('f-beschreibung').addEventListener('input', entwurfMerken);
    $('f-beschreibung').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); this.blur(); } });

    $('btn-hersteller-neu').addEventListener('click', herstellerHinzufuegen);
    $('f-hersteller-neu').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); herstellerHinzufuegen(); } });
    $('f-hersteller-neu').addEventListener('input', function () { this.classList.remove('fehler'); });

    $('btn-export').addEventListener('click', exportieren);
    $('btn-geraet').addEventListener('click', function () {
      geraetAbfragen(false).catch(function (e) { fehlerMeldung(speicherFehlerText(e)); });
    });
    $('btn-alles-loeschen').addEventListener('click', allesLoeschen);

    $('meldung').addEventListener('click', meldungWeg);
    $('update-balken').addEventListener('click', updateLaden);
    $('btn-rueckgaengig').addEventListener('click', function () {
      var fn = erfolgRueckgaengig;
      erfolgWeg();
      if (fn) fn();
    });
    $('erfolg').addEventListener('click', function (ev) { if (ev.target === this || ev.target.closest('.erfolg-text')) erfolgWeg(); });
    $('dialog-hintergrund').addEventListener('click', function (ev) {
      if (ev.target === this && dialogOffen && dialogOffen.schliessbar) dialogOffen.schliessen(false);
    });
  }

  function laden() {
    return transaktion(['eintraege', 'einstellungen'], 'readonly', function (tx) {
      var erg = {};
      var s = tx.objectStore('einstellungen');
      ['geraet', 'hersteller', 'aktiv', 'letzterExport', 'entwurf', 'entwurfFoto', 'modus'].forEach(function (k) {
        var r = s.get(k);
        r.onsuccess = function () { erg[k] = r.result; };
      });
      var re = tx.objectStore('eintraege').getAll();
      re.onsuccess = function () { erg.eintraege = re.result || []; };
      return erg;
    });
  }

  function start() {
    $('version').textContent = 'Version ' + VERSION + ' · Daten liegen nur auf diesem Gerät';
    ereignisse();
    zeigeErfassen();

    var bereitMelden;
    startBereit = new Promise(function (r) { bereitMelden = r; });
    dbOeffnen().then(function (d) {
      db = d;
      return laden();
    }).then(function (erg) {
      zustand.geraet = erg.geraet || '';
      zustand.eintraege = erg.eintraege;
      zustand.letzterExport = erg.letzterExport || 0;
      zustand.modus = erg.modus === 'hand' ? 'hand' : 'scan';
      var ersterStart = !Array.isArray(erg.hersteller);
      zustand.hersteller = ersterStart ? STANDARD_HERSTELLER.slice() : erg.hersteller;
      zustand.aktiv = zustand.hersteller.indexOf(erg.aktiv) >= 0 ? erg.aktiv : '';
      entwurfUebernehmen(erg.entwurf, erg.entwurfFoto);
      updateEingabeZurueck();

      dialogOffenStart = !zustand.geraet;
      zeigeKopf();
      zeigeEintraege();
      zeigeHersteller(); // zeigt auch „Erfassen“ an und startet ggf. die Kamera
      bereitMelden(); // ab hier kann ein Update entscheiden, ob neu geladen werden darf

      var weiter = ersterStart ? herstellerSpeichern() : Promise.resolve();
      return weiter.then(function () {
        if (!zustand.geraet) return geraetAbfragen(true);
      }).then(function () {
        dialogOffenStart = false;
        zeigeErfassen();
        if (zustand.modus === 'hand' && zustand.schritt === 'nummer' && zustand.aktiv) fokusNummer();
      });
    }).catch(function () {
      bereitMelden();
      dialog({
        titel: 'Speicher nicht verfügbar',
        inhalt: [
          'Die App kann auf diesem Gerät nichts speichern. Häufige Ursache: „Privates Surfen“ ist eingeschaltet oder der Gerätespeicher ist voll.',
          'Bitte die Seite in einem normalen Browser-Fenster öffnen und neu laden.'
        ],
        knoepfe: [{ text: 'Neu laden', wert: true, klasse: 'knopf-haupt' }],
        schliessbar: false
      }).then(function () { location.reload(); });
    });

    // Browser bitten, die Daten nicht von selbst zu löschen
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* egal */ });
    } catch (e) { /* egal */ }

    // Offline-Betrieb und Updates
    serviceWorkerEinrichten();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
