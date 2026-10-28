/* VocabClips — a small YouGlish-style player for clips from free video sources.
 *
 *   VocabClips.mount(element, opts)    create the player inside element; opts.reel = full-screen phone layout,
 *                                      opts.data = the language's folder under clips/ (e.g. 'zh/'; English: none)
 *   VocabClips.prefetch(word)          load the index shard early (call when a word is shown)
 *   await VocabClips.show(word, lang)  play clips for word → true, or false when there are none
 *   VocabClips.stop()                  stop playback and hide the player
 *   VocabClips.step(±1)                next / previous clip → false when the player isn't showing
 *
 * Videos you archived from index-ai.html play from YouTube (y) or their own file (u).
 * Videos play from a low-resolution copy (u/l/m in videos.json, see tools/clips/light.mjs) unless HD is on.
 *
 * Data: clips/<data>videos.json + clips/<data>index/<first letter>.json, built by tools/clips/build.mjs.
 */
(function () {
  'use strict';
  var BASE = (document.currentScript && document.currentScript.src || '').replace(/[^/]*$/, '');
  var DATA = BASE;           // + the language folder, set by mount()
  var PT_API = 'https://unpkg.com/@peertube/embed-api@0.2.0/build/player.min.js';
  var YT_API = 'https://www.youtube.com/iframe_api';
  // each clip is a 3-minute window: from 1 minute before the word to 2 minutes after it
  var BEFORE = 60, AFTER = 120;
  var SOURCE_NAME = { commons: 'Wikimedia Commons', archive: 'Internet Archive', peertube: 'PeerTube', youtube: 'YouTube · saved by you', link: 'saved by you' };

  var meta = null, metaP = null, shards = {}, ui = null;
  var HD_KEY = 'vc_hd';
  var S = { word: '', clips: [], i: 0, token: 0, rate: 1, dir: 1, hd: readPref(HD_KEY) === '1' };
  var REEL = false;          // full-screen phone layout: no native controls, tap = pause, swipes handled by the page
  var media = null;          // current <video> or PeerTube player wrapper
  var cur = null;            // { tok, begin, failed } for the clip in the shared <video>
  var warm = null;           // { key, vid }: the next word's first clip, loading in the background
  var mutedByUs = false;     // the browser refused sound, so the clip plays muted until the next tap
  var win = { from: 0, to: Infinity }; // the current clip's window, in seconds of the video

  function readPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function saveData() { var c = navigator.connection; return !!(c && (c.saveData || /2g/.test(c.effectiveType || ''))); }

  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function loadMeta() {
    return metaP || (metaP = getJSON(DATA + 'videos.json').then(function (j) { meta = j; return j; }).catch(function () { metaP = null; return null; }));
  }
  function keyOf(w) { return String(w || '').replace(/<[^>]*>/g, '').trim().toLowerCase(); }
  function shardOf(k) { return /^[a-z]/.test(k) ? k[0] : '_'; }
  function loadShard(k) {
    var s = shardOf(k);
    return shards[s] || (shards[s] = getJSON(DATA + 'index/' + s + '.json').catch(function () { delete shards[s]; return {}; }));
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
    '.vc-yg{font-size:12px;color:#5b6675;margin-top:8px}.vc-yg button{font:inherit;color:#5b5fd6;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}' +
    '.vc-shield{position:absolute;inset:0;z-index:1}' +
    '.vc-unmute{position:absolute;left:10px;top:10px;z-index:2;border:0;border-radius:999px;padding:7px 12px;background:rgba(0,0,0,.65);color:#fff;font:600 14px system-ui,sans-serif}' +
    '.vc-unmute[hidden]{display:none}' +
    '.vc-stage.paused::after{content:"\\25B6";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:56px;color:rgba(255,255,255,.85);pointer-events:none;z-index:2}' +
    '.vc-prog{position:relative;height:3px;margin:0;background:rgba(255,255,255,.22);background-clip:content-box;padding:10px 0;cursor:pointer}' +
    '.vc-prog i{display:block;height:3px;width:0;background:#fff}';

  // full-screen phone layout (TikTok / Reels style); the page puts the word and definition at the bottom
  var REEL_CSS = '' +
    '.vc.reel{position:absolute;inset:0;margin:0;max-width:none;border:0;border-radius:0;box-shadow:none;background:#000;color:#fff;' +
    'padding:calc(52px + env(safe-area-inset-top)) 0 calc(150px + env(safe-area-inset-bottom));display:flex;flex-direction:column;justify-content:center;overflow:hidden}' +
    '.vc.reel[hidden]{display:none}' +
    '.reel .vc-top{padding:0 12px;margin-bottom:6px;color:#9aa3b2;font-size:12px}.reel .vc-top a{color:#c9cbff}' +
    '.vc.reel>*{flex-shrink:0}' +
    '.reel .vc-stage{border-radius:0;background:#000;flex:0 1 auto;min-height:120px;max-height:58vh}' + // only the video gives way
    '.reel .vc-stage video{background:#000}' +
    '.reel .vc-cap{color:#fff;font-size:19px;padding:0 76px 0 16px;margin:4px 0 0;min-height:0;text-shadow:0 1px 3px #000}' +
    '.reel .vc-cap mark{background:#ffe58a;color:#111}' +
    '.reel .vc-bar{position:absolute;right:10px;bottom:calc(20px + env(safe-area-inset-bottom));flex-direction:column;flex-wrap:nowrap;gap:12px;z-index:3}' +
    '.reel .vc-bar button{width:50px;height:50px;padding:0;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:15px;font-weight:600}' +
    '.reel .vc-bar button[aria-pressed=true]{background:#797ef6}' +
    '.reel .vc-prev,.reel .vc-next{display:none}' +
    '.reel .vc-count{margin:0;color:#ddd;font-size:12px;text-align:center}' +
    '.reel .vc-yg{padding:0 76px 0 16px;color:#9aa3b2}.reel .vc-yg button{color:#c9cbff}';

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function mount(host, opts) {
    if (ui) return ui;
    REEL = !!(opts && opts.reel);
    DATA = BASE + ((opts && opts.data) || '');
    var st = document.createElement('style'); st.textContent = CSS + (REEL ? REEL_CSS : ''); document.head.appendChild(st);
    ['https://upload.wikimedia.org', 'https://archive.org'].forEach(function (h) {
      document.head.appendChild(el('link', { rel: 'preconnect', href: h, crossorigin: '' }));
    });
    ui = {};
    ui.title = el('span', { class: 'vc-title' });
    ui.src = el('a', { target: '_blank', rel: 'noopener', text: 'Source ↗' });
    ui.stage = el('div', { class: 'vc-stage' });
    ui.cap = el('div', { class: 'vc-cap', 'aria-live': 'polite' });
    ui.prev = el('button', { type: 'button', class: 'vc-prev', text: '◀ Prev', onclick: function (e) { e.stopPropagation(); go(S.i - 1); } });
    ui.replay = el('button', { type: 'button', text: REEL ? '↻' : '↻ To the word', title: 'Jump to the word', 'aria-label': 'Jump to the word', onclick: function (e) { e.stopPropagation(); var c = S.clips[S.i]; if (c) play(c[1]); } });
    ui.next = el('button', { type: 'button', class: 'vc-next', text: 'Next ▶', onclick: function (e) { e.stopPropagation(); go(S.i + 1); } });
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
    ui.unmute = el('button', { type: 'button', class: 'vc-unmute', text: '🔇 Tap for sound', hidden: '', onclick: function (e) { e.stopPropagation(); unmute(); } });
    var kids = [el('div', { class: 'vc-top' }, [ui.title, ui.src]), ui.stage];
    if (REEL) {
      ui.prog = el('div', { class: 'vc-prog', onclick: function (e) {
        e.stopPropagation();
        var r = ui.prog.getBoundingClientRect();
        if (media && media.seekTo) media.seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      } }, [el('i')]);
      kids.push(ui.prog);
    }
    kids.push(ui.cap, el('div', { class: 'vc-bar' }, [ui.prev, ui.replay, ui.next, ui.slow, ui.hd, ui.count]), ui.yg);
    ui.box = el('div', { class: 'vc' + (REEL ? ' reel' : ''), hidden: '' }, kids);
    // clicks inside the player must not flip the flash card
    ui.box.addEventListener('click', function (e) { e.stopPropagation(); });
    host.appendChild(ui.box);
    ui.vid = makeSharedVideo();
    // iPhones only let a video play with sound after a tap on the page; use every tap to allow it
    document.addEventListener('touchend', allowSound, true);
    document.addEventListener('click', allowSound, true);
    return ui;
  }

  function setFallback(fn, label) {
    ui.yg.innerHTML = '';
    if (!fn) return;
    ui.yg.appendChild(document.createTextNode('More examples: '));
    ui.yg.appendChild(el('button', { type: 'button', text: label || 'search YouTube (YouGlish)', onclick: function (e) { e.stopPropagation(); stop(); fn(); } }));
  }

  // ── sound / pause ──
  var userPaused = false;    // paused by a tap on the video: other taps must not restart it
  function allowSound(e) {
    var vid = ui.vid;
    if (e && ui.box.contains(e.target)) return; // the player's own buttons and tap-to-pause handle these
    if (mutedByUs) { unmute(); return; }
    // play() during a tap marks this element as allowed; with no clip loaded it just fails quietly
    if (vid.paused && !cur) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); vid.pause(); }
    else if (vid.paused && !userPaused) startVideo(vid); // a clip the browser refused to start
  }
  function unmute() {
    mutedByUs = false; ui.unmute.hidden = true;
    if (media && media.unmute) { media.unmute(); return; }
    ui.vid.muted = false;
    if (ui.vid.paused && cur) startVideo(ui.vid);
  }
  function startVideo(vid) {
    var p = vid.play();
    if (p && p.catch) p.catch(function (e) {
      // no sound allowed yet: play muted and offer a button, like Instagram / TikTok do
      if (e && e.name === 'NotAllowedError' && !vid.muted) {
        vid.muted = true; mutedByUs = true; ui.unmute.hidden = false;
        vid.play().catch(function () {});
      }
    });
  }
  function togglePause() {
    if (mutedByUs) { unmute(); return; }
    if (media && media.toggle) userPaused = media.toggle();
  }
  function setPaused(p) { ui.stage.classList.toggle('paused', !!p && REEL); }
  function setProgress(pos, dur) { if (ui.prog) ui.prog.firstChild.style.width = dur ? Math.min(100, pos / dur * 100) + '%' : '0'; }
  // progress bar and seeking cover the clip's window (or less, when the video ends sooner)
  function winEnd(dur) { return dur ? Math.min(win.to, dur) : win.to; }
  function showProgress(t, dur) { setProgress(Math.max(0, t - win.from), winEnd(dur) - win.from); }
  function winAt(f, dur) { return win.from + f * (winEnd(dur) - win.from); }

  // ── playback ──
  function clearMedia() {
    if (media && media.destroy) media.destroy();
    media = null; cur = null; userPaused = false;
    ui.stage.innerHTML = '';
    ui.stage.style.aspectRatio = '';
    setPaused(false); setProgress(0, 0);
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

  // the window (or the video) has ended: move to the next clip
  function videoEnded() {
    if (S.i < S.clips.length - 1) { var tok = S.token; setTimeout(function () { if (tok === S.token) go(S.i + 1); }, 700); }
  }

  function applyRate() { if (media && media.rate) media.rate(S.rate); }

  // at: optional time to start from instead of the window's start (jump to the word, switch quality)
  function play(at) {
    var c = S.clips[S.i]; if (!c) return;
    var v = meta.videos[c[0]];
    var tok = ++S.token;
    clearMedia();
    renderInfo(c, v);
    win = { from: Math.max(0, c[1] - BEFORE), to: c[1] + AFTER };
    var start = at != null ? at : win.from;
    if (v.y) playYoutube(v, start, tok); else if (v.u) playHtml5(v, start, tok); else if (v.e) playPeertube(v, start, tok);
  }

  // candidate files, lightest first (HD: original first); the browser plays the first one it can decode,
  // and m is the copy every phone can play
  function sourcesOf(v) {
    var full = function (x) {
      if (!x || /^https?:/.test(x)) return x;
      return v.u.replace('/wikipedia/commons/', '/wikipedia/commons/transcoded/') + '/' + v.u.split('/').pop() + '.' + x;
    };
    var list = S.hd ? [v.u, full(v.m)] : [full(v.l), full(v.m), v.u];
    return list.filter(function (x, i) { return x && list.indexOf(x) === i; });
  }
  function typeOf(url) { return /\.webm$/i.test(url) ? 'video/webm' : /\.mov$/i.test(url) ? 'video/quicktime' : /\.mp4$/i.test(url) ? 'video/mp4' : ''; }

  function setSources(vid, v, start) {
    vid.innerHTML = '';
    sourcesOf(v).forEach(function (u) {
      var a = { src: u + '#t=' + start }, t = typeOf(u);
      if (t) a.type = t;
      vid.appendChild(el('source', a));
    });
  }

  // one <video> for every clip: once a tap has allowed it to play with sound, it stays allowed
  function makeSharedVideo() {
    var vid = el('video', { playsinline: '', 'webkit-playsinline': '', preload: 'auto' });
    if (!REEL) vid.controls = true;
    vid.addEventListener('loadedmetadata', function () {
      // reel: give vertical videos (common on Bilibili) the height they need
      if (REEL && vid.videoWidth) ui.stage.style.aspectRatio = vid.videoWidth + '/' + vid.videoHeight;
      if (cur) cur.begin();
    });
    vid.addEventListener('ended', function () { if (cur) videoEnded(); });
    vid.addEventListener('error', function () { if (cur) cur.failed(); });
    vid.addEventListener('play', function () { setPaused(false); });
    vid.addEventListener('pause', function () { if (cur) setPaused(true); });
    vid.addEventListener('timeupdate', function () {
      if (!cur) return;
      var t = vid.currentTime;
      showProgress(t, vid.duration);
      // playback reached the end of the window (a seek past it on the desktop controls doesn't count)
      if (cur.last < win.to && t >= win.to && t - cur.last < 2) { vid.pause(); videoEnded(); }
      cur.last = t;
    });
    return vid;
  }

  function playHtml5(v, start, tok) {
    var vid = ui.vid;
    setSources(vid, v, start);
    ui.stage.appendChild(vid);
    if (REEL) ui.stage.appendChild(el('div', { class: 'vc-shield', onclick: function (e) { e.stopPropagation(); togglePause(); } }));
    ui.stage.appendChild(ui.unmute);
    cur = {
      last: start,
      begin: function () {
        if (tok !== S.token) return;
        if (Math.abs(vid.currentTime - start) > 0.3) vid.currentTime = start;
        vid.playbackRate = S.rate;
        startVideo(vid);
      },
      failed: function () {
        if (tok !== S.token) return;
        clearMedia(); msg('This video could not be loaded — skipping…');
        // skip broken videos in the direction the learner was moving
        setTimeout(function () { if (tok === S.token) go(S.i + (S.dir || 1)); }, 1200);
      }
    };
    media = {
      rate: function (r) { vid.playbackRate = r; },
      time: function () { return vid.currentTime; },
      toggle: function () { if (vid.paused) { startVideo(vid); return false; } vid.pause(); return true; }, // → paused?
      seekTo: function (f) { if (vid.duration) vid.currentTime = winAt(f, vid.duration); },
      destroy: function () { vid.pause(); vid.innerHTML = ''; vid.removeAttribute('src'); vid.load(); }
    };
    // with <source> children, "no playable file" is reported on the last one
    if (vid.lastChild) vid.lastChild.addEventListener('error', function () { if (cur) cur.failed(); });
    vid.load();
  }

  // warm the connection and HTTP cache for the next word's first clip before it is needed
  function warmUp(c) {
    var v = meta && meta.videos[c[0]];
    if (!v || !v.u || saveData()) return;
    var from = Math.max(0, c[1] - BEFORE);
    var key = v.u + '#' + from + (S.hd ? '#hd' : '');
    if (warm && warm.key === key) return;
    if (warm) { warm.vid.innerHTML = ''; warm.vid.load(); }
    var vid = el('video', { preload: 'metadata', muted: '' });
    setSources(vid, v, from);
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
    var q = 'api=1&autoplay=1&title=0&warningTitle=0&peertubeLink=0&p2p=0&start=' + Math.floor(start) + '&stop=' + Math.ceil(win.to);
    var ifr = el('iframe', { allow: 'autoplay; fullscreen', allowfullscreen: '', src: v.e + (v.e.indexOf('?') < 0 ? '?' : '&') + q });
    ui.stage.appendChild(ifr);
    // in the reel, touches over the embed must reach the page so swipes still work
    if (REEL) ui.stage.appendChild(el('div', { class: 'vc-shield', onclick: function (e) { e.stopPropagation(); togglePause(); } }));
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
        var state = '', dur = 0;
        media = {
          rate: function (r) { p.setPlaybackRate(r); },
          setHd: function (hd) { pickResolution(p, hd); },
          toggle: function () { if (state === 'playing') { p.pause(); return true; } p.play(); return false; },
          seekTo: function (f) { if (dur) p.seek(winAt(f, dur)); },
          destroy: function () { ifr.src = 'about:blank'; }
        };
        p.setPlaybackRate(S.rate);
        pickResolution(p, S.hd);
        var ended = false, picked = false;
        p.addEventListener('playbackStatusUpdate', function (st) {
          if (tok !== S.token) return;
          state = st.playbackState; dur = st.duration || dur;
          setPaused(state === 'paused'); showProgress(st.position, dur);
          // some players only list their resolutions once playback starts
          if (!picked && state === 'playing') { picked = true; pickResolution(p, S.hd); }
          // the embed stops itself at the window's end (stop=…): it pauses there or reports "ended"
          var atEnd = state === 'ended' || (state !== 'unstarted' && st.position >= win.to - 0.5);
          if (ended || !atEnd) return;
          ended = true; p.pause(); videoEnded();
        });
      });
    }).catch(function () { /* embed API unavailable — basic embed keeps working */ });
  }

  var ytLib = null;
  function loadYoutubeApi() {
    return ytLib || (ytLib = new Promise(function (res, rej) {
      if (window.YT && window.YT.Player) return res();
      var prev = window.onYouTubeIframeAPIReady; // YouGlish's widget loads the same API
      window.onYouTubeIframeAPIReady = function () { if (prev) prev(); res(); };
      var s = document.createElement('script'); s.src = YT_API; s.onerror = function () { ytLib = null; rej(); }; document.head.appendChild(s);
    }));
  }

  // videos archived from index-ai.html: YouTube's embedded player, driven through its API
  function playYoutube(v, start, tok) {
    var box = el('div');
    ui.stage.appendChild(box);
    if (REEL) ui.stage.appendChild(el('div', { class: 'vc-shield', onclick: function (e) { e.stopPropagation(); togglePause(); } }));
    ui.stage.appendChild(ui.unmute);
    var p = null, poll = null, state = -1;
    media = { rate: null, destroy: function () { clearInterval(poll); try { p && p.destroy(); } catch (e) {} } };
    function failed() {
      if (tok !== S.token) return;
      clearMedia(); msg('This video could not be loaded — skipping…');
      setTimeout(function () { if (tok === S.token) go(S.i + (S.dir || 1)); }, 1200);
    }
    loadYoutubeApi().then(function () {
      if (tok !== S.token) return;
      p = new YT.Player(box, {
        host: 'https://www.youtube-nocookie.com', videoId: v.y,
        playerVars: { start: Math.floor(start), end: Math.ceil(win.to), autoplay: 1, playsinline: 1, rel: 0, controls: REEL ? 0 : 1, iv_load_policy: 3 },
        events: {
          onReady: function () {
            if (tok !== S.token) return;
            p.setPlaybackRate(S.rate);
            p.playVideo();
            media = {
              rate: function (r) { p.setPlaybackRate(r); },
              time: function () { return p.getCurrentTime(); },
              toggle: function () { if (state === 1) { p.pauseVideo(); return true; } p.playVideo(); return false; },
              seekTo: function (f) { var d = p.getDuration(); if (d) p.seekTo(winAt(f, d), true); },
              unmute: function () { p.unMute(); p.playVideo(); },
              setHd: function () {}, // YouTube picks the quality itself
              destroy: media.destroy
            };
            poll = setInterval(function () { if (state === 1) showProgress(p.getCurrentTime(), p.getDuration()); }, 500);
            // no sound allowed yet (iPhone): play muted and offer the sound button
            setTimeout(function () {
              if (tok !== S.token || state === 1 || userPaused) return;
              p.mute(); p.playVideo(); mutedByUs = true; ui.unmute.hidden = false;
            }, 1500);
          },
          onStateChange: function (e) {
            if (tok !== S.token) return;
            state = e.data;
            if (state === 1) setPaused(false);
            else if (state === 2) setPaused(true);
            else if (state === 0) videoEnded(); // the player stops at end=… (the window's end)
          },
          onError: failed
        }
      });
    }).catch(failed);
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
