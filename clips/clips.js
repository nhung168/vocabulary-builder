/* VocabClips — a small YouGlish-style player for clips from free video sources.
 *
 *   VocabClips.mount(element)          create the player inside element
 *   VocabClips.prefetch(word)          load the index shard early (call when a word is shown)
 *   await VocabClips.show(word, lang)  play clips for word → true, or false when there are none
 *   VocabClips.stop()                  stop playback and hide the player
 *   VocabClips.step(±1)                next / previous clip → false when the player isn't showing
 *
 * Videos play from a low-resolution copy (u/l/m in videos.json, see tools/clips/light.mjs) unless HD is on.
 *
 * Data: clips/videos.json + clips/index/<first letter>.json, built by tools/clips/build.mjs.
 */
(function () {
  'use strict';
  var BASE = (document.currentScript && document.currentScript.src || '').replace(/[^/]*$/, '');
  var PT_API = 'https://unpkg.com/@peertube/embed-api@0.2.0/build/player.min.js';
  var SOURCE_NAME = { commons: 'Wikimedia Commons', archive: 'Internet Archive', peertube: 'PeerTube' };

  var meta = null, metaP = null, shards = {}, ui = null;
  var HD_KEY = 'vc_hd';
  var S = { word: '', clips: [], i: 0, token: 0, rate: 1, dir: 1, hd: readPref(HD_KEY) === '1' };
  var media = null;          // current <video> or PeerTube player wrapper
  var timer = null;
  var warm = null;           // { key, vid }: the next word's first clip, loading in the background

  function readPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function saveData() { var c = navigator.connection; return !!(c && (c.saveData || /2g/.test(c.effectiveType || ''))); }

  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function loadMeta() {
    return metaP || (metaP = getJSON(BASE + 'videos.json').then(function (j) { meta = j; return j; }).catch(function () { metaP = null; return null; }));
  }
  function keyOf(w) { return String(w || '').replace(/<[^>]*>/g, '').trim().toLowerCase(); }
  function shardOf(k) { return /^[a-z]/.test(k) ? k[0] : '_'; }
  function loadShard(k) {
    var s = shardOf(k);
    return shards[s] || (shards[s] = getJSON(BASE + 'index/' + s + '.json').catch(function () { delete shards[s]; return {}; }));
  }

  // ── UI ──
  var CSS = '' +
    '.vc{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#233240;background:#fff;border:1px solid #dfe2ec;border-radius:14px;' +
    'padding:12px;margin:12px auto;max-width:640px;text-align:left;box-shadow:0 2px 10px rgba(35,50,64,.08)}' +
    '.vc[hidden]{display:none}' +
    '.vc-top{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;color:#5b6675;margin-bottom:8px}' +
    '.vc-top a{color:#5b5fd6;text-decoration:none;white-space:nowrap}.vc-top a:hover{text-decoration:underline}' +
    '.vc-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
    '.vc-stage{position:relative;width:100%;aspect-ratio:16/9;background:#111;border-radius:10px;overflow:hidden}' +
    '.vc-stage video,.vc-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#111}' +
    '.vc-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ccd;font-size:14px;padding:16px;text-align:center}' +
    '.vc-cap{font-size:18px;line-height:1.45;margin:10px 2px 8px;color:#233240;min-height:2.9em}' +
    '.vc-cap mark{background:#ffe58a;color:inherit;border-radius:4px;padding:0 3px;font-weight:600}' +
    '.vc-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
    '.vc-bar button{font:inherit;font-size:14px;border:1px solid #d4d8e4;background:#f6f7fb;color:#233240;border-radius:999px;padding:6px 12px;cursor:pointer}' +
    '.vc-bar button:hover{background:#eceefa;border-color:#797ef6}' +
    '.vc-bar button:disabled{opacity:.4;cursor:default}' +
    '.vc-bar button[aria-pressed=true]{background:#797ef6;border-color:#797ef6;color:#fff}' +
    '.vc-count{margin-left:auto;font-size:13px;color:#5b6675;font-variant-numeric:tabular-nums}' +
    '.vc-yg{font-size:12px;color:#5b6675;margin-top:8px}.vc-yg button{font:inherit;color:#5b5fd6;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}';

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function mount(host) {
    if (ui) return ui;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    ['https://upload.wikimedia.org', 'https://archive.org'].forEach(function (h) {
      document.head.appendChild(el('link', { rel: 'preconnect', href: h, crossorigin: '' }));
    });
    ui = {};
    ui.title = el('span', { class: 'vc-title' });
    ui.src = el('a', { target: '_blank', rel: 'noopener', text: 'Source ↗' });
    ui.stage = el('div', { class: 'vc-stage' });
    ui.cap = el('div', { class: 'vc-cap', 'aria-live': 'polite' });
    ui.prev = el('button', { type: 'button', text: '◀ Prev', onclick: function (e) { e.stopPropagation(); go(S.i - 1); } });
    ui.replay = el('button', { type: 'button', text: '↻ Replay', onclick: function (e) { e.stopPropagation(); play(); } });
    ui.next = el('button', { type: 'button', text: 'Next ▶', onclick: function (e) { e.stopPropagation(); go(S.i + 1); } });
    ui.slow = el('button', { type: 'button', text: '0.75×', 'aria-pressed': 'false', title: 'Play slower', onclick: function (e) {
      e.stopPropagation(); S.rate = S.rate === 1 ? 0.75 : 1; ui.slow.setAttribute('aria-pressed', String(S.rate !== 1)); applyRate();
    } });
    ui.hd = el('button', { type: 'button', text: 'HD', 'aria-pressed': String(S.hd), title: 'Full quality (slower to load)', onclick: function (e) {
      e.stopPropagation(); S.hd = !S.hd; writePref(HD_KEY, S.hd ? '1' : '0'); ui.hd.setAttribute('aria-pressed', String(S.hd));
      if (!media) return;
      if (media.setHd) media.setHd(S.hd); else play(media.time && media.time()); // keep listening from the same spot
    } });
    ui.count = el('span', { class: 'vc-count' });
    ui.yg = el('div', { class: 'vc-yg' });
    ui.box = el('div', { class: 'vc', hidden: '' }, [
      el('div', { class: 'vc-top' }, [ui.title, ui.src]),
      ui.stage, ui.cap,
      el('div', { class: 'vc-bar' }, [ui.prev, ui.replay, ui.next, ui.slow, ui.hd, ui.count]),
      ui.yg
    ]);
    // clicks inside the player must not flip the flash card
    ui.box.addEventListener('click', function (e) { e.stopPropagation(); });
    host.appendChild(ui.box);
    return ui;
  }

  function setFallback(fn, label) {
    ui.yg.innerHTML = '';
    if (!fn) return;
    ui.yg.appendChild(document.createTextNode('More examples: '));
    ui.yg.appendChild(el('button', { type: 'button', text: label || 'search YouTube (YouGlish)', onclick: function (e) { e.stopPropagation(); stop(); fn(); } }));
  }

  // ── playback ──
  function clearMedia() {
    clearInterval(timer); timer = null;
    if (media && media.destroy) media.destroy();
    media = null;
    ui.stage.innerHTML = '';
  }

  function msg(t) { ui.stage.appendChild(el('div', { class: 'vc-msg', text: t })); }

  function renderInfo(c, v) {
    var t = c[3], a = c[4], b = c[5];
    ui.cap.innerHTML = '';
    ui.cap.appendChild(document.createTextNode(t.slice(0, a)));
    ui.cap.appendChild(el('mark', { text: t.slice(a, b) }));
    ui.cap.appendChild(document.createTextNode(t.slice(b)));
    ui.title.textContent = v.t + ' · ' + (SOURCE_NAME[v.s] || v.s);
    ui.title.title = v.t;
    ui.src.href = v.p;
    ui.count.textContent = (S.i + 1) + ' / ' + S.clips.length;
    ui.prev.disabled = S.i === 0;
    ui.next.disabled = S.i >= S.clips.length - 1;
  }

  function go(i) {
    if (i < 0 || i >= S.clips.length) return;
    S.dir = i < S.i ? -1 : 1;
    S.i = i; play();
  }

  // the phrase plays once and the video keeps going; when the video itself ends, move to the next clip
  function videoEnded() {
    if (S.i < S.clips.length - 1) { var tok = S.token; setTimeout(function () { if (tok === S.token) go(S.i + 1); }, 700); }
  }

  function applyRate() { if (media && media.rate) media.rate(S.rate); }

  // at: optional time to start from instead of the phrase (used when switching quality)
  function play(at) {
    var c = S.clips[S.i]; if (!c) return;
    var v = meta.videos[c[0]];
    var tok = ++S.token;
    clearMedia();
    renderInfo(c, v);
    var start = at != null ? at : c[1];
    if (v.u) playHtml5(v, start, tok); else if (v.e) playPeertube(v, start, tok);
  }

  // candidate files, lightest first; the browser plays the first one it supports
  function sourcesOf(v) {
    var full = function (x) {
      if (!x || /^https?:/.test(x)) return x;
      return v.u.replace('/wikipedia/commons/', '/wikipedia/commons/transcoded/') + '/' + v.u.split('/').pop() + '.' + x;
    };
    return (S.hd ? [] : [full(v.l), full(v.m)]).concat(v.u).filter(Boolean);
  }
  function typeOf(url) { return /\.webm$/i.test(url) ? 'video/webm' : /\.mov$/i.test(url) ? 'video/quicktime' : /\.mp4$/i.test(url) ? 'video/mp4' : ''; }
  function warmKey(v, start) { return v.u + '#' + start + (S.hd ? '#hd' : ''); }

  function makeVideo(v, start) {
    var vid = el('video', { controls: '', playsinline: '', preload: 'auto' });
    sourcesOf(v).forEach(function (u) {
      var a = { src: u + '#t=' + start }, t = typeOf(u);
      if (t) a.type = t;
      vid.appendChild(el('source', a));
    });
    return vid;
  }

  function playHtml5(v, start, tok) {
    var vid;
    if (warm && warm.key === warmKey(v, start)) { vid = warm.vid; warm = null; vid.preload = 'auto'; }
    else vid = makeVideo(v, start);
    ui.stage.appendChild(vid);
    media = {
      rate: function (r) { vid.playbackRate = r; },
      time: function () { return vid.currentTime; },
      destroy: function () { vid.pause(); vid.innerHTML = ''; vid.load(); }
    };
    function begin() {
      if (tok !== S.token) return;
      if (Math.abs(vid.currentTime - start) > 0.3) vid.currentTime = start;
      vid.playbackRate = S.rate;
      vid.play().catch(function () { /* autoplay blocked: user presses play */ });
    }
    if (vid.readyState >= 1) begin(); else vid.addEventListener('loadedmetadata', begin);
    vid.addEventListener('ended', function () { if (tok === S.token) videoEnded(); });
    function failed() {
      if (tok !== S.token) return;
      clearMedia(); msg('This video could not be loaded — skipping…');
      // skip broken videos in the direction the learner was moving
      setTimeout(function () { if (tok === S.token) go(S.i + (S.dir || 1)); }, 1200);
    }
    vid.addEventListener('error', failed);
    // with <source> children, "no playable file" is reported on the last one
    if (vid.lastChild) vid.lastChild.addEventListener('error', failed);
    if (vid.networkState === 3) failed(); // warmed element that already gave up (NETWORK_NO_SOURCE)
  }

  // start loading the first clip of a word before the card is flipped
  function warmUp(c) {
    var v = meta && meta.videos[c[0]];
    if (!v || !v.u || saveData()) return;
    var key = warmKey(v, c[1]);
    if (warm && warm.key === key) return;
    if (warm) { warm.vid.innerHTML = ''; warm.vid.load(); }
    var vid = makeVideo(v, c[1]);
    vid.preload = 'metadata';
    warm = { key: key, vid: vid };
    vid.load();
  }

  var ptLib = null;
  function loadPeertubeApi() {
    return ptLib || (ptLib = new Promise(function (res, rej) {
      if (window.PeerTubePlayer) return res();
      var s = document.createElement('script'); s.src = PT_API; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    }));
  }

  function playPeertube(v, start, tok) {
    var q = 'api=1&autoplay=1&title=0&warningTitle=0&peertubeLink=0&p2p=0&start=' + Math.floor(start);
    var ifr = el('iframe', { allow: 'autoplay; fullscreen', allowfullscreen: '', src: v.e + (v.e.indexOf('?') < 0 ? '?' : '&') + q });
    ui.stage.appendChild(ifr);
    // basic fallback: without the JS API the embed still plays from start
    media = {
      rate: null,
      destroy: function () { ifr.src = 'about:blank'; }
    };
    loadPeertubeApi().then(function () {
      if (tok !== S.token) return;
      var Ctor = window.PeerTubePlayer && (window.PeerTubePlayer.PeerTubePlayer || window.PeerTubePlayer);
      var p = new Ctor(ifr);
      return p.ready.then(function () {
        if (tok !== S.token) return;
        media = {
          rate: function (r) { p.setPlaybackRate(r); },
          setHd: function (hd) { pickResolution(p, hd); },
          destroy: function () { ifr.src = 'about:blank'; }
        };
        p.setPlaybackRate(S.rate);
        pickResolution(p, S.hd);
        var ended = false, picked = false;
        p.addEventListener('playbackStatusUpdate', function (st) {
          if (tok !== S.token) return;
          // some players only list their resolutions once playback starts
          if (!picked && st.playbackState === 'playing') { picked = true; pickResolution(p, S.hd); }
          if (ended || st.playbackState !== 'ended') return;
          ended = true; videoEnded();
        });
      });
    }).catch(function () { /* embed API unavailable — basic embed keeps working */ });
  }

  // HD → the player's automatic choice; otherwise the smallest picture of at least 240p
  function pickResolution(p, hd) {
    Promise.resolve(p.getResolutions()).then(function (rs) {
      var list = (rs || []).filter(function (r) { return r.height > 0; }).sort(function (a, b) { return a.height - b.height; });
      if (!list.length) return;
      if (hd) return p.setResolution(-1);
      var low = list.filter(function (r) { return r.height >= 240; })[0] || list[0];
      if (!low.active) return p.setResolution(low.id);
    }).catch(function () { /* resolution switching not supported by this server */ });
  }

  // ── public API ──
  function prefetch(word) {
    var k = keyOf(word); if (!k) { loadMeta(); return; }
    Promise.all([loadMeta(), loadShard(k)]).then(function (r) {
      var clips = r[0] && r[1][k];
      if (clips && clips.length) warmUp(clips[0]);
    });
  }

  function step(d) {
    if (!ui || ui.box.hidden || !S.clips.length) return false;
    go(S.i + d);
    return true;
  }

  function show(word, lang, opts) {
    opts = opts || {};
    if (!ui) throw new Error('VocabClips.mount() first');
    var k = keyOf(word);
    S.word = k;
    return Promise.all([loadMeta(), loadShard(k)]).then(function (r) {
      var m = r[0], idx = r[1];
      if (S.word !== k) return false;                          // card changed meanwhile
      if (!m || (lang && m.language && lang !== m.language)) { stop(); return false; }
      var clips = idx[k];
      if (!clips || !clips.length) { stop(); return false; }
      S.clips = clips; S.i = 0; S.dir = 1;
      setFallback(opts.fallback, opts.fallbackLabel);
      ui.box.hidden = false;
      play();
      return true;
    });
  }

  function stop() {
    S.token++; S.word = '';
    if (!ui) return;
    clearMedia();
    ui.box.hidden = true;
  }

  function has(word) {
    var k = keyOf(word);
    return loadShard(k).then(function (idx) { return !!(idx[k] && idx[k].length); });
  }

  window.VocabClips = { mount: mount, show: show, stop: stop, prefetch: prefetch, has: has, step: step };
})();
