# PokéNews Bot

A Discord bot for the Card Outpost server. It posts:

- **News:** 8 stories a day (1 every 3 hours) to the news channel, as `🚨 BREAKING` cards with no links. A strict filter only allows stories about **Pokémon, One Piece, baseball or basketball cards / TCG**. Video game, anime, other sports and general news are skipped. Each slot picks the newest qualifying story across all sources, and the same story from two sources is only posted once.
- **Grail reveals:** 8 a day (1 every 3 hours, between the news slots), with a "GRAIL PULLED" graphic. No @everyone ping.
- **Memes:** at most 1 per news slot, to #memes.

**Sources (edit `feeds.json` to change):**

| Source | Type |
|---|---|
| Official Pokémon YouTube channel | Official |
| Google News: "One Piece Card Game" and baseball/basketball cards | News |
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


## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `NEWS_TIMES` | 1,4,7,10,13,16,19,22 | Local hours (0–23) to post 1 news story |
| `CHASE_CHANNEL` | legendary-pulls | Channel for grail reveals; empty = off |
| `GRAIL_TIMES` | 0,3,6,9,12,15,18,21 | Local hours (0–23) to post 1 grail reveal |
| `GRAIL_MIN_PRICE` | 1500 | Lowest card value (USD) for grail reveals |

The news filter lives in `src/relevance.js`. A feed in `feeds.json` can say what it's always about with `"impliedTopic": "pokemon"`, and `"impliedCards": true` if every post is about cards (e.g. r/PokemonTCG).

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
3. In the service's **Variables** tab, add everything from your `.env`: `DISCORD_TOKEN`, `CHANNEL_ID`, `NEWS_TIMES`, `CHASE_CHANNEL`, `GRAIL_TIMES`, `GRAIL_MIN_PRICE`.
   Posting times use India time by default (`TZ=Asia/Kolkata`). Add a `TZ` variable to change it.
4. **Add a volume** (right-click the service → *Attach volume*) mounted at **`/app/data`**. This keeps the "already posted" memory across redeploys; without it, every redeploy re-posts the newest item from each feed and may repeat a grail slot.
5. Deploy. The **Deploy Logs** should show `Logged in as …` and the posting schedule.

Every push to `main` redeploys automatically.

## Files

- `src/index.js` – connects to Discord, runs the news / grail / meme schedule
- `src/relevance.js` – the strict news topic filter
- `src/schedule.js` – daily posting slots
- `src/feeds.js` – fetches and cleans up feed items (titles, summaries, images)
- `src/state.js` – remembers posted items in `data/seen.json` (delete it to start fresh)
- `src/check-feeds.js` – feed health check
- `Dockerfile` – container for Railway or any Linux host
- `src/chase.js` – grail reveals (8 a day): graded cards worth $1,500+, mixed 50% Pokémon / 20% One Piece / 30% baseball & basketball (game and year read from the PSA slab label: `scripts/read_label.swift` on a Mac, `scripts/read_label.py` + Tesseract on Linux), with a "GRAIL PULLED" graphic drawn by `scripts/render_card.py` (needs Python 3 + Pillow; font/logo in `assets/`)
