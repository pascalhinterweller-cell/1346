# Inventur-App

Einfache Inventur-Erfassung für Handy und Tablet (Android und iPhone/iPad): Hersteller wählen,
Artikelnummer scannen oder eintippen, Stückzahl eintragen, speichern. Für Teile ohne Nummer
reicht ein Foto. Am Ende wird pro Gerät eine ZIP-Datei exportiert.

Alle Daten liegen nur im Browser des jeweiligen Geräts. Nach dem ersten Öffnen mit Internet
läuft die App auch im Lager ohne Netz.

Für Android gibt es zusätzlich eine **echte App zum Installieren** (`Inventur-7.apk`), siehe
[Android-App](#android-app). Sie braucht nie Internet und keinen Webspace.

## Auf den Webspace gehören genau zwei Dateien

| Datei        | Wozu                                                         |
|--------------|--------------------------------------------------------------|
| `index.html` | die komplette App (alles steckt in dieser einen Datei)       |
| `sw.js`      | macht die App offline nutzbar – wird **nie** wieder geändert |

Beide Dateien in **denselben Ordner** auf dem Webspace hochladen, z. B. nach `inventur/`.
Sonst nichts. Die Adresse ist dann z. B. `https://example.de/inventur/`.

- Die Adresse muss mit `https://` beginnen, sonst geht die Kamera nicht.
- Fehlt `sw.js`, funktioniert die App trotzdem – nur nicht ohne Netz.
- **Alte Dateien** von früheren Versionen (`app.js`, `style.css`, `manifest.webmanifest`, die
  Ordner `vendor/` und `icons/`) werden nicht mehr gebraucht. Am besten löschen; falls sie
  liegen bleiben, stören sie aber nicht.

## Update einspielen

**Nur `index.html` ersetzen.** Fertig. `sw.js` bleibt, wie sie ist.

Die Geräte holen sich die neue Version beim nächsten Öffnen mit Internet von selbst. Ist die
App gerade offen und es wird nichts eingegeben, lädt sie sich neu; sonst erscheint oben der
Balken „Neue Version verfügbar – tippen zum Laden“ (der angefangene Eintrag bleibt erhalten).

## Version prüfen

Im Reiter **Liste** ganz unten **Einstellungen** aufklappen. Dort steht z. B.

- „Version v7 · Daten liegen nur auf diesem Gerät“
- „Offline bereit“ – alles in Ordnung, die App läuft auch ohne Netz.
- „Offline-Funktion aus: sw.js fehlt auf dem Webspace“ – `sw.js` hochladen (in denselben
  Ordner wie `index.html`), dann die App einmal mit Internet neu öffnen.

Zeigt ein Gerät noch die alte Version: App ganz schließen (aus der Liste der offenen Apps
wegwischen) und mit Internet neu öffnen.

## Auf dem Gerät einrichten

1. Die Adresse auf jedem Gerät **einmal mit Internet** öffnen (iPhone/iPad: in **Safari**,
   Android: in **Chrome**) und kurz warten, bis unter Einstellungen „Offline bereit“ steht.
2. Empfohlen: über das Browsermenü auf den Startbildschirm legen (Safari: Teilen-Symbol →
   „Zum Home-Bildschirm“; Chrome: Menü ⋮ → „Zum Startbildschirm hinzufügen“).
   **Wichtig auf iPhone/iPad:** Die App vom Home-Bildschirm hat einen eigenen Datenspeicher,
   getrennt von Safari. Also entweder immer das Symbol benutzen oder immer Safari – nicht mischen.

## Benutzung

1. Beim ersten Start den **Namen bzw. Gerätenamen** eintragen (jedes Gerät einen anderen!).
2. Oben im Reiter **Erfassen** steht groß der aktive **Hersteller** – antippen zum Ändern.
3. Oben zwischen **Scannen** und **Eintippen** umschalten. Die Wahl bleibt gespeichert.
   - **Scannen:** Code ins Bild halten → Nummer erscheint groß (antippen = korrigieren,
     ✕ = verwerfen) → Stückzahl auf dem Ziffernblock → **Speichern** → sofort scanbereit.
   - **Eintippen:** Artikelnummer → „Weiter“ → Stückzahl → „Speichern“.
4. Keine Nummer am Teil? **„Ohne Nummer – mit Foto“**: Foto machen, Beschreibung (freiwillig),
   Stückzahl, **Speichern**.
5. Nach dem Speichern zeigt ein grüner Balken z. B. „✓ 4711 · 12 Stück“ mit **Rückgängig**.
6. Reiter **Liste**: alle Einträge ansehen, bearbeiten, löschen, **exportieren**.

Gleiche Artikelnummer mehrfach erfasst = mehrere Zeilen (wird nicht automatisch addiert).

## Export

**Liste → Exportieren** erzeugt `inventur_<Gerät>_<Datum>.zip` mit einer CSV-Datei
(Spalten `Datum;Uhrzeit;Gerät/Mitarbeiter;Hersteller;Artikelnummer;Stückzahl;Bemerkung;Foto-Dateiname`)
und dem Ordner `fotos/`. Die CSV öffnet sich per Doppelklick in Excel. Die Artikelnummer steht
dort als `="00123"`, damit führende Nullen und lange Nummern erhalten bleiben.

Zusammenführen: alle ZIPs entpacken, die CSV-Dateien in Excel untereinander kopieren (Kopfzeile
nur einmal) – die Spalte „Gerät/Mitarbeiter“ zeigt, woher eine Zeile stammt.

## Android-App

Die Android-App ist dieselbe Inventur wie im Browser, nur fest installiert: eigenes Symbol
„Inventur“, läuft immer ohne Internet, Kamera und Export funktionieren wie gewohnt.
Geeignet ab Android 8.

### Installieren (einmal pro Gerät)

1. Die Datei `Inventur-7.apk` aufs Gerät bringen: per Link öffnen, als Mail-Anhang, über
   Google Drive oder per USB-Kabel in den Ordner „Download“ kopieren.
2. Die Datei antippen (z. B. in der App **Dateien** / **Eigene Dateien** unter „Downloads“).
3. Beim ersten Mal fragt Android: **„Aus Sicherheitsgründen ist die Installation unbekannter
   Apps aus dieser Quelle nicht erlaubt“** → **Einstellungen** → **„Dieser Quelle vertrauen“**
   bzw. **„Unbekannte Apps installieren: Zulassen“** einschalten → zurück.
   (Erlaubt wird das nur für die App, mit der die Datei geöffnet wurde, z. B. Chrome oder Dateien.)
4. **Installieren** antippen. Warnt Google Play Protect („unbekannte App“), auf
   **Trotzdem installieren** tippen – die App stammt nicht aus dem Play Store, das ist normal.
5. **Öffnen**. Beim ersten Scannen fragt die App nach der **Kamera** → **Zulassen** („Bei
   Nutzung der App“).

### Update einspielen

Einfach die **neue APK genauso drüberinstallieren** (Datei antippen → Installieren bzw.
„Aktualisieren“). **Nicht vorher deinstallieren!** Alle Einträge, Fotos und Einstellungen
bleiben erhalten. Die Version steht unter **Liste → Einstellungen**.

### Achtung: Deinstallieren löscht alle Daten

Wird die App deinstalliert (oder unter Android-Einstellungen → Apps → Inventur → Speicher
„Daten löschen“ gewählt), sind **alle Einträge und Fotos auf diesem Gerät weg**. Vorher immer
exportieren und prüfen, dass die Datei im Büro angekommen ist.

### Export in der App

**Liste → Exportieren** und dann:

- **In „Downloads“ speichern** – die ZIP-Datei liegt danach im Ordner „Download“ des Geräts
  (in der App **Dateien** unter „Downloads“), von dort per USB-Kabel oder Mail weitergeben.
- **Teilen / Senden …** – öffnet den Android-Teilen-Dialog (Mail, Drive, Teams, …).

„Exportiert“ wird erst vermerkt, wenn die Datei wirklich gespeichert wurde bzw. im
Teilen-Dialog eine App gewählt wurde.

### Bedienung

- **Zurück-Taste:** schließt zuerst offene Fenster (z. B. Foto-Ansicht), wechselt dann zum
  Reiter „Erfassen“. Läuft gerade eine Eingabe, fragt die App vorher nach. Die App wird dabei
  nie beendet, nur in den Hintergrund gelegt – angefangene Eingaben bleiben erhalten.
- Beim Scannen bleibt der Bildschirm an. Hoch- und Querformat gehen beide.
- Kamera aus Versehen verboten? Im Scanner erscheint **App-Einstellungen öffnen** → dort unter
  „Berechtigungen“ die Kamera erlauben.

Browser-Version und App haben **getrennte Daten**. Also pro Gerät nur eines von beiden benutzen
(oder vor dem Umstieg in der alten Variante exportieren).

## Wichtig: Daten liegen nur auf dem Gerät

- Keine Sicherung, kein Abgleich zwischen Geräten. **Am Ende jedes Zähltags exportieren.**
- **Browserdaten/Website-Daten löschen = Inventur weg.** Nicht im privaten Modus benutzen.
- „Alles löschen“ erst, wenn die Export-Datei im Büro angekommen und geprüft ist.

---

## Für Entwickler

- Quelltext liegt in `src/` (`index.html` als Vorlage, `app.js`, `style.css`, `sw.js`,
  `vendor/` mit der Scan-Bibliothek, `icons/`).
- `python3 build.py` (nur Standardbibliothek) erzeugt daraus im Hauptordner `index.html`
  (alles eingebettet: CSS, JS, ZXing-WebAssembly als Base64, Icons als Data-URI) und `sw.js`.
  Beide Ergebnisdateien werden mit eingecheckt.
- Die Versionsnummer steht nur in `src/index.html`: `<meta name="inventur-version" content="v6">`.
  Bei jeder Änderung hochzählen, dann `build.py` laufen lassen.
- `src/sw.js` nicht mehr ändern: Netz zuerst (max. ca. 3 s), sonst die zuletzt geladene Seite
  aus dem Cache `inventur-seite`; alte Caches `inventur-v*` werden gelöscht.
- Speicher: IndexedDB `inventur` (Schema unverändert seit v1). Kein Web-Manifest (eine
  eingebettete Manifest-Datei lässt sich auf Android/iOS nicht zuverlässig nutzen).
- Lokal testen: `python3 build.py && python3 -m http.server`, dann `http://localhost:8000`.

### Android-App bauen

- Ordner `android/`: kleines natives Android-Projekt (Java, ohne npm). Eine WebView zeigt
  dieselbe `index.html` aus den App-Assets; der Gradle-Build ruft dafür selbst
  `python3 build.py --android …` auf (ohne `sw.js`) und übernimmt das Symbol aus
  `src/icons/icon-maskable-512.png`.
- Plattform-Weichen in `src/app.js` laufen alle über `window.InventurAndroid` (Abschnitt
  „Plattform“): Export in Downloads/Teilen, Vibrieren, Bildschirm an, Zurück-Taste,
  kein Service Worker. Im Browser fehlt das Objekt, dort ändert sich nichts.
- Version: `versionName`/`versionCode` kommen aus `<meta name="inventur-version" content="v7">`
  (v7 → „7“ bzw. 7). Für jede neue APK die Version erhöhen, sonst lehnt Android das Update ab.
- Voraussetzungen: JDK 17+, Python 3, Android-SDK mit Platform 36 (`ANDROID_HOME`).
  Gradle wird von `android/gradlew` selbst geladen.
- Bauen: `./build_apk.sh /pfad/zum/schluessel-ordner` (Ordner mit `inventur.jks` und
  `passwort.txt`) oder mit `INVENTUR_KEYSTORE` + `INVENTUR_KEYSTORE_PASSWORT` (optional
  `INVENTUR_KEY_ALIAS`, Standard `inventur`). Ergebnis: `dist/Inventur-<Version>.apk`,
  geprüft mit `apksigner verify`.
- **Der Signierschlüssel gehört nicht ins Repository** (`.gitignore`) und muss sicher
  aufbewahrt werden: Updates lassen sich nur mit demselben Schlüssel installieren.
- **Nie ändern:** applicationId `de.hinterweller.inventur` und die interne Adresse
  `https://appassets.androidplatform.net/` (`MainActivity.HOST`) – daran hängen die
  gespeicherten Daten (IndexedDB) auf den Geräten.
- minSdk 26 (Android 8), targetSdk 36. Berechtigungen: Kamera, Vibrieren, Speicher (nur
  Android 8/9, für „Downloads“), Internet (nur technisch für die WebView; fremde Adressen
  werden blockiert).
