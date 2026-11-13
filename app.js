/* Inventur – einfache Offline-Erfassung. Kein Server: alle Daten liegen in IndexedDB auf dem Gerät. */
(function () {
  'use strict';

  var VERSION = '1.0.1';
  var DB_NAME = 'inventur';
  var DB_VERSION = 1;
  var STANDARD_HERSTELLER = ['Schüco', 'Dormakaba', 'GEZE', 'Record', 'Sonstige'];
  var FOTO_MAX_KANTE = 1600;
  var FOTO_QUALITAET = 0.8;
  var VORSCHAU_KANTE = 160;

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
    speichert: false
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

  function stueckLesen(text) {
    var t = String(text).trim();
    if (!/^\d{1,6}$/.test(t)) return 0;
    return parseInt(t, 10);
  }

  /* ---------- Meldungen ---------- */
  var meldungTimer = null;
  function meldung(text, opts) {
    opts = opts || {};
    var m = $('meldung');
    leeren(m);
    m.appendChild(document.createTextNode(text));
    if (opts.zusatz) m.appendChild(el('small', { text: opts.zusatz }));
    m.className = 'meldung' + (opts.fehler ? ' fehler' : '');
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(function () { m.classList.add('versteckt'); }, opts.dauer || (opts.fehler ? 5000 : (opts.zusatz ? 4500 : 2500)));
  }
  function fehlerMeldung(text) { meldung(text, { fehler: true }); }

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
      (opts.knoepfe || [{ text: 'OK', wert: true, klasse: 'knopf-blau' }]).forEach(function (k) {
        kn.appendChild(el('button', {
          type: 'button',
          class: 'knopf ' + (k.klasse || 'knopf-grau'),
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
        { text: jaText, wert: true, klasse: jaKlasse || 'knopf-blau' },
        { text: neinText || 'Abbrechen', wert: false, klasse: 'knopf-grau' }
      ]
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
  function einstellungLesen(schluessel) {
    return transaktion('einstellungen', 'readonly', function (tx) { return tx.objectStore('einstellungen').get(schluessel); });
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
    ['erfassen', 'hersteller', 'liste'].forEach(function (s) {
      $('seite-' + s).classList.toggle('versteckt', s !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.reiter-knopf'), function (b) {
      var an = b.getAttribute('data-seite') === name;
      b.classList.toggle('aktiv', an);
      if (an) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
  }

  /* ---------- Anzeige ---------- */
  function zeigeKopf() {
    $('kopf-geraet').textContent = zustand.geraet;
    $('geraet-anzeige').textContent = zustand.geraet || '–';
  }

  function zeigeAktivenHersteller() {
    var box = $('hersteller-anzeige');
    box.classList.toggle('fehlt', !zustand.aktiv);
    $('hersteller-aktiv').textContent = zustand.aktiv || 'Bitte wählen';
    box.querySelector('.ha-wechseln').textContent = zustand.aktiv ? 'Wechseln' : 'Wählen';
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
        }, el('span', { text: name }), aktiv ? el('span', { class: 'haken', text: '✓ aktiv' }) : null),
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
  }

  function karte(e, mitKnoepfen) {
    var mitte = el('div', { class: 'karte-mitte' },
      el('div', { class: 'karte-nummer' + (e.nummer ? '' : ' ohne'), text: e.nummer || 'ohne Nummer (Foto)' }),
      el('div', { class: 'karte-meta', text: e.hersteller + ' · ' + datumText(e.ts) + ' ' + zeitText(e.ts) }),
      e.bemerkung ? el('div', { class: 'karte-bemerkung', text: e.bemerkung }) : null
    );
    if (mitKnoepfen) {
      mitte.appendChild(el('div', { class: 'karte-knoepfe' },
        el('button', { type: 'button', class: 'knopf knopf-grau knopf-klein', text: 'Bearbeiten', onclick: function () { eintragBearbeiten(e.id); } }),
        el('button', { type: 'button', class: 'knopf knopf-rot-leer knopf-klein', text: 'Löschen', onclick: function () { eintragLoeschen(e.id); } })
      ));
    }
    var bild = null;
    if (e.hatFoto) {
      bild = el('img', { class: 'karte-bild', alt: 'Foto ansehen', onclick: function () { fotoZeigen(e.id); } });
      if (e.thumb && /^data:image\//.test(e.thumb)) bild.src = e.thumb;
    }
    return el('div', { class: 'karte', 'data-id': String(e.id) },
      bild,
      mitte,
      el('div', { class: 'karte-rechts' },
        el('div', { class: 'karte-stueck' }, String(e.stueck), el('small', { text: ' Stk.' }))
      )
    );
  }

  function zeigeEintraege() {
    var n = zustand.eintraege.length;
    $('zaehler').textContent = n === 1 ? '1 Eintrag' : n + ' Einträge';
    $('reiter-zaehler').textContent = n ? String(n) : '';

    var sortiert = zustand.eintraege.slice().sort(function (a, b) { return b.ts - a.ts || b.id - a.id; });

    var zuletzt = $('zuletzt');
    leeren(zuletzt);
    if (!n) zuletzt.appendChild(el('div', { class: 'leer', text: 'Noch nichts erfasst.' }));
    sortiert.slice(0, 5).forEach(function (e) { zuletzt.appendChild(karte(e, false)); });

    var liste = $('liste');
    leeren(liste);
    if (!n) liste.appendChild(el('div', { class: 'leer', text: 'Noch keine Einträge.' }));
    var frag = document.createDocumentFragment();
    sortiert.forEach(function (e) { frag.appendChild(karte(e, true)); });
    liste.appendChild(frag);

    var info = $('export-info');
    if (!n) info.textContent = '';
    else if (!zustand.letzterExport) info.textContent = 'Noch nicht exportiert.';
    else {
      var neu = zustand.eintraege.filter(function (e) { return (e.geaendert || e.ts) > zustand.letzterExport; }).length;
      info.textContent = 'Letzter Export: ' + datumText(zustand.letzterExport) + ' ' + zeitText(zustand.letzterExport) +
        (neu ? ' – seitdem ' + neu + ' neu/geändert.' : ' – alles exportiert.');
    }
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
      meldung('Hersteller: ' + name);
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
    var fehler = el('div', { class: 'dialog-fehler' });
    var knoepfe = [{
      text: 'Übernehmen', wert: true, klasse: 'knopf-blau',
      pruefen: function () {
        if (bereinigen(feld.value)) return true;
        feld.classList.add('fehler');
        fehler.textContent = 'Bitte einen Namen eintragen.';
        return false;
      }
    }];
    if (!erststart) knoepfe.push({ text: 'Abbrechen', wert: false, klasse: 'knopf-grau' });
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

  /* ---------- Entwurf (schützt vor Datenverlust bei Neuladen) ---------- */
  var entwurfTimer = null;
  function entwurfMerken() {
    clearTimeout(entwurfTimer);
    entwurfTimer = setTimeout(function () {
      einstellungSchreiben('entwurf', {
        nummer: $('f-nummer').value, stueck: $('f-stueck').value, bemerkung: $('f-bemerkung').value
      }).catch(function () { /* Entwurf ist nur Komfort */ });
    }, 250);
  }
  function formularLeeren() {
    $('f-nummer').value = '';
    $('f-stueck').value = '';
    $('f-bemerkung').value = '';
    $('f-foto').value = '';
    zustand.entwurfFoto = null;
    zeigeFotoVorschau();
    ['f-nummer', 'f-stueck'].forEach(function (id) { $(id).classList.remove('fehler'); });
    clearTimeout(entwurfTimer);
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
  function zeigeFotoVorschau() {
    var f = zustand.entwurfFoto;
    $('foto-vorschau').classList.toggle('versteckt', !f);
    $('btn-foto').textContent = f ? 'Foto neu aufnehmen' : 'Foto aufnehmen';
    if (f) $('foto-bild').src = f.thumb; else $('foto-bild').removeAttribute('src');
  }
  function fotoGewaehlt() {
    var eingabe = $('f-foto');
    var datei = eingabe.files && eingabe.files[0];
    if (!datei) return;
    var knopf = $('btn-foto');
    knopf.disabled = true;
    knopf.textContent = 'Foto wird verarbeitet …';
    zustand.fotoLaeuft = true;
    fotoVerarbeiten(datei).then(function (foto) {
      zustand.entwurfFoto = foto;
      $('f-nummer').classList.remove('fehler');
      return einstellungSchreiben('entwurfFoto', foto).catch(function () { /* Entwurf ist nur Komfort */ });
    }).catch(function () {
      fehlerMeldung('Das Foto konnte nicht verarbeitet werden. Bitte noch einmal aufnehmen.');
    }).then(function () {
      eingabe.value = '';
      knopf.disabled = false;
      zustand.fotoLaeuft = false;
      zeigeFotoVorschau();
    });
  }
  function fotoEntfernen() {
    zustand.entwurfFoto = null;
    zeigeFotoVorschau();
    einstellungLoeschen('entwurfFoto').catch(function () { /* egal */ });
  }
  function fotoZeigen(id) {
    fotoLesen(id).then(function (foto) {
      if (!foto) { fehlerMeldung('Foto nicht gefunden.'); return; }
      var url = URL.createObjectURL(new Blob([foto.buf], { type: foto.type || 'image/jpeg' }));
      return dialog({
        titel: 'Foto',
        inhalt: [el('img', { class: 'dialog-bild', src: url, alt: 'Foto zum Eintrag' })],
        knoepfe: [{ text: 'Schließen', wert: true, klasse: 'knopf-grau' }]
      }).then(function () { URL.revokeObjectURL(url); });
    }).catch(function () { fehlerMeldung('Foto konnte nicht geladen werden.'); });
  }

  /* ---------- Speichern ---------- */
  function gleicheNummer(nummer, ohneId) {
    var n = nummer.toLowerCase();
    return zustand.eintraege.filter(function (e) { return e.id !== ohneId && e.nummer && e.nummer.toLowerCase() === n; }).length;
  }

  function speichern() {
    if (zustand.speichert) return;
    // Sonst würde das Foto erst nach dem Speichern fertig und am nächsten Artikel hängen
    if (zustand.fotoLaeuft) { meldung('Das Foto wird noch verarbeitet. Bitte kurz warten und noch einmal „Speichern“ antippen.'); return; }
    var fNummer = $('f-nummer'), fStueck = $('f-stueck');
    var nummer = bereinigen(fNummer.value);
    var stueck = stueckLesen(fStueck.value);
    var bemerkung = bereinigen($('f-bemerkung').value);
    var foto = zustand.entwurfFoto;
    fNummer.classList.remove('fehler');
    fStueck.classList.remove('fehler');

    if (!zustand.aktiv) {
      zeigeSeite('hersteller');
      fehlerMeldung('Bitte zuerst einen Hersteller antippen.');
      return;
    }
    if (!nummer && !foto) {
      fNummer.classList.add('fehler');
      fehlerMeldung('Artikelnummer fehlt. Bitte scannen, eintippen oder ein Foto machen.');
      fNummer.focus();
      return;
    }
    if (stueck < 1) {
      fStueck.classList.add('fehler');
      fehlerMeldung('Bitte die Stückzahl eintragen (mindestens 1, nur ganze Zahlen).');
      fStueck.focus();
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

    zustand.speichert = true;
    $('btn-speichern').disabled = true;
    clearTimeout(entwurfTimer); // sonst schreibt der Timer den Entwurf nach dem Speichern zurück
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
      formularLeeren();
      zeigeEintraege();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      meldung('Gespeichert: ' + stueck + ' × ' + (nummer || 'Foto-Artikel'),
        schonDa ? { zusatz: 'Hinweis: Diese Artikelnummer wurde bereits ' + schonDa + '× erfasst.' } : null);
    }).catch(function (e) {
      entwurfMerken();
      fehlerMeldung(speicherFehlerText(e));
    }).then(function () {
      zustand.speichert = false;
      $('btn-speichern').disabled = false;
    });
  }

  /* ---------- Bearbeiten / Löschen ---------- */
  function eintragFinden(id) { return zustand.eintraege.filter(function (e) { return e.id === id; })[0]; }

  function eintragBearbeiten(id) {
    var e = eintragFinden(id);
    if (!e) return;
    var fNummer = el('input', { class: 'eingabe', type: 'text', id: 'b-nummer', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' });
    var fStueck = el('input', { class: 'eingabe eingabe-stueck', type: 'text', id: 'b-stueck', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off' });
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
        el('label', { class: 'feld-label', for: 'b-bemerkung', text: 'Bemerkung' }), fBem,
        fehler
      ],
      knoepfe: [
        {
          text: 'Speichern', wert: true, klasse: 'knopf-gruen',
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
        { text: 'Abbrechen', wert: false, klasse: 'knopf-grau' }
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
        zustand.eintraege[zustand.eintraege.indexOf(e)] = neu;
        zeigeEintraege();
        meldung('Änderung gespeichert.');
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
        { text: 'Zuerst exportieren', wert: 'export', klasse: 'knopf-blau' },
        { text: 'Trotzdem löschen …', wert: 'weiter', klasse: 'knopf-rot-leer' },
        { text: 'Abbrechen', wert: false, klasse: 'knopf-grau' }
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
        el('a', { class: 'knopf knopf-blau knopf-breit', id: 'export-download', href: url, download: zipName, text: 'Datei herunterladen', onclick: exportGemerkt })
      ];
      if (fehlend) inhalt.splice(1, 0, el('p', { class: 'warnung', text: fehlend + ' Foto(s) konnten nicht gelesen werden.' }));

      var datei = null;
      try { datei = new File([blob], zipName, { type: 'application/zip' }); } catch (e) { datei = null; }
      var teilbar = false;
      try { teilbar = !!(datei && navigator.canShare && navigator.canShare({ files: [datei] })); } catch (e) { teilbar = false; }
      if (teilbar) {
        inhalt.push(el('button', {
          type: 'button', class: 'knopf knopf-grau knopf-breit', id: 'export-teilen', style: 'margin-top:10px',
          text: 'Teilen / Senden …',
          onclick: function () {
            navigator.share({ files: [datei], title: zipName }).then(exportGemerkt).catch(function (err) {
              if (err && err.name !== 'AbortError') fehlerMeldung('Teilen hat nicht geklappt. Bitte „Datei herunterladen“ benutzen.');
            });
          }
        }));
      }
      inhalt.push(el('p', { class: 'hinweis-klein', text: 'Die Daten bleiben auf dem Gerät, bis sie hier gelöscht werden.' }));

      return dialog({
        titel: 'Export fertig',
        inhalt: inhalt,
        knoepfe: [{ text: 'Schließen', wert: true, klasse: 'knopf-grau' }]
      }).then(function () {
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000); // laufenden Download nicht abschneiden
      });
    }).catch(function () {
      fehlerMeldung('Export hat nicht geklappt. Bitte noch einmal versuchen.');
    }).then(function () {
      exportLaeuft = false;
      knopf.disabled = false;
      knopf.textContent = 'Exportieren (ZIP-Datei)';
    });
  }

  /* ---------- Scanner ---------- */
  var WUNSCH_FORMATE = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e',
    'databar', 'databar_expanded', 'databar_limited', 'qr_code', 'micro_qr_code', 'data_matrix', 'aztec', 'pdf417'];
  var MUSS_FORMATE = ['code_128', 'code_39', 'ean_13', 'qr_code', 'data_matrix'];
  var FORMATE_2D = ['qr_code', 'micro_qr_code', 'data_matrix', 'aztec', 'pdf417'];

  var scan = { aktiv: false, stream: null, spur: null, licht: false, lauf: 0, detektor: null, nativ: false, audio: null };
  var ersatzVersprechen = null;

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
      return 'Die Kamera ist nicht erlaubt. Bitte den Kamera-Zugriff für diese Seite erlauben (Browser-Einstellungen) – oder die Nummer von Hand eintippen.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'Keine Kamera gefunden. Bitte die Nummer von Hand eintippen.';
    if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return 'Die Kamera wird gerade von einer anderen App benutzt. Bitte andere Apps schließen und noch einmal versuchen.';
    return 'Die Kamera konnte nicht gestartet werden. Bitte die Nummer von Hand eintippen.';
  }

  function piepen() {
    try {
      var ctx = scan.audio;
      if (!ctx) return;
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

  function scannerStoppen(ausVerlauf) {
    var warAktiv = scan.aktiv;
    scan.aktiv = false;
    scan.lauf++;
    var video = $('scanner-video');
    if (scan.stream) {
      scan.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* egal */ } });
    }
    scan.stream = null;
    scan.spur = null;
    scan.licht = false;
    try { video.pause(); } catch (e) { /* egal */ }
    video.srcObject = null;
    video.removeAttribute('src');
    $('scanner').classList.add('versteckt');
    $('btn-licht').classList.add('versteckt');
    if (warAktiv && !ausVerlauf && history.state && history.state.scanner) {
      try { history.back(); } catch (e) { /* egal */ }
    }
  }

  function scannerStarten() {
    if (scan.aktiv) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fehlerMeldung(window.isSecureContext === false
        ? 'Die Kamera funktioniert nur über eine sichere Adresse (https). Bitte die Nummer von Hand eintippen.'
        : 'Dieses Gerät erlaubt hier keinen Kamera-Zugriff. Bitte die Nummer von Hand eintippen.');
      return;
    }
    scan.aktiv = true;
    var lauf = ++scan.lauf;
    var video = $('scanner-video');
    var text = $('scanner-text');
    text.textContent = 'Kamera startet …';
    $('meldung').classList.add('versteckt');
    $('scanner').classList.remove('versteckt');
    try { history.pushState({ scanner: true }, ''); } catch (e) { /* egal */ }

    // Ton muss durch das Antippen freigeschaltet werden (iOS)
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !scan.audio) scan.audio = new AC();
      if (scan.audio && scan.audio.state === 'suspended') scan.audio.resume();
    } catch (e) { /* egal */ }

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
      if (scan.spur) scan.spur.onended = function () { if (lauf === scan.lauf && scan.aktiv) { scannerStoppen(); fehlerMeldung('Die Kamera wurde beendet.'); } };

      return detektor.then(function (d) {
        if (lauf !== scan.lauf) return;
        text.textContent = 'Code in den Rahmen halten';
        return scanSchleife(lauf, d);
      }, function () {
        if (lauf !== scan.lauf) return;
        scannerStoppen();
        fehlerMeldung('Der Scanner konnte nicht geladen werden. Bitte einmal mit Internet öffnen – oder die Nummer von Hand eintippen.');
      });
    }, function (e) {
      if (lauf !== scan.lauf) return;
      scannerStoppen();
      fehlerMeldung(kameraFehlerText(e));
    }).catch(function () {
      if (lauf !== scan.lauf) return;
      scannerStoppen();
      fehlerMeldung('Beim Scannen ist ein Fehler aufgetreten. Bitte die Nummer von Hand eintippen.');
    });
  }

  function scanSchleife(lauf, detektor) {
    var video = $('scanner-video');
    var letzter = '', fehler = 0;
    function runde() {
      if (lauf !== scan.lauf || !scan.aktiv) return Promise.resolve();
      if (video.readyState < 2 || !video.videoWidth) return warte(100).then(runde);
      return detektor.detect(video).then(function (codes) {
        fehler = 0;
        if (lauf !== scan.lauf) return;
        var treffer = (codes || []).filter(function (c) { return c && c.rawValue; })[0];
        if (!treffer) { letzter = ''; return warte(80).then(runde); }
        // Strichcodes müssen zweimal hintereinander gleich gelesen werden (gegen Fehllesungen)
        if (FORMATE_2D.indexOf(treffer.format) < 0 && treffer.rawValue !== letzter) {
          letzter = treffer.rawValue;
          return warte(40).then(runde);
        }
        scanTreffer(treffer.rawValue);
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
    piepen();
    try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { /* egal */ }
    scannerStoppen();
    if (!nummer) return;
    var feld = $('f-nummer');
    feld.value = nummer;
    feld.classList.remove('fehler');
    entwurfMerken();
    meldung('Code erkannt: ' + (nummer.length > 60 ? nummer.slice(0, 60) + ' …' : nummer));
    if (!$('f-stueck').value) { try { $('f-stueck').focus(); } catch (e) { /* egal */ } }
  }

  function lichtUmschalten() {
    if (!scan.spur) return;
    var an = !scan.licht;
    scan.spur.applyConstraints({ advanced: [{ torch: an }] }).then(function () {
      scan.licht = an;
      $('btn-licht').textContent = an ? 'Licht aus' : 'Licht an';
    }).catch(function () { $('btn-licht').classList.add('versteckt'); });
  }

  /* ---------- Start ---------- */
  function ereignisse() {
    Array.prototype.forEach.call(document.querySelectorAll('.reiter-knopf'), function (b) {
      b.addEventListener('click', function () { zeigeSeite(b.getAttribute('data-seite')); });
    });
    $('hersteller-anzeige').addEventListener('click', function () { zeigeSeite('hersteller'); });

    $('btn-scannen').addEventListener('click', scannerStarten);
    $('btn-scan-abbrechen').addEventListener('click', function () { scannerStoppen(); });
    $('btn-licht').addEventListener('click', lichtUmschalten);
    window.addEventListener('popstate', function () { if (scan.aktiv) scannerStoppen(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && scan.aktiv) scannerStoppen(); });
    window.addEventListener('pagehide', function () { if (scan.aktiv) scannerStoppen(true); });

    $('btn-minus').addEventListener('click', function () {
      var n = stueckLesen($('f-stueck').value);
      $('f-stueck').value = n > 1 ? String(n - 1) : '1';
      $('f-stueck').classList.remove('fehler');
      entwurfMerken();
    });
    $('btn-plus').addEventListener('click', function () {
      var n = stueckLesen($('f-stueck').value);
      $('f-stueck').value = String(Math.min(999999, n + 1));
      $('f-stueck').classList.remove('fehler');
      entwurfMerken();
    });
    $('f-stueck').addEventListener('input', function () {
      var roh = this.value, sauber = roh.replace(/\D+/g, '').slice(0, 6);
      if (roh !== sauber) this.value = sauber;
      this.classList.remove('fehler');
      entwurfMerken();
    });
    $('f-nummer').addEventListener('input', function () { this.classList.remove('fehler'); entwurfMerken(); });
    $('f-bemerkung').addEventListener('input', entwurfMerken);
    $('f-nummer').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); $('f-stueck').focus(); } });
    $('f-stueck').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); this.blur(); } });
    $('f-bemerkung').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); this.blur(); } });

    $('btn-foto').addEventListener('click', function () { $('f-foto').click(); });
    $('f-foto').addEventListener('change', fotoGewaehlt);
    $('btn-foto-weg').addEventListener('click', fotoEntfernen);
    $('btn-speichern').addEventListener('click', speichern);

    $('btn-hersteller-neu').addEventListener('click', herstellerHinzufuegen);
    $('f-hersteller-neu').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); herstellerHinzufuegen(); } });
    $('f-hersteller-neu').addEventListener('input', function () { this.classList.remove('fehler'); });

    $('btn-export').addEventListener('click', exportieren);
    $('btn-geraet').addEventListener('click', function () {
      geraetAbfragen(false).catch(function (e) { fehlerMeldung(speicherFehlerText(e)); });
    });
    $('btn-alles-loeschen').addEventListener('click', allesLoeschen);

    $('meldung').addEventListener('click', function () { this.classList.add('versteckt'); });
    $('dialog-hintergrund').addEventListener('click', function (ev) {
      if (ev.target === this && dialogOffen && dialogOffen.schliessbar) dialogOffen.schliessen(false);
    });
  }

  function laden() {
    return transaktion(['eintraege', 'einstellungen'], 'readonly', function (tx) {
      var erg = {};
      var s = tx.objectStore('einstellungen');
      ['geraet', 'hersteller', 'aktiv', 'letzterExport', 'entwurf', 'entwurfFoto'].forEach(function (k) {
        var r = s.get(k);
        r.onsuccess = function () { erg[k] = r.result; };
      });
      var re = tx.objectStore('eintraege').getAll();
      re.onsuccess = function () { erg.eintraege = re.result || []; };
      return erg;
    });
  }

  function start() {
    $('version').textContent = 'Inventur-App Version ' + VERSION + ' · Daten liegen nur auf diesem Gerät';
    ereignisse();

    dbOeffnen().then(function (d) {
      db = d;
      return laden();
    }).then(function (erg) {
      zustand.geraet = erg.geraet || '';
      zustand.eintraege = erg.eintraege;
      zustand.letzterExport = erg.letzterExport || 0;
      var ersterStart = !Array.isArray(erg.hersteller);
      zustand.hersteller = ersterStart ? STANDARD_HERSTELLER.slice() : erg.hersteller;
      zustand.aktiv = zustand.hersteller.indexOf(erg.aktiv) >= 0 ? erg.aktiv : '';
      if (erg.entwurf) {
        $('f-nummer').value = erg.entwurf.nummer || '';
        $('f-stueck').value = erg.entwurf.stueck || '';
        $('f-bemerkung').value = erg.entwurf.bemerkung || '';
      }
      if (erg.entwurfFoto && erg.entwurfFoto.buf) zustand.entwurfFoto = erg.entwurfFoto;

      zeigeKopf();
      zeigeHersteller();
      zeigeFotoVorschau();
      zeigeEintraege();

      var weiter = ersterStart ? herstellerSpeichern() : Promise.resolve();
      return weiter.then(function () {
        if (!zustand.geraet) return geraetAbfragen(true);
      }).then(function () {
        if (!zustand.aktiv) {
          zeigeSeite('hersteller');
          meldung('Bitte zuerst den Hersteller antippen.', { dauer: 4000 });
        }
      });
    }).catch(function () {
      dialog({
        titel: 'Speicher nicht verfügbar',
        inhalt: [
          'Die App kann auf diesem Gerät nichts speichern. Häufige Ursache: „Privates Surfen“ ist eingeschaltet oder der Gerätespeicher ist voll.',
          'Bitte die Seite in einem normalen Browser-Fenster öffnen und neu laden.'
        ],
        knoepfe: [{ text: 'Neu laden', wert: true, klasse: 'knopf-blau' }],
        schliessbar: false
      }).then(function () { location.reload(); });
    });

    // Browser bitten, die Daten nicht von selbst zu löschen
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* egal */ });
    } catch (e) { /* egal */ }

    // Offline-Betrieb
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* App läuft auch ohne */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
