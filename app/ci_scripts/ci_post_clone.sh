#!/bin/sh
# Xcode Cloud: runs after clone, before build. Installs JS deps, builds www, syncs Capacitor, installs Pods.
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH/app"  # ci_scripts lives in ios/App but works from the app root
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node cocoapods >/dev/null 2>&1 || true
npm install --no-audit --no-fund
npm run prepare-www
npx cap sync ios
cd ios/App && pod install --repo-update
