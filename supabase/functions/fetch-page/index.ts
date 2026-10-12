// レシピページを代わりに取ってくる中継役（Supabase Edge Function）。
// ブラウザは他サイトのページを直接読めないため、アプリはここ経由で読む。
// ログインした人だけ使えるよう、コードの中でトークンを確かめる
// （「Verify JWT with legacy secret」はオフにする。新しい署名鍵のトークンは通らないため）。

const ALLOWED_ORIGINS = ['https://umami-report.github.io', 'http://localhost:5190'];
const SB_URL = 'https://iweprevsbohxuzfwafqz.supabase.co';
const SB_KEY = 'sb_publishable_h-1Cc7jRHOyUSFpTLTLDoA_PaKp54Em';
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

// トークンが本物のログインかをSupabase Authに確かめる（5分間は覚えておく）
const okTokens = new Map<string, number>();
async function isLoggedIn(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.startsWith('sb_')) return false;
  const until = okTokens.get(token);
  if (until && until > Date.now()) return true;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  okTokens.set(token, Date.now() + 5 * 60 * 1000);
  return true;
}

// YouTubeの動画情報（タイトル・概要欄）を取る。
// ページそのものはサーバーから開くと概要欄が入っていないことがあるため、
// YouTubeの内部API → （YT_API_KEY があれば）公式のData API の順に試す。
async function youtubeInfo(id: string) {
  const thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  let title = '';
  let status = '';
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20250925.01.00', hl: 'ja', gl: 'JP' } },
        videoId: id,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const j = r.ok ? await r.json() : null;
    status = j?.playabilityStatus?.status ?? `http ${r.status}`;
    const v = j?.videoDetails;
    title = v?.title ?? '';
    if (v?.shortDescription) return { title, description: v.shortDescription, thumbnail, via: 'player' };
  } catch (e) {
    status = String(e);
  }
  const key = Deno.env.get('YT_API_KEY');
  if (key) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`);
    const s = r.ok ? (await r.json()).items?.[0]?.snippet : null;
    if (s) return { title: s.title, description: s.description ?? '', thumbnail, via: 'api' };
  }
  return { title, description: '', thumbnail, via: 'none', status };
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
  if (!(await isLoggedIn(req))) return new Response('login required', { status: 401, headers });

  const yt = new URL(req.url).searchParams.get('youtube');
  if (yt) {
    if (!/^[\w-]{11}$/.test(yt)) return new Response('bad id', { status: 400, headers });
    return Response.json(await youtubeInfo(yt), { headers });
  }

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
