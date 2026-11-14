Mitgelieferte Bibliotheken (werden von build.py in index.html eingebettet, kein CDN):

barcode-detector.js  = npm "barcode-detector" 3.2.3, Datei dist/iife/ponyfill.js (MIT)
zxing_reader.wasm    = npm "zxing-wasm" 3.1.6, Datei dist/reader/zxing_reader.wasm (MIT),
                       enthält zxing-cpp (Apache-2.0, https://github.com/zxing-cpp/zxing-cpp)

Beide Dateien gehören zusammen (gleiche Version). Bei einem Update immer beide ersetzen,
die Versionsnummer in src/index.html erhöhen und build.py ausführen.
