# Tee Watch (Android)

A phone front end for this repo's golf watcher. The watcher (GitHub Actions in this repo) checks public tee sheets
every 5 minutes. The app:

- **Reads** `golf-watcher/state/app.json` (open tee times that fit a watched day, the days watched, the daily report)
  and `golf-watcher/wants.json`. No sign-in needed for this.
- **Writes** `golf-watcher/wants.json` when you add or remove a day or change the search area, then starts a check
  (`golf-watch.yml`). This needs a fine-grained GitHub token with access to this one repo: Contents and Actions, read and write.
- **Notifies** you when a new tee time that fits opens up. It reads `app.json` every 15 minutes in the background.
  Tapping a notification or a tee time opens the course's own booking page.

It never books, signs in to golf sites, or pays for anything. Days added from the app are stored in `wants.json` and
show as "from the app"; days from the owner's calendar ("Personal: golf watch") show as "from your calendar" and are
read-only here.

**Point it at another repo:** Settings → Watcher repo (`owner/name`). Any fork of golf-watcher with Actions turned on works.

**Builds:**
- `.github/workflows/android.yml` here compile-checks every change and keeps a debug APK as a run artifact.
- Signed builds are made in a private repo that holds the upload key: `TeeWatch.apk` for phones, `TeeWatch.aab` for Google Play.
  The key is never committed here; `app/build.gradle.kts` reads it from `TEEWATCH_KEYSTORE*` variables.

Publishing notes: see [STORE.md](STORE.md) and [PRIVACY.md](PRIVACY.md).
