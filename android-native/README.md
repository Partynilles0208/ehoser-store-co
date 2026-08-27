# ehoser Native (Android, no WebView)

Dies ist eine echte Android-App mit Jetpack Compose (kein WebView), visuell nah an ehoser.de.

## Features

- Native UI mit Kategorien: Cyber, Schule, Design, Tech, Utility
- Login gegen dein bestehendes Backend (`/api/login`) mit demselben Account wie im Web
- Session wird lokal gespeichert
- Beim nächsten Start:
  - online: Token wird via `/api/verify-token` geprüft
  - offline: Zugriff auf lokale/offline-fähige Tools bleibt aktiv (wenn vorher eingeloggt)
- Keine Online-Features im Offline-Modus, nur lokal berechenbare Tools
- Keine Online-User-Liste und kein Support-Button in der Native-App-UI

## Projektstruktur

- `android-native/app/src/main/java/co/ehoser/nativeapp/MainActivity.kt`
- `android-native/app/src/main/java/co/ehoser/nativeapp/ui/AppViewModel.kt`
- `android-native/app/src/main/java/co/ehoser/nativeapp/data/ApiClient.kt`
- `android-native/app/src/main/java/co/ehoser/nativeapp/data/SessionStore.kt`
- `android-native/app/src/main/java/co/ehoser/nativeapp/data/OfflineToolEngine.kt`

## Start in Android Studio

1. Android Studio öffnen
2. Ordner `android-native` als Projekt öffnen
3. Gradle Sync abwarten
4. Auf Emulator oder Gerät starten

## Backend URL anpassen

Aktuell ist in `ApiClient.kt` die Base URL auf `https://ehoser.de` gesetzt.
Wenn du lokal testen willst, dort die URL ändern.

## Hinweis

Diese App ist absichtlich "offline-first" für lokale Tools.
Online-abhängige Bereiche (z.B. Chat, Maps, News, YouTube) sind hier bewusst nicht offline gespiegelt.
