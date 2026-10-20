#!/usr/bin/env bash
set -euo pipefail
rhine_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$rhine_root"
rhine_variant="${1:-debug}"
case "$rhine_variant" in debug|rc) ;; *) printf '%s\n' 'Usage: build-apk.sh [debug|rc]' >&2; exit 2 ;; esac
rhine_task="${rhine_variant^}"
npm ci --prefix web --cache .npm-cache --no-audit --no-fund
npm run check --prefix web
./gradlew :app:testDebugUnitTest ":app:assemble${rhine_task}" ":app:lint${rhine_task}"
mkdir -p deliverables
rhine_version="$(node -p "require('./app/build/outputs/apk/${rhine_variant}/output-metadata.json').elements[0].versionName")"
rhine_label="${rhine_version}-debug"
if [[ "$rhine_variant" == rc ]]; then rhine_label="$rhine_version"; fi
rhine_apk="deliverables/RhineDroid-v${rhine_label}.apk"
cp "app/build/outputs/apk/${rhine_variant}/app-${rhine_variant}.apk" "$rhine_apk"
printf '%s\n' "APK: $rhine_root/$rhine_apk"
