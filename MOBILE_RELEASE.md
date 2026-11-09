# Courtly Mobile

Courtly uses Capacitor 8 to package the existing Vite application for Android and iOS while keeping the production backend at https://www.courtlyph.com.

## Application identity
- App name: Courtly
- Bundle / application ID: `ph.courtly.app`
- Web bundle: `dist`
- Production backend: `https://www.courtlyph.com`

## Local commands
```bash
npm install
npm run mobile:android
npm run mobile:ios
```

The native projects are generated from `capacitor.config.json`.

## Android
GitHub Actions builds an unsigned/debug APK automatically. A Play Store release requires a release signing key and Play Console account. New Play submissions must target the current Google Play API requirement.

## iOS
GitHub Actions compiles the project for the iOS Simulator without signing. TestFlight/App Store distribution requires an Apple Developer Program membership, an App Store Connect app record, signing certificates/profiles, and final store metadata.

## Native API routing
The bundled web app runs from a local Capacitor origin. `public/mobile-runtime.js` rewrites relative `/api/*` calls to the production Courtly backend so account deletion, receipts, notifications, and other server endpoints continue to work in native builds.

## Release checklist
1. Replace/generated native icons and splash screens with final Courtly artwork.
2. Add camera/photo-library usage descriptions if native plugins are introduced.
3. Configure universal/app links for court and activity URLs.
4. Configure push notifications and device tokens.
5. Test player registration/login, account deletion, booking checkout, receipt upload, messages, community report/block, owner QR links, and deep links on real devices.
6. Create signed Android App Bundle (AAB) for Play Console.
7. Archive signed iOS app and upload through TestFlight.
