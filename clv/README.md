# Closing-line value (CLV) tracker

Scores every pick against the closing line, for free, on GitHub Actions. No Claude usage after a pick is recorded.

1. A pick routine (Duet picks, the Life picks) sends its picks to **`clv-record`**. The pick is stored in `clv/data/picks/`, matched to its game, and the market price at post time is saved.
2. **`clv-watch`** takes the closing price about 8 minutes before the start, scores CLV, and grades game lines from ESPN final scores.
3. [`REPORT.md`](REPORT.md) shows beat-the-close rate, average CLV, record and units per source (all time and last 7 days), plus the last 60 picks. A summary DM goes out on Monday mornings.

## Odds sources

| Source | Cost | What it gives |
|---|---|---|
| [The Odds API](https://the-odds-api.com) (repo secret `ODDS_API_KEY`) | Free tier: 500 credits a month. A close costs 1 credit per market per league per start time (up to 10 books count as one). Game lists are free. | DraftKings, FanDuel, BetMGM, BetRivers, Pinnacle and others, plus player props. Pinnacle gives the no-vig "fair" close. |
| ESPN public scoreboard | Free, no key | DraftKings open and close for moneyline, spread and total, and final scores. Used for grading, when there's no key, when The Odds API fails, and to fill in a close that was missed. |

A few picks a day use roughly 150 to 300 credits a month. Below 150 credits left, post-time snapshots switch to ESPN so closes keep priority. Below 40, Bradley gets one DM.

bet365 has no US feed on The Odds API, so bet365 picks are scored against DraftKings' close (then FanDuel).

## What "CLV" means here

- **Beat the close:** your price beat the closing price at your book (or DraftKings), or you got a better number (Broncos +3.5 when it closed +2.5).
- **CLV %:** the expected value of your price against the no-vig closing line. That's Pinnacle when it closed at the same number, otherwise the reference book with its vig removed. When the number moved, a rough value per point is applied and the result is marked as an estimate (`~`).

## Sending picks

One call per batch. `picks` is a JSON array. `source` names whose picks they are (`duet`, `life`, …).

```
gh workflow run clv-record.yml -R lostak/golf-watcher --ref main -f source=duet -f picks='[
 {"league":"nfl","game":"Broncos @ Chiefs","market":"spread","side":"Broncos","line":3.5,"price":-110,"book":"DraftKings","units":1},
 {"league":"nfl","game":"Broncos @ Chiefs","market":"total","side":"over","line":44.5,"price":-105,"book":"FanDuel","units":0.5},
 {"league":"nhl","game":"Canadiens @ Rangers","market":"moneyline","side":"Rangers","price":-140,"book":"bet365","units":1},
 {"league":"nfl","game":"Broncos @ Chiefs","market":"prop","player":"Patrick Mahomes","stat":"passing yards","side":"over","line":249.5,"price":-115,"book":"FanDuel","units":0.5}
]'
```

- `league`: nfl, ncaaf, nhl, nba, ncaab or mlb. If it's left out, every league is searched.
- `market`: moneyline, spread, total or prop. For a prop, add `player` and `stat` (or an Odds API `prop_market` key such as `player_pass_yds`).
- `side`: team name for moneyline and spread, `over`/`under` for totals and props, `yes` for anytime-scorer props.
- `price`: American odds. `units` defaults to 1. `date`, `confidence` and `why` are optional.
- Sending the same pick twice records it once.
- Props get CLV, but their results aren't graded automatically. To settle one by hand: `-f picks='[{"id":"<pick id from REPORT or the run log>","result":"win"}]'`.

## Self-checks (DMs go through `notify.yml`, channel=dm)

- **Errors are retried:** each API call is retried 3 times with backoff. If The Odds API fails, ESPN is used. After the start, ESPN's closing DraftKings line fills in a close that was missed.
- **Problems that last get a DM:** you hear when a pick couldn't be recorded or matched to a game, when a close was missed for good, when The Odds API fails 3 times in a row, when credits run low, when a final score can't be found 30 hours after a game, or when the watcher run fails twice in a row. Each problem DMs once.
- **The chain restarts itself:** the watcher hands over to a fresh run before GitHub's 6-hour limit, and an hourly cron (5 AM to 10 PM Denver) restarts it if the chain ever stops.
- **Health file:** `clv/data/health.json` shows `last_cycle`, credits left and recent log lines.

## Tests

`node clv/test/run.js` runs offline against canned Odds API and ESPN answers.
