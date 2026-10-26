// Subtitle parsing and word/phrase matching. No dependencies.

// ── Subtitles (SRT or WebVTT) → [{start, end, text}] ──
function toSec(t) {
  const m = t.trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function cleanCue(s) {
  return s
    .replace(/\{\\[^}]*\}/g, '')            // {\an8} SSA tags
    .replace(/<[^>]+>/g, '')                // <i>, <c.color>, <00:01.000>
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/^\s*-\s+/gm, '')              // dialogue dashes
    .replace(/\[[^\]]*\]|\([A-Z ]+\)/g, '') // [Music], (APPLAUSE)
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSubs(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r/g, '');
  // line-based so it also copes with files that omit the blank line between cues
  const lines = text.split('\n');
  const cues = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('-->')) {
      const [a, z] = l.split('-->');
      cur = { start: toSec(a), end: toSec((z || '').trim().split(/\s+/)[0]), lines: [] };
      cues.push(cur);
    } else if (!l.trim()) {
      cur = null;
    } else if (cur) {
      // a numeric line, or one after a blank line, right before a timing line is a cue id — not text
      const isId = (lines[i + 1] || '').includes('-->') && (/^\d+$/.test(l.trim()) || !(lines[i - 1] || '').trim());
      if (!isId) cur.lines.push(l);
    }
  }
  const segs = [];
  for (const c of cues) {
    const { start, end } = c;
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const t = cleanCue(c.lines.join(' '));
    if (!t) continue;
    // auto-captions often repeat the previous line ("rolling" captions) → merge
    const prev = segs[segs.length - 1];
    if (prev && (prev.text === t || t.startsWith(prev.text + ' ')) && start - prev.end < 1) {
      prev.text = t; prev.end = Math.max(prev.end, end); continue;
    }
    segs.push({ start: +start.toFixed(2), end: +end.toFixed(2), text: t });
  }
  return segs;
}

// ── Word forms ──
const IRREGULAR = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'], have: ['has', 'had', 'having'],
  do: ['does', 'did', 'done', 'doing'], go: ['goes', 'went', 'gone', 'going'],
  get: ['gets', 'got', 'gotten', 'getting'], make: ['makes', 'made', 'making'],
  take: ['takes', 'took', 'taken', 'taking'], come: ['comes', 'came', 'coming'],
  give: ['gives', 'gave', 'given', 'giving'], eat: ['eats', 'ate', 'eaten', 'eating'],
  run: ['runs', 'ran', 'running'], bring: ['brings', 'brought', 'bringing'],
  think: ['thinks', 'thought', 'thinking'], buy: ['buys', 'bought', 'buying'],
  catch: ['catches', 'caught', 'catching'], teach: ['teaches', 'taught', 'teaching'],
  seek: ['seeks', 'sought', 'seeking'], fight: ['fights', 'fought', 'fighting'],
  keep: ['keeps', 'kept', 'keeping'], hold: ['holds', 'held', 'holding'],
  stand: ['stands', 'stood', 'standing'], fall: ['falls', 'fell', 'fallen', 'falling'],
  break: ['breaks', 'broke', 'broken', 'breaking'], speak: ['speaks', 'spoke', 'spoken', 'speaking'],
  write: ['writes', 'wrote', 'written', 'writing'], ride: ['rides', 'rode', 'ridden', 'riding'],
  rise: ['rises', 'rose', 'risen', 'rising'], drive: ['drives', 'drove', 'driven', 'driving'],
  see: ['sees', 'saw', 'seen', 'seeing'], know: ['knows', 'knew', 'known', 'knowing'],
  grow: ['grows', 'grew', 'grown', 'growing'], throw: ['throws', 'threw', 'thrown', 'throwing'],
  blow: ['blows', 'blew', 'blown', 'blowing'], draw: ['draws', 'drew', 'drawn', 'drawing'],
  fly: ['flies', 'flew', 'flown', 'flying'], tell: ['tells', 'told', 'telling'],
  sell: ['sells', 'sold', 'selling'], find: ['finds', 'found', 'finding'],
  leave: ['leaves', 'left', 'leaving'], feel: ['feels', 'felt', 'feeling'],
  lead: ['leads', 'led', 'leading'], meet: ['meets', 'met', 'meeting'],
  pay: ['pays', 'paid', 'paying'], say: ['says', 'said', 'saying'],
  lay: ['lays', 'laid', 'laying'], lie: ['lies', 'lay', 'lain', 'lying', 'lied'],
  win: ['wins', 'won', 'winning'], lose: ['loses', 'lost', 'losing'],
  spend: ['spends', 'spent', 'spending'], send: ['sends', 'sent', 'sending'],
  build: ['builds', 'built', 'building'], put: ['puts', 'putting'], set: ['sets', 'setting'],
  cut: ['cuts', 'cutting'], let: ['lets', 'letting'], hit: ['hits', 'hitting'],
  shut: ['shuts', 'shutting'], quit: ['quits', 'quitting'], cost: ['costs', 'costing'],
  dig: ['digs', 'dug', 'digging'], stick: ['sticks', 'stuck', 'sticking'],
  strike: ['strikes', 'struck', 'striking'], swing: ['swings', 'swung', 'swinging'],
  hang: ['hangs', 'hung', 'hanging'], sink: ['sinks', 'sank', 'sunk', 'sinking'],
  begin: ['begins', 'began', 'begun', 'beginning'], choose: ['chooses', 'chose', 'chosen', 'choosing'],
  forget: ['forgets', 'forgot', 'forgotten', 'forgetting'], wear: ['wears', 'wore', 'worn', 'wearing'],
  tear: ['tears', 'tore', 'torn', 'tearing'], bear: ['bears', 'bore', 'borne', 'born', 'bearing'],
  shake: ['shakes', 'shook', 'shaken', 'shaking'], wake: ['wakes', 'woke', 'woken', 'waking'],
  mean: ['means', 'meant', 'meaning'], deal: ['deals', 'dealt', 'dealing'],
  child: ['children'], person: ['people'], man: ['men'], woman: ['women'],
  foot: ['feet'], tooth: ['teeth'], mouse: ['mice'], crisis: ['crises'], analysis: ['analyses'],
};
const FUNCTION_WORDS = new Set(('a an the to of in on at for with from by about into onto over under up down out off ' +
  'and or but as than so if not no it its this that these those my your his her our their me him us them you i we they ' +
  'is be are was were').split(' '));
const VOWEL = /[aeiou]/;

export function forms(w) {
  const f = new Set([w]);
  if (FUNCTION_WORDS.has(w) || w.length < 3 || w.includes("'")) return f;
  // plural dictionary entry ("holograms") → inflect the singular instead
  if (/[^aeiu]s$/.test(w) && !/(ss|us|is|ics|ews|ies|ens|eans)$/.test(w) && w.length > 4 && !IRREGULAR[w]) {
    const sing = /(ches|shes|xes|zes)$/.test(w) ? w.slice(0, -2) : w.slice(0, -1);
    return new Set([w, ...forms(sing)]);
  }
  (IRREGULAR[w] || []).forEach(x => f.add(x));
  for (const [base, list] of Object.entries(IRREGULAR)) if (list.includes(w)) { f.add(base); list.forEach(x => f.add(x)); }
  const last = w.at(-1), stem = w.slice(0, -1);
  if (/[^aeiou]y$/.test(w)) { f.add(stem + 'ies'); f.add(stem + 'ied'); f.add(w + 'ing'); f.add(stem + 'ier'); f.add(stem + 'iest'); f.add(stem + 'ily'); }
  else if (/ie$/.test(w)) { f.add(w + 's'); f.add(w + 'd'); f.add(w.slice(0, -2) + 'ying'); }
  else if (last === 'e') { f.add(w + 's'); f.add(w + 'd'); f.add(stem + 'ing'); f.add(w + 'r'); }
  else if (/(s|x|z|ch|sh)$/.test(w)) { f.add(w + 'es'); f.add(w + 'ed'); f.add(w + 'ing'); }
  else {
    f.add(w + 's'); f.add(w + 'ed'); f.add(w + 'ing');
    // stop → stopped / stopping (short consonant-vowel-consonant words)
    if (/[^aeiou][aeiou][bdgklmnprt]$/.test(w) && w.length <= 6) { f.add(w + last + 'ed'); f.add(w + last + 'ing'); }
  }
  // the dictionary entry may itself be a plural / past form (e.g. "holograms", "props")
  if (/[^s]s$/.test(w) && w.length > 4) f.add(stem);
  if (/ies$/.test(w)) f.add(w.slice(0, -3) + 'y');
  if (/ed$/.test(w) && w.length > 5) { f.add(w.slice(0, -2)); f.add(w.slice(0, -1)); }
  if (/ing$/.test(w) && w.length > 6 && VOWEL.test(w.slice(0, -3))) { f.add(w.slice(0, -3)); f.add(w.slice(0, -3) + 'e'); }
  return f;
}

// ── Dictionary entry → pattern ──
const GAP_WORDS = new Set(['someone', 'somebody', 'something', 'sb', 'sth', "one's", 'oneself', "someone's", "somebody's", 'smb', 'smth']);

export function cleanEntry(word) {
  return String(word).toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')  // (sth), [informal]
    .split(/\s+\/\s+|;|,/)[0]                // "a / b" → a
    .replace(/[~…!?.:"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns a pattern [{forms:Set}|{gap:true}], or null when the entry can't be matched in English text
export function makePattern(word) {
  const c = cleanEntry(word);
  if (!c || !/^[a-z0-9' -]+$/.test(c)) return null;
  const toks = c.split(' ').filter(Boolean);
  if (!toks.length || toks.length > 6) return null;
  const pat = toks.map(t => GAP_WORDS.has(t) ? { gap: true } : { forms: forms(t) });
  while (pat.length && pat[0].gap) pat.shift();
  while (pat.length && pat.at(-1).gap) pat.pop();
  if (!pat.length) return null;
  if (pat.length === 1 && [...pat[0].forms][0].length < 3) return null;
  return pat;
}

// Text → tokens with char offsets
export function tokenize(text) {
  const toks = [];
  const re = /[a-z0-9]+(?:['’-][a-z0-9]+)*/gi;
  let m;
  while ((m = re.exec(text))) toks.push({ w: m[0].toLowerCase().replace(/’/g, "'"), s: m.index, e: m.index + m[0].length });
  return toks;
}

const MAX_GAP = 3;
function matchAt(pat, toks, pi, ti) {
  if (pi === pat.length) return ti; // index after last matched token
  const p = pat[pi];
  if (p.gap) {
    for (let g = 0; g <= MAX_GAP && ti + g <= toks.length; g++) {
      const r = matchAt(pat, toks, pi + 1, ti + g);
      if (r >= 0) return r;
    }
    return -1;
  }
  if (ti >= toks.length) return -1;
  const w = toks[ti].w;
  // hyphenated text word ("well-being") also matches entry "well-being"; plain entries match either part
  if (p.forms.has(w) || p.forms.has(w.replace(/'s$/, ''))) return matchAt(pat, toks, pi + 1, ti + 1);
  return -1;
}

// → {s, e} char range of the first match in text, or null
export function findMatch(pat, text, toks = tokenize(text)) {
  for (let i = 0; i < toks.length; i++) {
    const end = matchAt(pat, toks, 0, i);
    if (end >= 0) return { s: toks[i].s, e: toks[end - 1].e };
  }
  return null;
}

// Words worth searching for in a full-text engine (drops gaps and function words)
export function searchTerms(word) {
  const c = cleanEntry(word);
  const toks = c.split(' ').filter(t => t && !GAP_WORDS.has(t));
  return toks;
}
