#!/usr/bin/env node
// Adds lighter versions of each video to clips/videos.json so phones start playing sooner:
//   u  → direct file URL (skips the Special:FilePath redirect on Commons)
//   l  → low-resolution copy (Commons 240p/360p transcode, Internet Archive .ia.mp4 / _512kb.mp4)
//   m  → MPEG-4 copy for browsers that can't play WebM (older iPhones)
// Commons transcodes live at <upload>/transcoded/<hash>/<file>/<file>.<key>, so l/m store just <key>
// (e.g. "240p.vp9.webm"); clips.js rebuilds the URL from u.
//
//   node tools/clips/light.mjs          run after build.mjs (the workflow does this)
//
// Lookups are cached in tools/clips/.cache/light.json, so each run only asks about new videos.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(ROOT, 'clips', 'videos.json');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const DAY = 864e5;

fs.mkdirSync(CACHE, { recursive: true });
const cachePath = path.join(CACHE, 'light.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const fresh = c => c && Date.now() - c.ts < cfg.recheckDays * DAY;
const stripQuery = u => u.replace(/\?.*$/, '');

// ── Wikimedia Commons: the API lists every transcode of a file ──
async function commonsBatch(videos) {
  const byTitle = new Map(videos.map(v => ['File:' + decodeURIComponent(v.p.split('/wiki/File:')[1]).replace(/_/g, ' '), v]));
  const titles = [...byTitle.keys()];
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    let j;
    try {
      j = await get('https://commons.wikimedia.org/w/api.php?action=query&prop=videoinfo&viprop=derivatives&format=json&formatversion=2&titles=' +
        encodeURIComponent(part.join('|')));
    } catch (e) { console.warn('  ! commons', e.message); continue; }
    const norm = new Map((j.query?.normalized || []).map(n => [n.to, n.from]));
    for (const pg of j.query?.pages || []) {
      const v = byTitle.get(norm.get(pg.title) || pg.title);
      if (!v) continue;
      const ds = pg.videoinfo?.[0]?.derivatives || [];
      const orig = ds.find(d => !d.transcodekey);
      const small = (re) => ds.filter(d => d.transcodekey && re.test(d.transcodekey) && d.height >= 240 && (!orig || d.height < orig.height))
        .sort((a, b) => a.height - b.height)[0];
      const low = small(/\.vp9\.webm$/) || small(/^\d+p\.webm$/);
      const mp4 = small(/\.(mp4|mpeg4\.mov)$/);
      cache[v.p] = { ts: Date.now(), u: orig && stripQuery(orig.src), l: low?.src, m: mp4?.src };
    }
  }
}

// ── Internet Archive: some items have a smaller derivative made from the original upload ──
const IA_LIGHT = ['h.264 IA', '512Kb MPEG4', 'h.264'];
async function archiveOne(v) {
  const m = v.u.match(/\/download\/([^/]+)\/(.+)$/);
  if (!m) return;
  const id = decodeURIComponent(m[1]), name = m[2].split('/').map(decodeURIComponent).join('/');
  let j;
  try { j = await get(`https://archive.org/metadata/${encodeURIComponent(id)}`); } catch (e) { console.warn('  ! archive', e.message); return; }
  const files = j.files || [];
  const me = files.find(f => f.name === name);
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const light = files
    .filter(f => IA_LIGHT.includes(f.format) && f.name !== name && (f.original === name || f.name.startsWith(base)))
    .filter(f => !me || +f.size < +me.size)
    .sort((a, b) => +a.size - +b.size)[0];
  cache[v.u] = { ts: Date.now(),
    l: light && `https://archive.org/download/${encodeURIComponent(id)}/${light.name.split('/').map(encodeURIComponent).join('/')}` };
}

const meta = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const vids = meta.videos;
const keyOf = v => v.s === 'archive' ? v.u : v.p;
const commonsTodo = vids.filter(v => v.s === 'commons' && v.p && !fresh(cache[v.p]));
const archiveTodo = vids.filter(v => v.s === 'archive' && v.u && !fresh(cache[keyOf(v)]));
console.log(`Light versions: looking up ${commonsTodo.length} Commons + ${archiveTodo.length} Archive videos`);
await commonsBatch(commonsTodo);
for (const v of archiveTodo) await archiveOne(v);
fs.writeFileSync(cachePath, JSON.stringify(cache));

// Commons: keep only the transcode key when the URL follows the usual layout
function short(v, url) {
  if (!url || v.s !== 'commons') return url;
  const pre = v.u.replace('/wikipedia/commons/', '/wikipedia/commons/transcoded/') + '/' + v.u.split('/').pop() + '.';
  return url.startsWith(pre) ? url.slice(pre.length) : url;
}

let n = 0;
for (const v of vids) {
  const c = cache[keyOf(v)];
  if (!c) continue;
  if (c.u) v.u = c.u;
  if (c.l) { v.l = short(v, c.l); n++; }
  if (c.m) v.m = short(v, c.m);
}
fs.writeFileSync(OUT, JSON.stringify(meta));
console.log(`Light versions: ${n}/${vids.length} videos have a low-resolution copy`);
