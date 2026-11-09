# Tee Watch – Google Play kit

## Listing
- **App name:** Tee Watch
- **Short description (80):** Get notified the moment a tee time opens up on the days you want to play.
- **Full description:**
  Tee Watch watches public tee sheets for the days and times you want to play, and notifies you as soon as a tee time
  that fits opens up. Tap the alert to go straight to the course's booking page.

  • Pick a day, a time window and how many players
  • Optionally limit it to the courses you like
  • See every open time that fits, plus a daily report of the earliest time at each course
  • Works with your own golf-watcher repository on GitHub, which checks every 5 minutes for free

  Tee Watch never books, signs in or pays for anything – you book directly with the course.
- **Category:** Sports · **Contains ads:** No · **In-app purchases:** No
- **Privacy policy URL:** https://github.com/lostak/golf-watcher/blob/main/android/PRIVACY.md
- **Icon:** the launcher icon (`res/drawable/ic_flag.xml` on `#16583A`); export a 512×512 PNG for the listing.

## Data safety form
- Data collected: **none** (nothing goes to the developer). Data shared: **none**.
- The app sends the user's own GitHub token and watch list to GitHub at the user's request. Encrypted in transit: yes (HTTPS).
- Users can delete data: uninstall clears the phone; the watch list lives in the user's own repository.

## Permissions to explain
- `POST_NOTIFICATIONS` – tee-time alerts. `INTERNET` – GitHub.

## Upload
- Play Console → Create app → Production (or Internal testing first) → upload `TeeWatch.aab` from the signed build.
- Choose **Play App Signing** (Google holds the app key; ours is the upload key).
- New personal developer accounts must run a closed test with 12+ testers for 14 days before production.

## Before publishing to other people
- **Setup for new users:** today each user needs their own golf-watcher repo (fork + Actions on). A setup guide, or a
  shared backend, is needed before strangers can use it.
- **The watcher is Denver-tuned:** the MemberSports, Chronogolf and extra GolfNow course lists are Colorado. GolfNow's
  area search works anywhere.
- **Site terms:** GolfNow and other tee-sheet sites restrict automated access in their terms. Check these before a public release.
