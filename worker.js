// Cloudflare Worker — GitHub lib.txt proxy

const OWNER  = 'nhung168';
const REPO   = 'vocabulary-builder';
const BRANCH = 'gh-pages'; // ← most common fix — check your repo's branch name
const PATH   = 'lib.txt';

const ALLOWED_ORIGINS = [
  'https://nhung168.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'null'
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function ghGet(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/vnd.github+json',
      'User-Agent':  'vocab-worker'
    }
  });

  // File doesn't exist yet — that's fine, start empty
  if (r.status === 404) return { lines: [], sha: null };

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub GET ${r.status}: ${body}`);
  }

  const j = await r.json();
  const content = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))));
  return { lines: content.split('\n').filter(Boolean), sha: j.sha };
}

async function ghPut(token, lines, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  const body = {
    message: 'vocab: add entry',
    content: btoa(unescape(encodeURIComponent(lines.join('\n') + '\n'))),
    branch:  BRANCH,
    ...(sha ? { sha } : {})
  };
  const r = await fetch(url, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent':   'vocab-worker'
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub PUT ${r.status}: ${body}`);
  }
}

export default {
  async fetch(request, env) {
    const origin   = request.headers.get('Origin') || '';
    const cors     = corsHeaders(origin);
    const pathname = '/' + new URL(request.url).pathname.replace(/^\/+/, '');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── GET /env — raw env dump for debugging ──
    if (request.method === 'GET' && pathname === '/env') {
      const keys = Object.keys(env);
      return Response.json({
        keys,
        GITHUB_TOKEN_exists: 'GITHUB_TOKEN' in env,
        GITHUB_TOKEN_type: typeof env.GITHUB_TOKEN,
        GITHUB_TOKEN_preview: env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN).slice(0,12)+'...' : 'undefined'
      }, { headers: cors });
    }

    // ── GET /ping — health check, verify token + repo access ──
    if (request.method === 'GET' && pathname === '/ping') {
      try {
        const token = env.GITHUB_TOKEN;
        if (!token) return Response.json({ ok: false, error: 'GITHUB_TOKEN secret not set' }, { headers: cors });

        const url = `https://api.github.com/repos/${OWNER}/${REPO}`;
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vocab-worker' }
        });
        const j = await r.json();
        if (!r.ok) return Response.json({ ok: false, error: `Repo access failed ${r.status}: ${j.message}` }, { headers: cors });

        // Also check branch exists
        const rb = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vocab-worker' }
        });
        const jb = await rb.json();
        if (!rb.ok) return Response.json({ ok: false, error: `Branch '${BRANCH}' not found: ${jb.message}` }, { headers: cors });

        return Response.json({ ok: true, repo: j.full_name, branch: BRANCH, private: j.private }, { headers: cors });
      } catch(e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    // ── GET /lib ──
    if (request.method === 'GET' && pathname === '/lib') {
      try {
        const { lines } = await ghGet(env.GITHUB_TOKEN);
        return Response.json({ ok: true, entries: lines }, { headers: cors });
      } catch(e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    // ── POST /save ──
    if (request.method === 'POST' && pathname === '/save') {
      try {
        if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN secret is not configured in Worker');

        const { word, definition, language } = await request.json();
        if (!word?.trim()) return Response.json({ ok: false, error: 'word is required' }, { status: 400, headers: cors });

        const entry = [
          (word       || '').trim().replace(/\t/g, ' '),
          (definition || '').trim().replace(/\t/g, ' '),
          (language   || 'English').trim()
        ].join('\t');

        const { lines, sha } = await ghGet(env.GITHUB_TOKEN);

        const exists = lines.some(l => {
          const c = l.split('\t');
          return c[0]?.trim() === word.trim() && c[2]?.trim() === (language || '').trim();
        });
        if (exists) return Response.json({ ok: true, skipped: true }, { headers: cors });

        lines.push(entry);
        await ghPut(env.GITHUB_TOKEN, lines, sha);
        return Response.json({ ok: true, skipped: false }, { headers: cors });

      } catch(e) {
        // Return full error detail so the browser can show it
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    return Response.json({ ok: false, error: `No route for ${request.method} ${pathname}` }, { status: 404, headers: cors });
  }
};
