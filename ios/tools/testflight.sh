#!/bin/sh
# Archives Freeband, signs it for the App Store from the shared cobanov-signing keychain and
# uploads it to TestFlight with an App Store Connect API key: no Apple ID, no password prompts.
#
#   sh tools/testflight.sh               # archive, export and upload
#   sh tools/testflight.sh --no-upload   # stop at the .ipa
#
# Signing: Apple Distribution 2632468C… in ~/Library/Keychains/cobanov-signing.keychain-db,
# unlocked with ~/.cobanov-signing/.kcpass (Obsidian: 03_Resources/apple-app-signing.md). The
# keychain is on the search list only while this runs, so a locked keychain never makes other
# tools ask for its password. Profile "Freeband App Store": swift tools/asc.swift profile <sha1>.
#
# The build number is the repository's commit count and App Store Connect takes each number
# once: commit before uploading again. The app record must exist (App Store Connect > Apps >
# + > New App, bundle id dev.cobanov.freeband); the API cannot create it.
set -e

IOS=$(cd "$(dirname "$0")/.." && pwd)
CERT=${ASC_SIGNING_CERT:-2632468CDF18C5FAFC4A6C2CC26EC610EAE84922}
PROFILE="Freeband App Store"
TEAM=6U58AKY6F8
KEYCHAIN=${SIGNING_KEYCHAIN:-$HOME/Library/Keychains/cobanov-signing.keychain-db}
KEYCHAIN_PASSWORD_FILE=${SIGNING_KEYCHAIN_PASSWORD_FILE:-$HOME/.cobanov-signing/.kcpass}
ASC_KEY_ID=${ASC_KEY_ID:-LS38TKZZ5U}
ASC_ISSUER_ID=${ASC_ISSUER_ID:-93179d25-e1b9-4256-941e-27126dcc7ea6}
BUILD=${BUILD_DIR:-$IOS/build}
BUILD_NUMBER=$(git -C "$IOS" rev-list --count HEAD)

security unlock-keychain -p "$(cat "$KEYCHAIN_PASSWORD_FILE")" "$KEYCHAIN"
ORIGINAL_LIST=$(security list-keychains -d user | tr -d '"' | grep -vF "$KEYCHAIN")
restore_list() { security list-keychains -d user -s $ORIGINAL_LIST; }
trap restore_list EXIT INT TERM
security list-keychains -d user -s $ORIGINAL_LIST "$KEYCHAIN"

cd "$IOS"
xcodegen generate --quiet
rm -rf "$BUILD/Freeband.xcarchive" "$BUILD/export"
mkdir -p "$BUILD"

xcodebuild archive -quiet \
  -project Freeband.xcodeproj -scheme Freeband -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$BUILD/Freeband.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$CERT" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE" DEVELOPMENT_TEAM="$TEAM" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" COMPILER_INDEX_STORE_ENABLE=NO

cat > "$BUILD/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$CERT</string>
  <key>provisioningProfiles</key>
  <dict><key>dev.cobanov.freeband</key><string>$PROFILE</string></dict>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
# Xcode packages the .ipa with rsync and fails ("Copy failed") on Homebrew's rsync 3.x, so the
# system tools go first on PATH for this step.
PATH=/usr/bin:/bin:/usr/sbin:/sbin:$PATH xcodebuild -exportArchive -quiet -archivePath "$BUILD/Freeband.xcarchive" \
  -exportPath "$BUILD/export" -exportOptionsPlist "$BUILD/ExportOptions.plist"
restore_list

IPA="$BUILD/export/Freeband.ipa"
INFO="$BUILD/Freeband.xcarchive/Products/Applications/Freeband.app/Info.plist"
echo "Freeband $(plutil -extract CFBundleShortVersionString raw "$INFO") ($(plutil -extract CFBundleVersion raw "$INFO")): $IPA"
codesign -dvv "$BUILD/Freeband.xcarchive/Products/Applications/Freeband.app" 2>&1 | grep -E '^Authority=Apple Distribution'

[ "$1" = "--no-upload" ] && exit 0
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
echo "Uploaded. It shows in TestFlight once App Store Connect has processed it (a few minutes)."
