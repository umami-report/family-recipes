// レシピページを代わりに取ってくる中継役（Supabase Edge Function）。
// ブラウザは他サイトのページを直接読めないため、アプリはここ経由で読む。
// ログインした人のトークンが必要（Verify JWT をオンのままにする）。

const ALLOWED_ORIGINS = ['https://umami-report.github.io', 'http://localhost:5190'];
const MAX_BYTES = 8 * 1024 * 1024;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function cors(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

// 社内ネットワークやIP直打ちには行かせない
function blockedHost(host: string) {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^[\d.]+$/.test(host) ||
    host.includes(':') ||
    host.endsWith('.supabase.co')
  );
}

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers });

  let target: URL;
  try {
    target = new URL(new URL(req.url).searchParams.get('url') ?? '');
  } catch {
    return new Response('bad url', { status: 400, headers });
  }
  if (!['http:', 'https:'].includes(target.protocol) || blockedHost(target.hostname)) {
    return new Response('not allowed', { status: 403, headers });
  }

  let res: Response;
  try {
    res = await fetch(target, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return new Response('fetch failed', { status: 502, headers });
  }
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: 502, headers });

  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return new Response('too large', { status: 413, headers });
  return new Response(body, {
    headers: { ...headers, 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' },
  });
});
