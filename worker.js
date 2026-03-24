const OWNER  = 'nhung168';
const REPO   = 'vocabulary-builder';
const BRANCH = 'gh-pages';
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
  if (r.status === 404) return { lines: [], sha: null };
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub GET ${r.status}: ${body}`);
  }
  const j = await r.json();
  // Decode base64 — GitHub wraps content in base64 with newlines
  const raw = atob(j.content.replace(/\n/g, ''));
  // Decode UTF-8 bytes correctly
  const content = new TextDecoder('utf-8').decode(
    Uint8Array.from(raw, c => c.charCodeAt(0))
  );
  return { lines: content.split('\n').filter(l => l.trim() !== ''), sha: j.sha };
}

async function ghPut(token, lines, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  // Encode content to base64 properly for UTF-8
  const content = lines.join('\n') + '\n';
  const bytes = new TextEncoder().encode(content);
  const b64 = btoa(String.fromCharCode(...bytes));

  const body = {
    message: 'vocab: add entry',
    content: b64,
    branch:  BRANCH,
    ...(sha ? { sha } : {})
  };
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent':   'vocab-worker'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`GitHub PUT ${r.status}: ${errBody}`);
  }
}

function buildLines(existing, newEntry) {
  // Separate header from data rows
  const HEADER = 'word\tdefinition\tlanguage';
  const isHeader = l => l.toLowerCase().replace(/\s/g, '').startsWith('word');

  let header = null;
  let dataRows = [];

  if (existing.length > 0 && isHeader(existing[0])) {
    header   = existing[0];          // keep existing header as-is
    dataRows = existing.slice(1);    // everything after header
  } else {
    header   = HEADER;               // create header
    dataRows = [...existing];        // all existing lines are data
  }

  // Insert new entry at the TOP of data rows (= row 2 in file)
  dataRows.unshift(newEntry);

  return [header, ...dataRows];
}

export default {
  async fetch(request, env) {
    const origin   = request.headers.get('Origin') || '';
    const cors     = corsHeaders(origin);
    const pathname = '/' + new URL(request.url).pathname.replace(/^\/+/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /ping
    if (request.method === 'GET' && pathname === '/ping') {
      const token = env.GITHUB_TOKEN;
      if (!token) return Response.json({ ok: false, error: 'GITHUB_TOKEN not set', envKeys: Object.keys(env) }, { headers: cors });
      try {
        const r  = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vocab-worker' }
        });
        const j  = await r.json();
        if (!r.ok) return Response.json({ ok: false, error: `Repo ${r.status}: ${j.message}` }, { headers: cors });
        const rb = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vocab-worker' }
        });
        const jb = await rb.json();
        if (!rb.ok) return Response.json({ ok: false, error: `Branch '${BRANCH}' not found: ${jb.message}` }, { headers: cors });
        return Response.json({ ok: true, repo: j.full_name, branch: BRANCH }, { headers: cors });
      } catch(e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    // GET /lib
    if (request.method === 'GET' && pathname === '/lib') {
      try {
        const { lines } = await ghGet(env.GITHUB_TOKEN);
        return Response.json({ ok: true, entries: lines, count: lines.length }, { headers: cors });
      } catch(e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    // POST /save
    if (request.method === 'POST' && pathname === '/save') {
      try {
        if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not configured');

        const body = await request.json();
        const word       = (body.word       || '').trim();
        const definition = (body.definition || '').trim();
        const language   = (body.language   || 'English').trim();

        if (!word) return Response.json({ ok: false, error: 'word is required' }, { status: 400, headers: cors });

        // Tab-separated entry, strip internal tabs
        const entry = [
          word.replace(/\t/g, ' '),
          definition.replace(/\t/g, ' '),
          language.replace(/\t/g, ' ')
        ].join('\t');

        const { lines, sha } = await ghGet(env.GITHUB_TOKEN);

        // Deduplicate by word + language (case-insensitive)
        const duplicate = lines.some(l => {
          const cols = l.split('\t');
          return cols[0]?.trim().toLowerCase() === word.toLowerCase()
              && cols[2]?.trim().toLowerCase() === language.toLowerCase();
        });
        if (duplicate) return Response.json({ ok: true, skipped: true }, { headers: cors });

        // Build final lines: header on row 1, new entry on row 2, rest below
        const finalLines = buildLines(lines, entry);

        await ghPut(env.GITHUB_TOKEN, finalLines, sha);
        return Response.json({ ok: true, skipped: false, row: 2, total: finalLines.length }, { headers: cors });

      } catch(e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: cors });
      }
    }

    return Response.json({ ok: false, error: `No route for ${request.method} ${pathname}` }, { status: 404, headers: cors });
  }
};