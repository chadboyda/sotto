#!/bin/bash
# Build the native Sotto desktop app (SPEC §6.16, docs/NATIVE.md §5.5) from
# the SwiftPM package app-native/ into the plugin data dir. Incremental: does
# nothing when the sources hash matches the last build.
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
# app-native/Bundle/Sotto.entitlements (microphone only), as notarization requires.
#
# The bundle carries Contents/Resources/sotto-source.json ({"hash","version"}):
# the plugin only adopts a downloaded release whose hash equals its own app
# sources hash (daemon/appfetch.js, SPEC §6.16 "Release download").
#
# The sources hash (also computed by daemon/window.js, keep them in sync):
# sha256 over, for each file of app-native/** (minus any .build/ and .swiftpm/
# directory and .DS_Store) plus scripts/build-app.sh sorted by path (C
# locale): "<path relative to the plugin root>\n<sha256 hex>\n".
#
# SwiftPM's scratch directory lives in the output dir (OUT/.swiftpm-build),
# never in the plugin: an installed plugin stays clean (and may be read-only),
# and a build never looks like a source change to the self-update (SPEC §6.17).
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
    { find app-native \( -name .build -o -name .swiftpm \) -prune -o -type f ! -name .DS_Store -print; echo scripts/build-app.sh; } | sort | while IFS= read -r f; do
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
# /usr/bin/swift shim would instead pop up the install dialog, so check first.
xcode-select -p >/dev/null 2>&1 || fail "no Xcode or Command Line Tools (xcode-select --install)"
SWIFT="$(xcrun --find swift 2>/dev/null)" || fail "swift not found (xcrun --find swift)"
[[ -x "$SWIFT" ]] || fail "swift not found"
SWIFT_VERSION="$("$SWIFT" --version 2>/dev/null | grep -m1 -o 'Apple Swift version [^ ]*' || "$SWIFT" --version 2>/dev/null | head -n1)"
PKG="$ROOT/app-native"
BUNDLE_SRC="$PKG/Bundle"
[[ -f "$PKG/Package.swift" ]] || fail "no app-native/Package.swift"

say "building $APP_NAME ($SWIFT_VERSION)"
T0=$SECONDS
C="$STAGE/$APP_NAME/Contents"
mkdir -p "$C/MacOS" "$C/Resources" || fail "cannot create $STAGE"
SCRATCH="$OUT/.swiftpm-build"

if [[ $UNIVERSAL -eq 1 ]]; then ARCHS=(arm64 x86_64); else ARCHS=("$(uname -m)"); fi
ARCH_ARGS=()
for arch in "${ARCHS[@]}"; do ARCH_ARGS+=(--arch "$arch"); done
# -Xswiftc -gnone: no debug info in the shipped binary (smaller, no local paths).
SWIFT_ARGS=(build -c release --package-path "$PKG" --scratch-path "$SCRATCH" --product "$EXE_NAME" "${ARCH_ARGS[@]}" -Xswiftc -gnone)
if ! "$SWIFT" "${SWIFT_ARGS[@]}" > "$STAGE/swift-build.log" 2>&1; then
  tail -n 60 "$STAGE/swift-build.log" >&2
  fail "swift build failed for ${ARCHS[*]} (see the output above)"
fi
BIN_DIR="$("$SWIFT" "${SWIFT_ARGS[@]}" --show-bin-path 2>/dev/null)"
[[ -x "$BIN_DIR/$EXE_NAME" ]] || fail "swift build produced no $EXE_NAME in $BIN_DIR"
cp "$BIN_DIR/$EXE_NAME" "$C/MacOS/$EXE_NAME" || fail "copying the executable failed"
if [[ ${#ARCHS[@]} -gt 1 ]]; then
  got="$(xcrun lipo -archs "$C/MacOS/$EXE_NAME" 2>/dev/null)"
  for arch in "${ARCHS[@]}"; do [[ " $got " == *" $arch "* ]] || fail "the executable lacks $arch (has: $got)"; done
fi
cp "$BUNDLE_SRC/Info.plist" "$C/Info.plist" || fail "Info.plist missing"
printf 'APPL????' > "$C/PkgInfo"
if [[ -d "$BUNDLE_SRC/Resources" ]]; then
  cp -R "$BUNDLE_SRC/Resources/." "$C/Resources/" || fail "copying resources failed"
fi
APP_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$BUNDLE_SRC/Info.plist" 2>/dev/null)"
printf '{"hash":"%s","version":%s}\n' "$HASH" "$(json_str "$APP_VERSION")" > "$C/Resources/sotto-source.json" \
  || fail "cannot write sotto-source.json"

IDENTITY="${SOTTO_SIGN_IDENTITY:--}"
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - --identifier "$BUNDLE_ID" \
    --requirements "=designated => identifier \"$BUNDLE_ID\"" "$STAGE/$APP_NAME" > "$STAGE/codesign.log" 2>&1 \
    || { cat "$STAGE/codesign.log" >&2; fail "codesign (ad hoc) failed"; }
else
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --options runtime --timestamp \
    --entitlements "$BUNDLE_SRC/Sotto.entitlements" "$STAGE/$APP_NAME" > "$STAGE/codesign.log" 2>&1 \
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
