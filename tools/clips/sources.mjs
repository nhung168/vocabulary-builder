// Free subtitle sources. Each returns videos as:
//   { key, s: source, id, t: title, u?: direct media URL, e?: embed URL, p: page URL, segs: [{start,end,text}] }
import { parseSubs, searchTerms } from './text.mjs';

const UA = 'vocabulary-builder-clips/1.0 (https://github.com/nhung168/vocabulary-builder)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function get(url, type = 'json', tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.fatal = true; throw e; }
      return type === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (e.fatal || i >= tries) throw new Error(`${e.message} — ${url}`);
      await sleep(1500 * i);
    }
  }
}

// ───────── Wikimedia Commons ─────────
// Subtitles live on wiki pages "TimedText:<File name>.<lang>.srt", and CirrusSearch indexes their text,
// so we can search subtitles *for a specific word* (like YouGlish does).
const COMMONS = 'https://commons.wikimedia.org';

// codes: subtitle language codes to accept (e.g. zh, zh-hans, zh-hant); fileOk: filter on the video's file name
export async function commonsSearchWord(word, { lang = 'en', codes = [lang], limit = 4, fileOk = () => true } = {}) {
  const terms = searchTerms(word, lang);
  if (!terms.length) return [];
  const q = terms.length > 1 || terms[0].length < 4 ? `"${terms.join(' ')}"` : terms[0];
  const url = `${COMMONS}/w/api.php?action=query&list=search&srnamespace=102&srlimit=50&srprop=&format=json&srsearch=${encodeURIComponent(q)}`;
  const j = await get(url);
  return (j.query?.search || []).map(x => x.title)
    .filter(t => codes.some(c => t.endsWith(`.${c}.srt`)) && fileOk(commonsFile(t)))
    .slice(0, limit);
}

// "TimedText:<file>.<lang code>.srt" → "<file>"
export const commonsFile = ttTitle => ttTitle.replace(/^TimedText:/, '').replace(/\.[a-z]{2,3}(-[a-z]+)*\.srt$/i, '');

export async function commonsVideo(ttTitle) {
  const file = commonsFile(ttTitle);
  const raw = await get(`${COMMONS}/w/index.php?action=raw&title=${encodeURIComponent(ttTitle)}`, 'text');
  const segs = parseSubs(raw);
  return {
    key: 'commons:' + file, s: 'commons', id: file,
    t: file.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '),
    u: `${COMMONS}/wiki/Special:FilePath/${encodeURIComponent(file)}`,
    p: `${COMMONS}/wiki/File:${encodeURIComponent(file)}`,
    segs,
  };
}

// ───────── Internet Archive ─────────
// Items with .srt/.vtt files next to their videos. Collected by search query (subtitle text is not searchable).
const ARCHIVE = 'https://archive.org';

// → [{ id, title }]
export async function archiveSearch(query, rows = 50, page = 1) {
  const url = `${ARCHIVE}/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&sort[]=downloads+desc&rows=${rows}&page=${page}&output=json`;
  const j = await get(url);
  return (j.response?.docs || []).map(d => ({ id: d.identifier, title: [].concat(d.title || '')[0] }));
}

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv)$/i;
// caption file name tags that mean the wanted language: "x.en.srt", "x.eng.srt", "x-ai-zh.srt" (Bilibili copies)
const LANG_TAGS = {
  en: 'en|eng|english|en-us|en-gb',
  zh: 'zh|chi|zho|cmn|chs|cht|chinese|zh-cn|zh-tw|zh-hk|zh-hans|zh-hant',
  es: 'es|spa|spanish|es-es|es-mx|es-419',
};
const capRe = lang => new RegExp(`^(.*?)(?:[._-](?:ai-)?(${LANG_TAGS[lang] || lang}))?\\.(srt|vtt)$`, 'i');

export async function archiveItem(id, { maxPerItem = 3, lang = 'en' } = {}) {
  const CAP_RE = capRe(lang);
  const j = await get(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`);
  const files = j.files || [];
  let title = (Array.isArray(j.metadata?.title) ? j.metadata.title[0] : j.metadata?.title) || id;
  if (/^BiliBili-/.test(id)) title = title.replace(/\s+P\d+(\s.*)?$/, ''); // "<title> P1 <part title>"
  const vids = files.filter(f => VIDEO_EXT.test(f.name));
  const out = [];
  for (const f of files) {
    const m = f.name.match(CAP_RE);
    if (!m) continue;
    // skip captions explicitly tagged with another language (e.g. ".es.srt", "-ai-ja.srt")
    if (!m[2] && /(\.[a-z]{2}(-[a-z]{2})?|-ai-[a-z]{2,3})$/i.test(m[1])) continue;
    const base = m[1];
    const video = vids.find(v => v.name.replace(VIDEO_EXT, '') === base && /\.mp4$/i.test(v.name))
      || vids.find(v => v.name.replace(VIDEO_EXT, '') === base)
      || (vids.length === 1 ? vids[0] : null);
    if (!video) continue;
    const raw = await get(`${ARCHIVE}/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`, 'text');
    const segs = parseSubs(raw);
    if (segs.length < 5) continue;
    out.push({
      key: `archive:${id}/${video.name}`, s: 'archive', id: `${id}/${video.name}`,
      t: new Set(vids.map(v => v.name.replace(VIDEO_EXT, '').replace(/\.ia$/, ''))).size > 1 ? `${title} — ${base.split('/').pop()}` : title,
      u: `${ARCHIVE}/download/${encodeURIComponent(id)}/${video.name.split('/').map(encodeURIComponent).join('/')}`,
      p: `${ARCHIVE}/details/${encodeURIComponent(id)}`,
      segs,
    });
    if (out.length >= maxPerItem) break;
  }
  return out;
}

// ───────── PeerTube (federated, open-source YouTube alternative) ─────────
// SepiaSearch indexes videos from hundreds of PeerTube servers; captions come from each video's own server.
export async function peertubeSearch({ search, count = 50, start = 0, language = 'en', index = 'https://sepiasearch.org' }) {
  const url = `${index}/api/v1/search/videos?search=${encodeURIComponent(search)}&count=${count}&start=${start}` +
    `&languageOneOf=${language}&durationMin=60&nsfw=false&sort=-match`;
  const j = await get(url);
  return (j.data || []).filter(v => !v.isLive);
}

export async function peertubeVideo(v, lang = 'en') {
  const host = v.channel?.host || v.account?.host || new URL(v.url).host;
  const caps = await get(`https://${host}/api/v1/videos/${v.uuid}/captions`);
  const list = (caps.data || []).filter(c => c.language?.id === lang || c.language?.id?.startsWith(lang + '-'));
  if (!list.length) return null;
  list.sort((a, b) => (a.automaticallyGenerated ? 1 : 0) - (b.automaticallyGenerated ? 1 : 0)); // prefer human captions
  const c = list[0];
  const capUrl = c.fileUrl || `https://${host}${c.captionPath}`;
  const segs = parseSubs(await get(capUrl, 'text'));
  if (segs.length < 5) return null;
  return {
    key: `peertube:${host}/${v.uuid}`, s: 'peertube', id: `${host}/${v.uuid}`, t: v.name,
    e: v.embedUrl || `https://${host}/videos/embed/${v.uuid}`,
    p: v.url || `https://${host}/w/${v.shortUUID || v.uuid}`,
    segs,
  };
}
