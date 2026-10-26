#!/usr/bin/env node
// Builds a YouGlish-style "word → video clips" index from free subtitle sources.
//
//   node tools/clips/build.mjs              harvest new subtitles, then rebuild the index
//   node tools/clips/build.mjs --offline    only rebuild the index from the local cache
//   node tools/clips/build.mjs --minutes 20 stop harvesting after 20 minutes
//
// Input:  lib.txt (word<TAB>definition<TAB>language)
// Cache:  tools/clips/.cache/   (downloaded subtitles; not published)
// Output: clips/videos.json + clips/index/<letter>.json   (read by clips/clips.js)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makePattern, findMatch, tokenize } from './text.mjs';
import * as src from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const VCACHE = path.join(CACHE, 'videos');
const OUT = path.join(ROOT, 'clips');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const MINUTES = +(args[args.indexOf('--minutes') + 1] || 40) || 40;
const deadline = Date.now() + MINUTES * 60e3;
const timeLeft = () => Date.now() < deadline;
const DAY = 864e5;

fs.mkdirSync(VCACHE, { recursive: true });

// ── lib.txt ──
function loadWords() {
  const rows = fs.readFileSync(path.join(ROOT, 'lib.txt'), 'utf8').replace(/\r/g, '').split('\n');
  const seen = new Set(), words = [];
  for (const r of rows) {
    const c = r.split('\t');
    if ((c[2] || '').trim() !== cfg.language) continue;
    const w = (c[0] || '').trim();
    const k = w.toLowerCase();
    if (w && !seen.has(k)) { seen.add(k); words.push(w); }
  }
  return words;
}

// ── cache ──
const statePath = path.join(CACHE, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
state.commons ||= {}; state.archive ||= {}; state.peertube ||= {};
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state));
const vfile = key => path.join(VCACHE, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
const haveVideo = key => fs.existsSync(vfile(key));
const saveVideo = v => fs.writeFileSync(vfile(v.key), JSON.stringify(v));
const fresh = ts => ts && Date.now() - ts < cfg.recheckDays * DAY;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && timeLeft()) { const it = items[i++]; await fn(it); }
  }));
}

const log = (...a) => console.log(...a);
let errors = 0;
const warn = (what, e) => { errors++; if (errors <= 40) console.warn(`  ! ${what}: ${e.message}`); };

// ── harvesting ──
async function harvestCommons(words) {
  const todo = words.filter(w => !fresh(state.commons[w.toLowerCase()]) && makePattern(w));
  log(`Commons: searching subtitles for ${todo.length} words`);
  let added = 0;
  await pool(todo, 3, async w => {
    try {
      const titles = await src.commonsSearchWord(w, { lang: cfg.langCode, limit: cfg.commons.subtitlePagesPerWord });
      for (const t of titles) {
        const key = 'commons:' + t.replace(/^TimedText:/, '').slice(0, -(`.${cfg.langCode}.srt`.length));
        if (haveVideo(key)) continue;
        try { const v = await src.commonsVideo(t, cfg.langCode); if (v.segs.length) { saveVideo(v); added++; } }
        catch (e) { warn(t, e); }
      }
      state.commons[w.toLowerCase()] = Date.now();
    } catch (e) { warn(`commons "${w}"`, e); }
  });
  log(`  +${added} Commons videos`); saveState();
}

async function harvestArchive() {
  const ids = [];
  for (const q of cfg.archive.queries) {
    for (let page = 1; page <= 10 && ids.length < cfg.archive.maxItemsPerRun && timeLeft(); page++) {
      let got;
      try { got = await src.archiveSearch(q, 100, page); } catch (e) { warn('archive search', e); break; }
      if (!got.length) break;
      for (const id of got) if (!fresh(state.archive[id]) && !ids.includes(id)) ids.push(id);
    }
  }
  const todo = ids.slice(0, cfg.archive.maxItemsPerRun);
  log(`Internet Archive: checking ${todo.length} items`);
  let added = 0;
  await pool(todo, 3, async id => {
    try { for (const v of await src.archiveItem(id)) { saveVideo(v); added++; } state.archive[id] = Date.now(); }
    catch (e) { warn(`archive ${id}`, e); }
  });
  log(`  +${added} Archive videos`); saveState();
}

async function harvestPeertube() {
  const vids = [], seen = new Set();
  for (const s of cfg.peertube.searches) {
    for (let start = 0; start < 200 && vids.length < cfg.peertube.maxVideosPerRun && timeLeft(); start += 50) {
      let got;
      try { got = await src.peertubeSearch({ search: s, start, count: 50, language: cfg.langCode }); } catch (e) { warn('peertube search', e); break; }
      if (!got.length) break;
      for (const v of got) if (!seen.has(v.uuid) && !fresh(state.peertube[v.uuid])) { seen.add(v.uuid); vids.push(v); }
    }
  }
  const todo = vids.slice(0, cfg.peertube.maxVideosPerRun);
  log(`PeerTube: checking ${todo.length} videos for ${cfg.langCode} captions`);
  let added = 0;
  await pool(todo, 4, async v => {
    try { const r = await src.peertubeVideo(v, cfg.langCode); if (r) { saveVideo(r); added++; } state.peertube[v.uuid] = Date.now(); }
    catch (e) { warn(`peertube ${v.uuid}`, e); state.peertube[v.uuid] = Date.now(); }
  });
  log(`  +${added} PeerTube videos`); saveState();
}

// ── indexing ──
function buildIndex(words) {
  const videos = fs.readdirSync(VCACHE).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(VCACHE, f), 'utf8')))
    .sort((a, b) => a.key.localeCompare(b.key));
  log(`Indexing ${words.length} words against ${videos.length} videos`);

  // token → [[videoIdx, segIdx], …] so each word only checks segments that contain it
  const inv = new Map();
  videos.forEach((v, vi) => v.segs.forEach((sg, si) => {
    for (const t of new Set(tokenize(sg.text).map(x => x.w))) {
      let l = inv.get(t); if (!l) inv.set(t, l = []); l.push([vi, si]);
    }
  }));

  const used = new Map(); // video idx → output idx
  const shards = {};
  let covered = 0;
  for (const w of words) {
    const pat = makePattern(w);
    if (!pat) continue;
    const anchor = pat.find(p => p.forms);
    const cands = [];
    const seenSeg = new Set();
    for (const f of anchor.forms) for (const [vi, si] of inv.get(f) || []) {
      const id = vi + ':' + si;
      if (seenSeg.has(id)) continue; seenSeg.add(id);
      const v = videos[vi], sg = v.segs[si];
      let text = sg.text, end = sg.end, m = findMatch(pat, text);
      if (!m && pat.length > 1 && v.segs[si + 1]) {       // phrase split across two cues
        const nx = v.segs[si + 1];
        const joined = text + ' ' + nx.text;
        const mm = findMatch(pat, joined);
        if (mm && mm.s < text.length) { m = mm; text = joined; end = nx.end; }
      }
      if (!m) continue;
      const dur = end - sg.start;
      if (dur > 25 || text.length > 260) continue;
      const score = -Math.abs(dur - 6) / 2 - Math.abs(text.length - 90) / 50 + (/^[A-Z]/.test(text) ? 0.5 : 0);
      cands.push({ vi, start: sg.start, end, text, m, score });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => b.score - a.score);
    // pick: ≤ maxClipsPerVideo per video, then interleave sources for variety
    const perVideo = new Map(), bySource = {};
    for (const c of cands) {
      const n = perVideo.get(c.vi) || 0;
      if (n >= cfg.maxClipsPerVideo) continue;
      perVideo.set(c.vi, n + 1);
      (bySource[videos[c.vi].s] ||= []).push(c);
    }
    const picked = [], lists = Object.values(bySource);
    while (picked.length < cfg.maxClipsPerWord && lists.some(l => l.length)) for (const l of lists) if (l.length && picked.length < cfg.maxClipsPerWord) picked.push(l.shift());

    const key = w.toLowerCase();
    const shard = /^[a-z]/.test(key) ? key[0] : '_';
    (shards[shard] ||= {})[key] = picked.map(c => {
      if (!used.has(c.vi)) used.set(c.vi, used.size);
      return [used.get(c.vi), +Math.max(0, c.start - 0.5).toFixed(2), +(c.end + 0.3).toFixed(2), c.text, c.m.s, c.m.e];
    });
    covered++;
  }

  const outVideos = [];
  for (const [vi, oi] of used) {
    const v = videos[vi];
    outVideos[oi] = Object.fromEntries(Object.entries({ s: v.s, t: v.t, u: v.u, e: v.e, p: v.p }).filter(([, x]) => x));
  }
  fs.rmSync(path.join(OUT, 'index'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'index'), { recursive: true });
  for (const [k, obj] of Object.entries(shards)) fs.writeFileSync(path.join(OUT, 'index', k + '.json'), JSON.stringify(obj));
  fs.writeFileSync(path.join(OUT, 'videos.json'), JSON.stringify({ language: cfg.language, videos: outVideos }));
  const bySrc = outVideos.reduce((a, v) => (a[v.s] = (a[v.s] || 0) + 1, a), {});
  const stats = { words: words.length, wordsWithClips: covered, videosUsed: outVideos.length, videosCached: videos.length, bySource: bySrc };
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 1));
  log(`Done: ${covered}/${words.length} words have clips, from ${outVideos.length} videos`, bySrc);
}

// ── main ──
const words = loadWords();
if (!OFFLINE) {
  if (cfg.commons?.enabled) await harvestCommons(words);
  if (cfg.archive?.enabled && timeLeft()) await harvestArchive();
  if (cfg.peertube?.enabled && timeLeft()) await harvestPeertube();
  if (errors) log(`(${errors} fetch errors — skipped)`);
}
buildIndex(words);
