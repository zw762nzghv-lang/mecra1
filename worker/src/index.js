/* ==========================================================================
   mecra-proxy — CORS proxy + Cloudflare KV senkron ucu
   ---------------------------------------------------------------------------
   Uçlar:
     GET  /?url=<encoded>   → hedefi sunucu tarafında çekip CORS ile döndürür (proxy)
     GET  /kv?key=<anahtar> → anahtardaki JSON'u döndürür (yoksa null)
     PUT  /kv?key=<anahtar> → gövdedeki JSON'u o anahtara yazar
   Anahtar hem adres hem paroladır: en az 12 karakter, sadece harf/rakam/tire.
   GÜVENLİK NOTU: anahtar URL query'sinde gider → Worker/CDN log'larına düşebilir.
   Kişisel liste için kabul edilebilir; ileride bir header'a (ör. X-Mecra-Key) taşınabilir.
   ========================================================================== */

// Ortak CORS başlıkları (GET/PUT/OPTIONS).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// KV değeri için üst sınır (1 MB).
const MAX_KV_BYTES = 1024 * 1024;

// Kısa hata yardımcı: JSON + CORS ile anlamlı mesaj döndür.
function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// JSON gövdeli başarılı yanıt (CORS + no-store).
function jsonResponse(bodyText, status = 200) {
  const headers = new Headers(CORS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(bodyText, { status, headers });
}

/* ----------------------------- PROXY (mevcut) ----------------------------- */

// Hedef URL güvenli mi? (Basit SSRF koruması)
function isAllowed(target) {
  let u;
  try {
    u = new URL(target);
  } catch (_) {
    return { ok: false, reason: 'Geçersiz URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Sadece http/https adreslerine izin var' };
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||             // link-local
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || // 172.16–172.31
    host === '[::1]' ||
    host.startsWith('[fc') ||               // IPv6 unique local
    host.startsWith('[fd') ||
    host.startsWith('[fe80');               // IPv6 link-local
  if (blocked) {
    return { ok: false, reason: 'Yerel/özel ağ adresleri engellendi' };
  }
  return { ok: true, url: u };
}

async function handleProxy(searchParams) {
  const target = searchParams.get('url');
  if (!target) {
    return fail(400, 'url parametresi gerekli: /?url=<encoded>');
  }

  const check = isAllowed(target);
  if (!check.ok) {
    return fail(400, check.reason);
  }

  let upstream;
  try {
    upstream = await fetch(check.url.href, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; mecra-proxy/1.0; +https://github.com/)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return fail(502, 'Hedef adrese ulaşılamadı: ' + (e && e.message ? e.message : 'bilinmeyen hata'));
  }

  if (!upstream.ok) {
    return fail(upstream.status, 'Hedef sunucu hata döndürdü: HTTP ' + upstream.status);
  }

  const headers = new Headers(CORS);
  const ct = upstream.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: 200, headers });
}

/* ------------------------------- KV SENKRON ------------------------------- */

// Anahtar doğrulama: en az 12 karakter, sadece harf/rakam/tire.
function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9-]{12,}$/.test(key);
}

async function handleKv(request, env, searchParams) {
  // KV binding yoksa (yanlış yapılandırma) net hata dön.
  if (!env || !env.MECRA_KV) {
    return fail(500, 'KV bağlanmadı (MECRA_KV binding eksik)');
  }

  const key = searchParams.get('key') || '';
  if (!validKey(key)) {
    return fail(400, 'Geçersiz anahtar: en az 12 karakter, sadece harf/rakam/tire');
  }

  // GET → oku (yoksa null)
  if (request.method === 'GET') {
    const stored = await env.MECRA_KV.get(key);   // string | null
    return jsonResponse(stored == null ? 'null' : stored);
  }

  // PUT → yaz
  if (request.method === 'PUT') {
    const body = await request.text();

    // Boyut sınırı (baytça). aşarsa 413.
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_KV_BYTES) {
      return fail(413, 'Veri çok büyük (en fazla 1 MB)');
    }

    // Geçerli JSON mu? Bozuk veri saklanmasın.
    try {
      JSON.parse(body);
    } catch (_) {
      return fail(400, 'Gövde geçerli JSON değil');
    }

    await env.MECRA_KV.put(key, body);
    return jsonResponse(JSON.stringify({ ok: true }));
  }

  return fail(405, '/kv yalnızca GET ve PUT destekler');
}

/* --------------------------------- ROUTER -------------------------------- */

export default {
  async fetch(request, env) {
    // Preflight her yol için ortak
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // /kv → senkron ucu (proxy'den temiz ayrı)
    if (url.pathname === '/kv') {
      return handleKv(request, env, url.searchParams);
    }

    // Diğer her şey → mevcut proxy davranışı (yalnız GET)
    if (request.method !== 'GET') {
      return fail(405, 'Sadece GET destekleniyor');
    }
    return handleProxy(url.searchParams);
  },
};
