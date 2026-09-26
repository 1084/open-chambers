#!/bin/sh
# Xcode Cloud: runs after clone, before build. Installs JS deps, builds www, syncs Capacitor.
# The iOS project uses Swift Package Manager (Capacitor 8 default); the plugin packages live in
# node_modules, so npm install must run before Xcode resolves packages.
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH/app"
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node >/dev/null 2>&1 || true
npm install --no-audit --no-fund
npm run prepare-www
npx cap sync ios
