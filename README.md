# Inventur-App

Einfache Inventur-Erfassung für Handy und Tablet (Android und iPhone/iPad): Hersteller wählen,
Artikelnummer scannen oder eintippen, Stückzahl eintragen, speichern. Für Teile ohne Nummer
reicht ein Foto. Am Ende wird pro Gerät eine ZIP-Datei exportiert.

**Kein Server.** Die App ist eine reine Webseite. Alle Daten liegen nur im Browser des jeweiligen
Geräts und funktionieren nach dem ersten Öffnen auch ohne WLAN.

## Einrichten (einmalig, GitHub Pages)

Die Kamera funktioniert nur über `https` – GitHub Pages liefert das automatisch.

1. Im Repository auf GitHub: **Settings → Pages**.
2. Unter *Build and deployment*: Source **Deploy from a branch**, Branch wählen (z. B. `main`),
   Ordner **/ (root)**, **Save**.
3. Nach 1–2 Minuten steht dort die Adresse, z. B. `https://<name>.github.io/<repo>/`.
4. Diese Adresse auf jedem Gerät **einmal mit Internet** öffnen (iPhone/iPad: in **Safari**,
   Android: in **Chrome**) und kurz warten – danach läuft die App offline.
5. Empfohlen: „Zum Home-Bildschirm“ (Safari: Teilen-Symbol; Chrome: Menü → „App installieren“).
   **Wichtig auf iPhone/iPad:** Die App vom Home-Bildschirm hat einen eigenen Datenspeicher,
   getrennt von Safari. Also entweder immer das Symbol benutzen oder immer Safari – nicht mischen.

## Benutzung

1. Beim ersten Start den **Namen bzw. Gerätenamen** eintragen (jedes Gerät einen anderen!).
2. Reiter **Hersteller**: Hersteller antippen. Er gilt für alle folgenden Einträge, bis gewechselt wird.
3. Reiter **Erfassen**: „Scannen“ (oder Nummer eintippen), Stückzahl, „Speichern“.
   Keine Nummer am Teil? „Foto aufnehmen“ – dann darf die Nummer leer bleiben.
4. Reiter **Liste**: alle Einträge ansehen, bearbeiten, löschen, exportieren.

Gleiche Artikelnummer mehrfach erfasst = mehrere Zeilen (wird nicht automatisch addiert);
beim Speichern erscheint ein Hinweis.

## Export und Zusammenführen

In **Liste → Exportieren** entsteht eine Datei `inventur_<Gerät>_<Datum>.zip` mit

- `inventur_<Gerät>_<Datum>.csv` – Spalten:
  `Datum;Uhrzeit;Gerät/Mitarbeiter;Hersteller;Artikelnummer;Stückzahl;Bemerkung;Foto-Dateiname`
- Ordner `fotos/` – die Fotos; der Dateiname steht in der letzten CSV-Spalte.

Die ZIP-Datei herunterladen oder per „Teilen“ (Mail, AirDrop …) ins Büro schicken.
Die CSV lässt sich per Doppelklick in Excel öffnen (Semikolon, UTF-8 mit BOM, Windows-Zeilenenden).

**Zusammenführen:** alle ZIPs entpacken, die CSV-Dateien in Excel öffnen und untereinander kopieren
(Kopfzeile nur einmal) – oder über *Daten → Daten abrufen → Aus Ordner*. Die Spalte
„Gerät/Mitarbeiter“ zeigt, woher eine Zeile stammt. Summen je Artikel z. B. per Pivot-Tabelle.
Die Fotos aller Geräte können in einen gemeinsamen Ordner – die Dateinamen enthalten den Gerätenamen.

**Hinweis zur Artikelnummer:** Sie steht in der CSV als `="00123"`. So behandelt Excel sie als Text;
führende Nullen bleiben erhalten und lange Nummern (EAN) werden nicht zu `4,00638E+12`. Wer die CSV
mit einem anderen Programm weiterverarbeitet, entfernt `="` am Anfang und `"` am Ende.
Andere Textfelder, die mit `=`, `+`, `-` oder `@` beginnen, bekommen ein `'` vorangestellt
(Schutz vor ungewollten Excel-Formeln).

## Wichtig: Daten liegen nur auf dem Gerät

- Es gibt keine Sicherung und keinen Abgleich zwischen Geräten.
- **Browserdaten/Website-Daten löschen = Inventur weg.** Ebenso bei privatem Surfen/Inkognito
  (dort gar nicht benutzen). Vorher immer exportieren.
- iPhone/iPad können Website-Daten löschen, wenn die Seite wochenlang nicht benutzt wurde.
  Deshalb: am Ende jedes Zähltags exportieren.
- „Alles löschen“ erst benutzen, wenn die Export-Datei im Büro angekommen und geprüft ist.

## Technik (für die Pflege)

- Dateien: `index.html`, `style.css`, `app.js`, `sw.js` (Offline-Cache), `manifest.webmanifest`,
  `icons/`, `vendor/` (Scan-Bibliothek, lokal – kein CDN). Kein Build-Schritt.
- Scannen: eingebauter `BarcodeDetector` des Browsers, wenn vorhanden (Android/Chrome); sonst der
  mitgelieferte ZXing-Decoder als WebAssembly (`vendor/`, u. a. für iPhone/iPad).
- Speicher: IndexedDB (`inventur`); Fotos werden auf max. 1600 px verkleinert (JPEG).
- **Nach jeder Änderung an der App** in `sw.js` die Zeile `var CACHE = 'inventur-v2'` hochzählen
  (`v3`, `v4` …) – sonst behalten die Geräte die alte Version. Die Geräte holen die neue Version
  beim nächsten Öffnen mit Internet; sie wird beim darauffolgenden Start aktiv.
- Lokal testen: `python3 -m http.server` im Ordner, dann `http://localhost:8000` (auf `localhost`
  geht die Kamera auch ohne https).
