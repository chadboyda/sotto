#!/bin/bash
# Build the Sotto desktop app (SPEC §6.16) from app/ into the plugin data
# dir. Incremental: does nothing when the sources hash matches the last build.
#
#   scripts/build-app.sh [--out DIR] [--force] [--check] [--quiet] [--universal]
#
#   --out DIR  output dir (default ${CLAUDE_PLUGIN_DATA:-$HOME/.sotto}/app);
#              the bundle is DIR/Sotto.app, the stamp DIR/build.json
#   --force    rebuild even if up to date
#   --check    exit 0 if the bundle is up to date, 1 if not; build nothing
#   --quiet    print only errors
#   --print-hash  print the sources hash and exit
#   --universal   build arm64 + x86_64 (lipo) instead of the host architecture
#                 (scripts/release-app.sh uses it)
#
# Signing: ad hoc by default, with an explicit designated requirement on the
# bundle id, so a rebuild keeps the same requirement for the microphone (TCC)
# grant. SOTTO_SIGN_IDENTITY="Developer ID Application: ..." signs with a real
# identity instead, with the hardened runtime, a secure timestamp and
# app/Sotto.entitlements (microphone only), as notarization requires.
#
# The bundle carries Contents/Resources/sotto-source.json ({"hash","version"}):
# the plugin only adopts a downloaded release whose hash equals its own app
# sources hash (daemon/appfetch.js, SPEC §6.16 "Release download").
#
# The sources hash (also computed by daemon/window.js, keep them in sync):
# sha256 over, for each file of app/** plus scripts/build-app.sh sorted by
# path (C locale): "<path relative to the plugin root>\n<sha256 hex>\n".
set -uo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${CLAUDE_PLUGIN_DATA:-$HOME/.sotto}/app"
FORCE=0
CHECK=0
QUIET=0
PRINT_HASH=0
UNIVERSAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --check) CHECK=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --print-hash) PRINT_HASH=1; shift ;;
    --universal) UNIVERSAL=1; shift ;;
    *) echo "build-app.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

APP_NAME="Sotto.app"
EXE_NAME="Sotto"
BUNDLE_ID="com.chadboyda.sotto"
BUNDLE="$OUT/$APP_NAME"
STAMP="$OUT/build.json"
LOCK="$OUT/build.lock"

say() { [[ $QUIET -eq 1 ]] || printf 'build-app: %s\n' "$*"; }

source_hash() {
  (
    cd "$ROOT" || exit 1
    { find app -type f ! -name .DS_Store; echo scripts/build-app.sh; } | sort | while IFS= read -r f; do
      printf '%s\n%s\n' "$f" "$(shasum -a 256 < "$f" | cut -d' ' -f1)"
    done | shasum -a 256 | cut -d' ' -f1
  )
}

HASH="$(source_hash)"
[[ ${#HASH} -eq 64 ]] || { echo "build-app.sh: could not hash app sources" >&2; exit 1; }
if [[ $PRINT_HASH -eq 1 ]]; then echo "$HASH"; exit 0; fi

up_to_date() {
  [[ -x "$BUNDLE/Contents/MacOS/$EXE_NAME" && -f "$STAMP" ]] || return 1
  grep -q "\"hash\":\"$HASH\"" "$STAMP" && grep -q '"ok":true' "$STAMP"
}

if [[ $CHECK -eq 1 ]]; then up_to_date; exit $?; fi
if [[ $FORCE -eq 0 ]] && up_to_date; then say "up to date ($BUNDLE)"; exit 0; fi

mkdir -p "$OUT" || exit 1
chmod 700 "$OUT" 2>/dev/null

# One build at a time per output dir (the daemon may start one in the background).
if [[ -f "$LOCK" ]]; then
  other="$(cat "$LOCK" 2>/dev/null)"
  if [[ "$other" =~ ^[0-9]+$ ]] && kill -0 "$other" 2>/dev/null; then
    echo "build-app.sh: another build is running (pid $other)" >&2
    exit 3
  fi
fi
echo $$ > "$LOCK"
STAGE="$OUT/.stage.$$"
cleanup() { rm -rf "$STAGE"; rm -f "$LOCK"; }
trap cleanup EXIT

json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\t'/ }; printf '"%s"' "$s"; }
fail() {
  printf '{"hash":"%s","ok":false,"error":%s,"at":"%s"}\n' "$HASH" "$(json_str "$1")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAMP"
  echo "build-app.sh: $1" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail "the desktop app needs macOS"
# `xcode-select -p` fails quietly when no developer tools are installed; the
# /usr/bin/swiftc shim would instead pop up the install dialog, so check first.
xcode-select -p >/dev/null 2>&1 || fail "no Xcode or Command Line Tools (xcode-select --install)"
SWIFTC="$(xcrun --find swiftc 2>/dev/null)" || fail "swiftc not found (xcrun --find swiftc)"
[[ -x "$SWIFTC" ]] || fail "swiftc not found"
SWIFT_VERSION="$("$SWIFTC" --version 2>/dev/null | head -n1)"

say "building $APP_NAME ($SWIFT_VERSION)"
T0=$SECONDS
C="$STAGE/$APP_NAME/Contents"
mkdir -p "$C/MacOS" "$C/Resources" || fail "cannot create $STAGE"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"
SOURCES=()
while IFS= read -r f; do SOURCES+=("$f"); done < <(find "$ROOT/app/Sources" -name '*.swift' | sort)
[[ ${#SOURCES[@]} -gt 0 ]] || fail "no Swift sources in app/Sources"

if [[ $UNIVERSAL -eq 1 ]]; then ARCHS=(arm64 x86_64); else ARCHS=("$(uname -m)"); fi
SLICES=()
for arch in "${ARCHS[@]}"; do
  out="$C/MacOS/$EXE_NAME"
  [[ ${#ARCHS[@]} -gt 1 ]] && out="$STAGE/$EXE_NAME.$arch"
  if ! "$SWIFTC" -O -swift-version 5 ${SDK:+-sdk "$SDK"} -target "$arch-apple-macos13.0" \
      -module-name Sotto -framework AppKit -framework WebKit -framework Carbon -framework CoreAudio -framework AudioToolbox -framework AVFoundation \
      -o "$out" "${SOURCES[@]}" > "$STAGE/swiftc.log" 2>&1; then
    cat "$STAGE/swiftc.log" >&2
    fail "swiftc failed for $arch (see the output above)"
  fi
  SLICES+=("$out")
done
if [[ ${#ARCHS[@]} -gt 1 ]]; then
  xcrun lipo -create -output "$C/MacOS/$EXE_NAME" "${SLICES[@]}" > "$STAGE/lipo.log" 2>&1 \
    || { cat "$STAGE/lipo.log" >&2; fail "lipo failed"; }
fi
cp "$ROOT/app/Info.plist" "$C/Info.plist" || fail "Info.plist missing"
printf 'APPL????' > "$C/PkgInfo"
cp -R "$ROOT/app/Resources/." "$C/Resources/" || fail "copying resources failed"
APP_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$ROOT/app/Info.plist" 2>/dev/null)"
printf '{"hash":"%s","version":%s}\n' "$HASH" "$(json_str "$APP_VERSION")" > "$C/Resources/sotto-source.json" \
  || fail "cannot write sotto-source.json"

IDENTITY="${SOTTO_SIGN_IDENTITY:--}"
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - --identifier "$BUNDLE_ID" \
    --requirements "=designated => identifier \"$BUNDLE_ID\"" "$STAGE/$APP_NAME" > "$STAGE/codesign.log" 2>&1 \
    || { cat "$STAGE/codesign.log" >&2; fail "codesign (ad hoc) failed"; }
else
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --options runtime --timestamp \
    --entitlements "$ROOT/app/Sotto.entitlements" "$STAGE/$APP_NAME" > "$STAGE/codesign.log" 2>&1 \
    || { cat "$STAGE/codesign.log" >&2; fail "codesign with $IDENTITY failed"; }
fi

# Swap in the new bundle. A running app keeps its already-mapped binary.
rm -rf "$BUNDLE.old"
[[ -d "$BUNDLE" ]] && mv "$BUNDLE" "$BUNDLE.old"
mv "$STAGE/$APP_NAME" "$BUNDLE" || fail "cannot install $BUNDLE"
rm -rf "$BUNDLE.old"

printf '{"hash":"%s","ok":true,"at":"%s","seconds":%d,"swiftc":%s,"identity":%s,"archs":%s,"source":"build"}\n' \
  "$HASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((SECONDS - T0))" "$(json_str "$SWIFT_VERSION")" "$(json_str "$IDENTITY")" "$(json_str "${ARCHS[*]}")" > "$STAMP"
say "built $BUNDLE in $((SECONDS - T0)) s"
exit 0
