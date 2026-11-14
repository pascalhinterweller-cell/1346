#!/usr/bin/env bash
# Baut die Android-App (signierte Release-APK) in einem Schritt:
#
#   ./build_apk.sh /pfad/zum/schluessel-ordner      (Ordner mit inventur.jks und passwort.txt)
#   oder: INVENTUR_KEYSTORE=/pfad/inventur.jks INVENTUR_KEYSTORE_PASSWORT=geheim ./build_apk.sh
#
# Optional: INVENTUR_KEY_ALIAS (Standard "inventur"), INVENTUR_KEY_PASSWORT (Standard = Keystore-Passwort),
#           INVENTUR_SCHLUESSEL_ORDNER statt des Arguments, ANDROID_HOME (Android-SDK).
# Ergebnis: dist/Inventur-<Version>.apk
# Voraussetzungen: JDK 17+, Python 3, Android-SDK (Platform 36). Gradle lädt ./android/gradlew selbst.
set -euo pipefail
cd "$(dirname "$0")"

ORDNER="${1:-${INVENTUR_SCHLUESSEL_ORDNER:-}}"
if [ -n "$ORDNER" ]; then
  [ -f "$ORDNER/inventur.jks" ] && [ -f "$ORDNER/passwort.txt" ] || { echo "Fehler: $ORDNER enthält nicht inventur.jks und passwort.txt" >&2; exit 1; }
  export INVENTUR_KEYSTORE="$(cd "$ORDNER" && pwd)/inventur.jks"
  INVENTUR_KEYSTORE_PASSWORT="$(cat "$ORDNER/passwort.txt")"
  export INVENTUR_KEYSTORE_PASSWORT
fi
if [ -z "${INVENTUR_KEYSTORE:-}" ] || [ -z "${INVENTUR_KEYSTORE_PASSWORT:-}" ]; then
  echo "Fehler: Signierschlüssel fehlt. Aufruf: ./build_apk.sh /pfad/zum/schluessel-ordner" >&2
  echo "        (oder INVENTUR_KEYSTORE und INVENTUR_KEYSTORE_PASSWORT setzen)" >&2
  exit 1
fi
[ -f "$INVENTUR_KEYSTORE" ] || { echo "Fehler: Keystore $INVENTUR_KEYSTORE nicht gefunden" >&2; exit 1; }

# Android-SDK suchen
if [ -z "${ANDROID_HOME:-}" ]; then
  for k in "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" /opt/android-sdk; do
    if [ -n "$k" ] && [ -d "$k/platforms" ]; then ANDROID_HOME="$k"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "Fehler: Android-SDK nicht gefunden (ANDROID_HOME setzen)" >&2; exit 1; }
export ANDROID_HOME

VERSION="$(sed -n 's/.*<meta name="inventur-version" content="v\([0-9]*\)">.*/\1/p' src/index.html)"
[ -n "$VERSION" ] || { echo "Fehler: Version in src/index.html nicht gefunden" >&2; exit 1; }

echo "== Inventur v$VERSION: APK bauen"
(cd android && ./gradlew --no-daemon -q assembleRelease)

APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "Fehler: $APK fehlt (Signierung fehlgeschlagen?)" >&2; exit 1; }

APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify "$APK"
  echo "== Signatur geprüft"
fi

mkdir -p dist
ZIEL="dist/Inventur-$VERSION.apk"
cp "$APK" "$ZIEL"
echo "== Fertig: $ZIEL ($(du -h "$ZIEL" | cut -f1))"
