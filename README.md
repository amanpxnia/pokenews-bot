# PokéNews Bot

A Discord bot that checks Pokémon news feeds every few minutes and posts new stories to a channel news-ticker style: `🚨 BREAKING: headline`, a short summary, the source and a picture. No links. Every post gets 5 reactions added automatically.

**Sources (edit `feeds.json` to change):**

| Source | Type |
|---|---|
| Official Pokémon YouTube channel | Official |
| PokéBeach (front-page news) | Fan news site |
| Google News: "Pokémon" and "Pokémon GO" | News |
| r/pokemon (News flair), r/PokemonTCG (top of the day) | Reddit |
| r/TheSilphRoad | Reddit (off by default) |
| PokéJungle, Pokémon GO Hub | Off: both block bots with Cloudflare |

## 1. Create the bot in Discord (~3 min)

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. "PokéNews").
2. Open the **Bot** tab → **Reset Token** → copy the token. Keep it secret.
3. Open **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: **View Channels**, **Send Messages**, **Embed Links**, **Add Reactions**, **Read Message History**
4. Open the generated URL, pick your server, and authorize.
5. In Discord: **User Settings → Advanced → Developer Mode** on. Then right-click your news channel → **Copy Channel ID**.

## 2. Run it on your Mac

You need Node.js 18 or newer. If you don't have it: `brew install node` (or download from <https://nodejs.org>).

```bash
cd pokenews-bot
npm install
cp .env.example .env
open -e .env          # paste your DISCORD_TOKEN and CHANNEL_ID, save
npm run check-feeds   # optional: confirms each feed works and previews headlines
npm start
```

On first start, the bot posts the single newest item from each feed and remembers the rest, so your channel doesn't get flooded. After that it only posts new items.

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `POLL_MINUTES` | 10 | How often to check feeds (min 2) |
| `FIRST_RUN_POSTS_PER_FEED` | 1 | Items posted per feed on the first ever run (0 = none) |
| `MAX_POSTS_PER_FEED` | 5 | Cap per feed per check; a feed can override with `"maxPerPoll"` |
| `CHASE_CHANNEL` | legendary-pulls | Channel for chase card posts; empty = off |
| `CHASE_TIMES` | 9,13,17,21 | Local hours (0–23) a grail post goes out |
| `GRAIL_MIN_PRICE` | 1500 | Lowest card value (USD) for grail posts |
| `REACTIONS` | ⚡,🔥,💧,🌿,✨ | Up to 5 emoji added to every post; empty = none |

## Adding or removing sources

Edit `feeds.json`. Changes apply on the next check, no restart needed. Each entry:

```json
{ "name": "Display name", "category": "Fan news", "url": "https://site.com/feed", "color": "#2A75BB", "enabled": true }
```

- Most WordPress news sites have a feed at `/feed`.
- Any subreddit: `https://www.reddit.com/r/NAME/new/.rss` (every post) or `/top/.rss?t=day` (only popular ones).
- Any YouTube channel: `https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`.
- Serebii and Pokemon.com don't publish RSS feeds, so they aren't included.

If a feed fails (site down, URL changed), the bot logs it and keeps going with the others.

## Keeping it running

The bot only runs while the terminal is open and your Mac is awake. To keep it going in the background:

```bash
npm install -g pm2
pm2 start src/index.js --name pokenews
pm2 logs pokenews      # view output
pm2 stop pokenews      # stop it
```

To move it to a server later, copy the folder over and run the same commands — nothing is Mac-specific.

## Deploying to Railway (runs 24/7)

The repo includes a `Dockerfile` (Node 20 + Python/Pillow for the grail graphics + Tesseract for reading slab labels), so Railway builds it as-is.

1. **Stop any copy running on your Mac** (`pm2 stop pokenews` or close it). Two copies would double-post.
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → pick this repo.
3. In the service's **Variables** tab, add everything from your `.env`: `DISCORD_TOKEN`, `CHANNEL_ID`, `POLL_MINUTES`, `FIRST_RUN_POSTS_PER_FEED`, `MAX_POSTS_PER_FEED`, `REACTIONS`, `CHASE_CHANNEL`, `CHASE_TIMES`, `GRAIL_MIN_PRICE`.
   Posting times use India time by default (`TZ=Asia/Kolkata`); add a `TZ` variable to change it.
4. **Add a volume** (right-click the service → *Attach volume*) mounted at **`/app/data`**. This keeps the "already posted" memory across redeploys; without it, every redeploy re-posts the newest item from each feed and may repeat a grail slot.
5. Deploy. The **Deploy Logs** should show `Logged in as …` and the posting schedule.

Every push to `main` redeploys automatically.

## Files

- `src/index.js` – connects to Discord, runs the check loop, posts embeds
- `src/feeds.js` – fetches and cleans up feed items (titles, summaries, images)
- `src/state.js` – remembers posted items in `data/seen.json` (delete it to start fresh)
- `src/check-feeds.js` – feed health check
- `Dockerfile` – container for Railway or any Linux host
- `src/chase.js` – grail posts (4 a day): graded cards worth $1,500+, mixed 50% Pokémon / 20% One Piece / 30% baseball & basketball (game and year read from the PSA slab label: `scripts/read_label.swift` on a Mac, `scripts/read_label.py` + Tesseract on Linux), with a "GRAIL PULLED" graphic drawn by `scripts/render_card.py` (needs Python 3 + Pillow; font/logo in `assets/`)
