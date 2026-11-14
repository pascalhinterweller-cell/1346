#!/usr/bin/env python3
"""Baut die Inventur-App aus src/ zu genau zwei Dateien im Repo-Root:

  index.html  - die komplette App in einer Datei (CSS, JS, Scan-Bibliothek, WebAssembly, Icons eingebettet)
  sw.js       - der Service Worker für den Offline-Betrieb (bleibt immer gleich)

In src/index.html steht für jede einzubettende Datei ein Platzhalter @@pfad@@ (Pfad relativ zu src/):
  .css/.js   -> Text (in <style>/<script>)
  .png       -> data:image/png;base64,...
  .wasm      -> Base64 (ohne Zeilenumbrüche)

Aufruf:  python3 build.py                   (nur Standardbibliothek)
         python3 build.py --android ORDNER  schreibt nur ORDNER/index.html für die Android-App
                                            (ohne sw.js; wird vom Gradle-Build in android/ aufgerufen)
"""
import base64
import os
import re
import sys

HIER = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HIER, 'src')
KOPF = '<!-- Inventur-App – erzeugt mit build.py aus src/. Nicht von Hand ändern. -->\n'


def lesen(rel, binaer=False):
    pfad = os.path.join(SRC, rel)
    with open(pfad, 'rb') as f:
        daten = f.read()
    return daten if binaer else daten.decode('utf-8')


def einbetten(rel):
    endung = os.path.splitext(rel)[1].lower()
    if endung in ('.css', '.js'):
        text = lesen(rel)
        # Diese Folgen würden den <style>/<script>-Block im HTML vorzeitig beenden bzw. verwirren
        for verboten in ('</script', '</style', '<!--', '<script'):
            if verboten in text.lower():
                sys.exit('Fehler: %s enthält "%s" und kann so nicht eingebettet werden.' % (rel, verboten))
        return text.rstrip('\n')
    if endung == '.png':
        return 'data:image/png;base64,' + base64.b64encode(lesen(rel, True)).decode('ascii')
    if endung == '.wasm':
        daten = lesen(rel, True)
        if daten[:4] != b'\0asm':
            sys.exit('Fehler: %s ist keine WebAssembly-Datei.' % rel)
        return base64.b64encode(daten).decode('ascii')
    sys.exit('Fehler: unbekannter Dateityp für Platzhalter @@%s@@' % rel)


def bauen():
    """Erzeugt den Inhalt von index.html; liefert (html, version)."""
    vorlage = lesen('index.html')
    platzhalter = re.findall(r'@@([A-Za-z0-9_./-]+)@@', vorlage)
    if not platzhalter:
        sys.exit('Fehler: keine Platzhalter in src/index.html gefunden.')
    teile = {rel: einbetten(rel) for rel in platzhalter}
    html = re.sub(r'@@([A-Za-z0-9_./-]+)@@', lambda m: teile[m.group(1)], vorlage)
    if not html.startswith('<!DOCTYPE html>\n'):
        sys.exit('Fehler: src/index.html muss mit <!DOCTYPE html> beginnen.')
    html = html.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + KOPF, 1)

    # Prüfen: keine Verweise auf Dateien, die es auf dem Webspace nicht mehr gibt
    for rest in re.findall(r'(?:src|href)="(?!data:|#)([^"]+)"', html):
        sys.exit('Fehler: index.html verweist noch auf eine Datei: %s' % rest)

    version = re.search(r'<meta name="inventur-version" content="([^"]+)"', html)
    return html, (version.group(1) if version else '?')


def schreiben(pfad, text):
    with open(pfad, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def main():
    html, version = bauen()
    if len(sys.argv) == 3 and sys.argv[1] == '--android':
        # Android-App: dieselbe index.html, aber ohne sw.js (die App ist ohnehin offline)
        ziel = os.path.abspath(sys.argv[2])
        os.makedirs(ziel, exist_ok=True)
        schreiben(os.path.join(ziel, 'index.html'), html)
        print('Android: %s  %s' % (os.path.join(ziel, 'index.html'), version))
        return
    if len(sys.argv) > 1:
        sys.exit('Aufruf: python3 build.py  oder  python3 build.py --android ORDNER')
    schreiben(os.path.join(HIER, 'index.html'), html)
    schreiben(os.path.join(HIER, 'sw.js'), lesen('sw.js'))
    groesse = os.path.getsize(os.path.join(HIER, 'index.html'))
    print('index.html  %s  %d Bytes (%.2f MB)' % (version, groesse, groesse / 1048576))
    print('sw.js       %d Bytes' % os.path.getsize(os.path.join(HIER, 'sw.js')))


if __name__ == '__main__':
    main()
