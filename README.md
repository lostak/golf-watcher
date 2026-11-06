# Golf tee-time watcher

Every 5 minutes (5 AM–10 PM Denver), a GitHub Actions job reads public tee sheets in a headless browser (Denver Golf and Foothills on MemberSports, Saddle Rock on GolfNow) and posts to Slack when a new tee time opens inside a window in [`golf-watcher/wants.json`](golf-watcher/wants.json). It never signs in or books.

- **Add days to watch:** edit `golf-watcher/wants.json` and push to `main`. That wakes the watcher and runs a check right away.
- **Nothing left to watch:** the watcher pauses itself until `wants.json` changes.
- **Already-alerted times** are remembered in `golf-watcher/state/seen.json`, which the workflow commits.
- **Needs** the repo secret `SLACK_WEBHOOK_URL` (an incoming webhook to your own Slack DM).

This repo is public so Actions minutes are free. Part of [My Life](https://github.com/lostak/my-life) (private).

## Discord commands and daily report
Post in the Discord golf channel (`tick.yml` reads it every ~5 minutes):
`watch Sat 7-11 for 4` · `watch Sat and Sun morning for 2 at Murphy Creek, Meadow Hills` · `tee time Nov 14 7:30-10 for 3 at Wellshire` · `stop Sat` · `stop all` · `list`.
The bot replies in the channel and the watcher starts checking within a few minutes. With nothing being watched,
a daily report (7:15 AM) lists the earliest daylight tee time per course for today, tomorrow and the weekend.
Secrets for this: `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` (the golf channel), `DISCORD_WEBHOOK_URL`.

## One source of truth: Bradley's Google Calendar
When `GCAL_SA_KEY` + `GCAL_CALENDAR_ID` are set (a Google service account the calendar is shared with), the watcher reads the
days to watch and the courses from the silent calendar event **"Personal: golf watch"** (`COURSE:` / `WANT:` lines) – the same
event the My Life app (web, Android, desktop), the Pocket processor and Discord commands write – and writes `FOUND:` lines,
`LAST CHECKED:` and "Personal: tee time open – …" alert events back to it, so every surface shows the same thing.
`wants.json` then only holds the area settings; its `wants` list is the fallback when the calendar isn't configured.

## How it stays on schedule
`tick.yml` is a self-chaining heartbeat: each run reads Discord, starts the tee-time check when a day is wanted
(5 AM–10 PM) and the daily report on the first tick after 7:15 AM, waits out the rest of its 5 minutes, then starts the
next tick. GitHub's 5-minute cron is unreliable (often hours late), so cron only restarts the chain if it stops.
