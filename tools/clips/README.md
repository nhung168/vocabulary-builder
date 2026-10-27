# Video clips for flash cards (YouGlish-style, free sources)

When a card is flipped, `Language/English.html`, `Chinese.html` and `Espanol.html` play short clips where the word is spoken, taken from:

- **Wikimedia Commons**: subtitle pages are full-text searchable, so each word is searched directly.
  For Chinese, only videos with Chinese file names are kept: most Chinese subtitles on Commons translate English speech.
- **Internet Archive**: videos that come with `.srt`/`.vtt` caption files.
  For Chinese this includes the archived **Bilibili** copies (`bilibili_videos`, Chinese audio with machine-made Chinese subtitles), searched by topic (cooking, shopping, daily life…).
- **PeerTube**: open-source video sites, found through SepiaSearch, with each video's captions.

If a word has no clips, the page falls back to YouGlish as before, which saves your YouGlish quota.

## How it runs

`.github/workflows/clips.yml` runs `build.mjs` every Monday, whenever `lib.txt` changes, and on demand (Actions → *Build video clips index* → *Run workflow*). For every language in `config.json` that has words in `lib.txt`, it:

1. downloads new subtitles into `tools/clips/.cache/` (kept between runs, not published),
2. matches every word against them:
   - English, including forms like *plead → pleaded*, *dip into → dipping into* and *take sth for granted*,
   - Chinese, by characters (spaces in the entry are ignored), in Simplified or Traditional subtitles (OpenCC character table),
   - Spanish, the word and its plural (*canción → canciones*),
3. runs `light.mjs`, which records a low-resolution copy of each video (Commons 240p transcodes, Archive `.ia.mp4`) so clips start faster. The player uses it unless *HD* is switched on,
4. commits `clips/` (English) and `clips/zh/`, `clips/es/` (`videos.json` + `index/<letter>.json`), then redeploys the site.

The run time (`--minutes`) is shared equally between the languages. A language with no words in `lib.txt` is skipped.

Videos are never copied. The page only stores the text and timestamps and plays each video from its original host.

## Run locally (optional)

```
node tools/clips/build.mjs --lang zh    # harvest + build one language (Node 18+)
node tools/clips/build.mjs --offline    # rebuild the indexes from the cache only
node tools/clips/light.mjs              # then add the low-resolution copies
```

Without `--lang`, every language's index is rebuilt from what is in the local cache. The full cache only exists in CI, so locally use `--lang` for the language you are working on, or the other indexes shrink.

## Tuning (`config.json`)

Shared settings sit at the top; each entry in `languages` has its own sources:

- `peertube.searches`, `archive.queries`: topics to collect videos about.
- `archive.titleSkip`, `commons.fileMustMatch` / `fileSkip`: regular expressions that filter videos by title (e.g. drop songs, keep Chinese-named files).
- `subtitleCodes`: subtitle language codes accepted on Commons (e.g. `zh-hans`, `zh-hant`).
- `maxItemsPerRun` / `maxVideosPerRun`: how much to fetch per run. Each run adds more.
- `maxClipsPerWord`, `maxClipsPerVideo`: index size and variety.
