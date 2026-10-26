# Video clips for flash cards (YouGlish-style, free sources)

When a card is flipped, `Language/English.html` plays short clips where the word is spoken, taken from:

- **Wikimedia Commons**: subtitle pages are full-text searchable, so each word is searched directly.
- **Internet Archive**: videos that come with `.srt`/`.vtt` caption files.
- **PeerTube**: open-source video sites, found through SepiaSearch, with each video's captions.

If a word has no clips, the page falls back to YouGlish as before, which saves your YouGlish quota.

## How it runs

`.github/workflows/clips.yml` runs `build.mjs` every Monday, whenever `lib.txt` changes, and on demand (Actions → *Build video clips index* → *Run workflow*). It:

1. downloads new subtitles into `tools/clips/.cache/` (kept between runs, not published),
2. matches every English word in `lib.txt` against them, including forms like *plead → pleaded*, *dip into → dipping into* and *take sth for granted*,
3. commits `clips/videos.json` and `clips/index/<letter>.json`, then redeploys the site.

Videos are never copied. The page only stores the text and timestamps and plays each video from its original host.

## Run locally (optional)

```
node tools/clips/build.mjs              # harvest + build (Node 18+)
node tools/clips/build.mjs --offline    # rebuild the index from the cache only
```

## Tuning (`config.json`)

- `peertube.searches`, `archive.queries`: topics to collect videos about.
- `maxItemsPerRun` / `maxVideosPerRun`: how much to fetch per run. Each run adds more.
- `maxClipsPerWord`, `maxClipsPerVideo`: index size and variety.
