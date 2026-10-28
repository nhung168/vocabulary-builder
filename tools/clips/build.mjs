#!/usr/bin/env node
// Builds a YouGlish-style "word → video clips" index from free subtitle sources.
//
//   node tools/clips/build.mjs              harvest new subtitles, then rebuild the index
//   node tools/clips/build.mjs --offline    only rebuild the index from the local cache
//   node tools/clips/build.mjs --minutes 20 stop harvesting after 20 minutes
//   node tools/clips/build.mjs --lang zh    only this language (langCode in config.json)
//
// Input:  lib.txt (word<TAB>definition<TAB>language); one index per language in config.json → languages
// Cache:  tools/clips/.cache/ (English) and tools/clips/.cache/<langCode>/   (downloaded subtitles; not published)
// Also:   tools/clips/user/<langCode>/*.json   (subtitles archived from index-ai.html; committed, always used)
// Output: clips/<out>/videos.json + clips/<out>/index/<letter>.json   (read by clips/clips.js; English: out = "")

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makePattern, findMatch, tokenize, isCjkLang, setT2S } from './text.mjs';
import * as src from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const ONLY = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const MINUTES = +(args[args.indexOf('--minutes') + 1] || 40) || 40;
const runEnd = Date.now() + MINUTES * 60e3;
let deadline = runEnd;               // per language: an equal share of what is left
const timeLeft = () => Date.now() < deadline;
const DAY = 864e5;

// the language being built: shared settings + its own entry in config.languages
let cfg, VCACHE, OUT, statePath, state;
function useLanguage(lang) {
  cfg = { ...config, ...lang };
  cfg.subtitleCodes ||= [cfg.langCode];
  const dir = cfg.langCode === 'en' ? CACHE : path.join(CACHE, cfg.langCode); // English predates multi-language
  VCACHE = path.join(dir, 'videos');
  OUT = path.join(ROOT, 'clips', cfg.out || '');
  fs.mkdirSync(VCACHE, { recursive: true });
  statePath = path.join(dir, 'state.json');
  state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  state.commons ||= {}; state.archive ||= {}; state.peertube ||= {};
}
const re = s => s ? new RegExp(s) : null;

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
  const todo = words.filter(w => !fresh(state.commons[w.toLowerCase()]) && makePattern(w, cfg.langCode));
  log(`Commons: searching subtitles for ${todo.length} words`);
  // e.g. Chinese: most Chinese subtitles on Commons translate English speech, so keep files with Chinese names
  const must = re(cfg.commons.fileMustMatch), skip = re(cfg.commons.fileSkip);
  const fileOk = f => (!must || must.test(f)) && (!skip || !skip.test(f));
  let added = 0;
  await pool(todo, 3, async w => {
    try {
      const titles = await src.commonsSearchWord(w, { lang: cfg.langCode, codes: cfg.subtitleCodes, limit: cfg.commons.subtitlePagesPerWord, fileOk });
      for (const t of titles) {
        const key = 'commons:' + src.commonsFile(t);
        if (haveVideo(key)) continue;
        try { const v = await src.commonsVideo(t); if (v.segs.length) { saveVideo(v); added++; } }
        catch (e) { warn(t, e); }
      }
      state.commons[w.toLowerCase()] = Date.now();
    } catch (e) { warn(`commons "${w}"`, e); }
  });
  log(`  +${added} Commons videos`); saveState();
}

async function harvestArchive() {
  const ids = [];
  const skip = re(cfg.archive.titleSkip); // e.g. Japanese songs among the Bilibili copies
  for (const q of cfg.archive.queries) {
    for (let page = 1; page <= 10 && ids.length < cfg.archive.maxItemsPerRun && timeLeft(); page++) {
      let got;
      try { got = await src.archiveSearch(q, 100, page); } catch (e) { warn('archive search', e); break; }
      if (!got.length) break;
      for (const { id, title } of got) if (!fresh(state.archive[id]) && !ids.includes(id) && !(skip && skip.test(title))) ids.push(id);
    }
  }
  const todo = ids.slice(0, cfg.archive.maxItemsPerRun);
  log(`Internet Archive: checking ${todo.length} items`);
  let added = 0;
  await pool(todo, 3, async id => {
    try { for (const v of await src.archiveItem(id, { lang: cfg.langCode })) { saveVideo(v); added++; } state.archive[id] = Date.now(); }
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
// videos the learner archived from index-ai.html: { t, url, y (YouTube id) | u (file URL), segs: [[start, end, text]] }
function loadUserVideos() {
  const dir = path.join(HERE, 'user', cfg.langCode);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!v.y && !v.u) continue;
      out.push({
        key: 'user:' + f, s: v.y ? 'youtube' : 'link', user: true, t: v.t || v.url, y: v.y, u: v.u,
        p: v.y ? `https://www.youtube.com/watch?v=${v.y}` : v.url,
        segs: (v.segs || []).map(([start, end, text]) => ({ start: +start, end: +end, text: String(text || '') }))
          .filter(sg => isFinite(sg.start) && sg.end > sg.start && sg.text),
      });
    } catch (e) { warn(`user video ${f}`, e); }
  }
  return out;
}

function buildIndex(words) {
  const user = loadUserVideos();
  const videos = fs.readdirSync(VCACHE).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(VCACHE, f), 'utf8')))
    .concat(user)
    .sort((a, b) => a.key.localeCompare(b.key));
  log(`Indexing ${words.length} words against ${videos.length} videos (${user.length} archived by you)`);

  // token → [[videoIdx, segIdx], …] so each word only checks segments that contain it
  const inv = new Map();
  videos.forEach((v, vi) => v.segs.forEach((sg, si) => {
    if (sg.text.includes('♪')) return; // song lyrics make poor examples
    for (const t of new Set(tokenize(sg.text, cfg.langCode).map(x => x.w))) {
      let l = inv.get(t); if (!l) inv.set(t, l = []); l.push([vi, si]);
    }
  }));

  const cjk = isCjkLang(cfg.langCode);
  const idealLen = cjk ? 16 : 90; // characters in a comfortable subtitle line
  const used = new Map(); // video idx → output idx
  const shards = {};
  let covered = 0;
  for (const w of words) {
    const pat = makePattern(w, cfg.langCode);
    if (!pat) continue;
    const multi = pat.length > 1 || (pat[0].cjk || '').length > 1;
    const anchor = pat.find(p => p.forms);
    const cands = [];
    const seenSeg = new Set();
    for (const f of anchor.forms) for (const [vi, si] of inv.get(f) || []) {
      const id = vi + ':' + si;
      if (seenSeg.has(id)) continue; seenSeg.add(id);
      const v = videos[vi], sg = v.segs[si];
      let text = sg.text, end = sg.end, m = findMatch(pat, text);
      if (!m && multi && v.segs[si + 1]) {       // phrase split across two cues
        const nx = v.segs[si + 1];
        const joined = text + (cjk ? '' : ' ') + nx.text;
        const mm = findMatch(pat, joined);
        if (mm && mm.s < text.length) { m = mm; text = joined; end = nx.end; }
      }
      if (!m) continue;
      const dur = end - sg.start;
      if (dur > 25 || text.length > 260) continue;
      const score = -Math.abs(dur - 6) / 2 - Math.abs(text.length - idealLen) / (idealLen / 2) + (/^[A-Z]/.test(text) ? 0.5 : 0)
        + (v.user ? 3 : 0); // videos you archived come first
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
    const shard = /^[a-z]/.test(key) ? key[0] : 'other'; // not "_": GitHub Pages (Jekyll) drops files starting with _
    (shards[shard] ||= {})[key] = picked.map(c => {
      if (!used.has(c.vi)) used.set(c.vi, used.size);
      return [used.get(c.vi), +Math.max(0, c.start - 0.5).toFixed(2), +(c.end + 0.3).toFixed(2), c.text, c.m.s, c.m.e];
    });
    covered++;
  }

  const outVideos = [];
  for (const [vi, oi] of used) {
    const v = videos[vi];
    outVideos[oi] = Object.fromEntries(Object.entries({ s: v.s, t: v.t, u: v.u, e: v.e, y: v.y, p: v.p }).filter(([, x]) => x));
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

// ── Traditional → Simplified table for matching Chinese (OpenCC, Apache-2.0), cached ──
async function loadT2S() {
  const file = path.join(CACHE, 'opencc-TSCharacters.txt');
  if (!fs.existsSync(file) && !OFFLINE) {
    try { fs.writeFileSync(file, await src.get('https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt', 'text')); }
    catch (e) { warn('OpenCC table', e); }
  }
  if (!fs.existsSync(file)) return log('  (no Traditional→Simplified table: only Simplified subtitles will match)');
  const map = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const [t, s] = l.split('\t');
    const simp = (s || '').split(' ')[0];
    if (t && t.length === 1 && simp.length === 1) map.set(t, simp);
  }
  setT2S(map);
}

// ── main ──
const langs = config.languages.filter(l => !ONLY || l.langCode === ONLY).map(l => ({ l, words: (useLanguage(l), loadWords()) }));
const todo = langs.filter(x => x.words.length);
for (const { l } of langs) if (!todo.some(x => x.l === l)) log(`\n== ${l.language}: no words in lib.txt — skipped`);
for (const [n, { l, words }] of todo.entries()) {
  useLanguage(l);
  deadline = Date.now() + (runEnd - Date.now()) / (todo.length - n);
  log(`\n== ${cfg.language} (${cfg.langCode}): ${words.length} words`);
  if (isCjkLang(cfg.langCode)) await loadT2S();
  if (!OFFLINE) {
    errors = 0;
    if (cfg.commons?.enabled) await harvestCommons(words);
    if (cfg.archive?.enabled && timeLeft()) await harvestArchive();
    if (cfg.peertube?.enabled && timeLeft()) await harvestPeertube();
    if (errors) log(`(${errors} fetch errors — skipped)`);
  }
  buildIndex(words);
}
