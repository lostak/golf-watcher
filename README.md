# Golf tee-time watcher

Every 5 minutes (5 AM–10 PM Denver), a GitHub Actions job reads public tee sheets in a headless browser (Denver Golf and Foothills on MemberSports, Saddle Rock on GolfNow) and posts to Slack when a new tee time opens inside a window in [`golf-watcher/wants.json`](golf-watcher/wants.json). It never signs in or books.

- **Add days to watch:** edit `golf-watcher/wants.json` and push to `main`. That wakes the watcher and runs a check right away.
- **Nothing left to watch:** the watcher pauses itself until `wants.json` changes.
- **Already-alerted times** are remembered in `golf-watcher/state/seen.json`, which the workflow commits.
- **Needs** the repo secret `SLACK_WEBHOOK_URL` (an incoming webhook to your own Slack DM).

This repo is public so Actions minutes are free. Part of [My Life](https://github.com/lostak/my-life) (private).
