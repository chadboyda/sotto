#!/bin/bash
# Build, sign, notarize and package the Sotto desktop app for a GitHub release
# (SPEC §6.16 "Release download"). Maintainer tool; the plugin never runs it.
#
#   scripts/release-app.sh <version> [--upload] [--identity NAME] [--profile NAME] [--allow-dirty]
#
#   <version>      must equal the version in package.json, .claude-plugin/plugin.json
#                  and app/Info.plist (CFBundleShortVersionString)
#   --upload       after everything verifies, `gh release create v<version>` with
#                  dist/Sotto.zip and dist/Sotto.zip.sha256 (the tag must exist on
#                  GitHub: push it first). Without it nothing leaves this machine
#                  except the notarization upload to Apple.
#   --identity     codesign identity (default: the Developer ID Application
#                  identity of team 6M6D2W72ZB in the keychain)
#   --profile      notarytool keychain profile (default: sotto), created once with
#                  `xcrun notarytool store-credentials sotto --apple-id ... --team-id ...`
#   --allow-dirty  build even when app/ or scripts/build-app.sh have uncommitted
#                  changes (the release would not match any commit's sources hash)
#
# Steps: universal (arm64 + x86_64) release build through build-app.sh, signed
# with the hardened runtime, a secure timestamp and app/Sotto.entitlements;
# notarytool submit --wait; stapler staple; codesign/spctl/stapler checks;
# ditto zip + sha256. Output in dist/ (git-ignored): Sotto.zip,
# Sotto.zip.sha256, release.json and the stapled dist/build/Sotto.app.
set -uo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM="6M6D2W72ZB"
BUNDLE_ID="com.chadboyda.sotto"
REPO="chadboyda/sotto"
PROFILE="sotto"
IDENTITY=""
UPLOAD=0
ALLOW_DIRTY=0
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upload) UPLOAD=1; shift ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -*) echo "release-app.sh: unknown option $1" >&2; exit 2 ;;
    *) [[ -z "$VERSION" ]] || { echo "release-app.sh: one version only" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

say() { printf 'release: %s\n' "$*"; }
die() { printf 'release-app.sh: %s\n' "$*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "usage: scripts/release-app.sh <version> [--upload] (e.g. 0.2.0)"
[[ "$(uname -s)" == Darwin ]] || die "needs macOS"
json_version() { /usr/bin/plutil -extract version raw -o - "$1" 2>/dev/null; }
[[ "$(json_version "$ROOT/package.json")" == "$VERSION" ]] || die "package.json version is $(json_version "$ROOT/package.json"), not $VERSION"
[[ "$(json_version "$ROOT/.claude-plugin/plugin.json")" == "$VERSION" ]] || die ".claude-plugin/plugin.json version is not $VERSION"
PLIST_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$ROOT/app/Info.plist" 2>/dev/null)"
[[ "$PLIST_VERSION" == "$VERSION" ]] || die "app/Info.plist CFBundleShortVersionString is $PLIST_VERSION, not $VERSION"

if [[ $ALLOW_DIRTY -eq 0 ]] && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  dirty="$(git -C "$ROOT" status --porcelain -- app scripts/build-app.sh .claude-plugin/plugin.json)"
  [[ -z "$dirty" ]] || die "uncommitted changes in the app sources (commit them, or --allow-dirty):
$dirty"
fi

if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -nE "s/.*\"(Developer ID Application: .*\\($TEAM\\))\".*/\\1/p" | head -n1)"
  [[ -n "$IDENTITY" ]] || die "no \"Developer ID Application: ... ($TEAM)\" identity in the keychain"
fi
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || die "notarytool keychain profile \"$PROFILE\" is missing or invalid (xcrun notarytool store-credentials $PROFILE ...)"

DIST="$ROOT/dist"
BUILD="$DIST/build"
APP="$BUILD/Sotto.app"
ZIP="$DIST/Sotto.zip"
mkdir -p "$DIST" || die "cannot create $DIST"
rm -rf "$BUILD" "$ZIP" "$ZIP.sha256" "$DIST/release.json" "$DIST/notarize.zip"

say "building $VERSION (universal) signed by $IDENTITY"
SOTTO_SIGN_IDENTITY="$IDENTITY" /bin/bash "$ROOT/scripts/build-app.sh" --out "$BUILD" --force --universal \
  || die "build failed"
HASH="$(/usr/bin/plutil -extract hash raw -o - "$APP/Contents/Resources/sotto-source.json")"
[[ "$HASH" == "$(/bin/bash "$ROOT/scripts/build-app.sh" --print-hash)" ]] || die "sotto-source.json hash does not match the sources"

# --- checks before sending anything to Apple -------------------------------
ARCHS="$(xcrun lipo -archs "$APP/Contents/MacOS/Sotto")"
[[ " $ARCHS " == *" arm64 "* && " $ARCHS " == *" x86_64 "* ]] || die "not universal: $ARCHS"
codesign --verify --deep --strict --verbose=2 "$APP" || die "codesign --verify failed"
SIGINFO="$(codesign -dvv "$APP" 2>&1)"
grep -q "TeamIdentifier=$TEAM" <<<"$SIGINFO" || die "not signed by team $TEAM"
grep -q "Identifier=$BUNDLE_ID" <<<"$SIGINFO" || die "wrong identifier"
grep -Eq 'flags=.*runtime' <<<"$SIGINFO" || die "hardened runtime missing"
grep -q "Timestamp=" <<<"$SIGINFO" || die "secure timestamp missing"
ENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
KEYS="$(printf '%s' "$ENTS" | /usr/bin/plutil -convert json -o - - 2>/dev/null)"
[[ "$KEYS" == '{"com.apple.security.device.audio-input":true}' ]] || die "unexpected entitlements: $KEYS"

# --- notarize -----------------------------------------------------------------
ditto -c -k --keepParent "$APP" "$DIST/notarize.zip" || die "zip for notarization failed"
say "submitting to Apple notary service (profile $PROFILE); this usually takes 1 to 5 minutes"
NOTARY_JSON="$(xcrun notarytool submit "$DIST/notarize.zip" --keychain-profile "$PROFILE" --wait --output-format json 2>"$DIST/notarytool.err")"
rm -f "$DIST/notarize.zip"
SUB_ID="$(printf '%s' "$NOTARY_JSON" | /usr/bin/plutil -extract id raw -o - - 2>/dev/null)"
STATUS="$(printf '%s' "$NOTARY_JSON" | /usr/bin/plutil -extract status raw -o - - 2>/dev/null)"
say "notarization id $SUB_ID: $STATUS"
if [[ "$STATUS" != "Accepted" ]]; then
  cat "$DIST/notarytool.err" >&2
  [[ -n "$SUB_ID" ]] && xcrun notarytool log "$SUB_ID" --keychain-profile "$PROFILE" >&2
  die "notarization failed (status ${STATUS:-unknown})"
fi
rm -f "$DIST/notarytool.err"

xcrun stapler staple "$APP" || die "stapler staple failed"
xcrun stapler validate "$APP" || die "stapler validate failed"
codesign --verify --deep --strict --verbose=2 "$APP" || die "codesign --verify failed after stapling"
SPCTL="$(spctl -a -vv -t exec "$APP" 2>&1)" || die "spctl rejected the app: $SPCTL"
printf '%s\n' "$SPCTL"
grep -q "source=Notarized Developer ID" <<<"$SPCTL" || die "spctl does not see a notarized Developer ID app"

# --- package ------------------------------------------------------------------
ditto -c -k --keepParent "$APP" "$ZIP" || die "zip failed"
( cd "$DIST" && shasum -a 256 Sotto.zip > Sotto.zip.sha256 ) || die "sha256 failed"
SHA="$(cut -d' ' -f1 "$ZIP.sha256")"
printf '{"version":"%s","hash":"%s","sha256":"%s","notarization_id":"%s","archs":"%s","identity":"%s","commit":"%s","at":"%s"}\n' \
  "$VERSION" "$HASH" "$SHA" "$SUB_ID" "$ARCHS" "$IDENTITY" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIST/release.json"
say "dist/Sotto.zip $(wc -c < "$ZIP" | tr -d ' ') bytes, sha256 $SHA"

if [[ $UPLOAD -eq 1 ]]; then
  command -v gh >/dev/null 2>&1 || die "gh not found"
  say "uploading to https://github.com/$REPO/releases/tag/v$VERSION"
  gh release create "v$VERSION" "$ZIP" "$ZIP.sha256" --repo "$REPO" --verify-tag \
    --title "Sotto $VERSION" --notes "Signed and notarized Sotto desktop app for macOS 13+ (universal). The plugin downloads and verifies it on first /talk; see the README." \
    || die "gh release create failed"
else
  say "not uploaded (pass --upload once the tag v$VERSION is on GitHub)"
fi
exit 0
