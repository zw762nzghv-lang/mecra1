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

// YouTube/Google, veri merkezi IP'lerine (Worker gibi) çerez onay duvarı
// ("Before you continue…") sunar → gerçek sayfa yüklenmez, canonical/redirect
// sinyali kaybolur. Consent çerezi göndererek duvarı aş (yt-dlp vb. de böyle yapar).
function isGoogleHost(host) {
  return /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)google\.com$/i.test(host);
}
const YT_CONSENT_COOKIE = 'SOCS=CAI; CONSENT=YES+1';

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
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; mecra-proxy/1.0; +https://github.com/)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
    };
    // YouTube/Google hedeflerinde: consent çerezi (onay duvarını aş) + tarayıcı
    // User-Agent'ı (gerçek sayfa HTML'i gelsin; bot UA'sında canonical boş dönüyor).
    if (isGoogleHost(check.url.hostname.toLowerCase())) {
      headers['Cookie'] = YT_CONSENT_COOKIE;
      headers['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
      headers['Accept-Language'] = 'en-US,en;q=0.9';
    }
    upstream = await fetch(check.url.href, {
      method: 'GET',
      headers,
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

/* ------------------------- YOUTUBE SHORTS TESPİTİ ------------------------- */
// GET /ytkind?id=<videoId> → { id, kind:'short'|'long' }
// Sinyal: youtube.com/shorts/ID normal videoda 303 ile /watch'a yönlenir,
// gerçek Short'ta 200 kalır. Consent çereziyle veri-merkezi onay duvarı aşılır,
// böylece bu sinyal net gelir. İstemci 1.3 MB HTML indirmez; ufak JSON alır.
async function handleYtKind(searchParams) {
  const id = (searchParams.get('id') || '').trim();
  if (!/^[\w-]{11}$/.test(id)) {
    return fail(400, 'Geçersiz video id (11 karakter olmalı)');
  }

  let res;
  try {
    res = await fetch('https://www.youtube.com/shorts/' + id, {
      method: 'GET',
      redirect: 'manual',                 // yönlendirmeyi biz değerlendirelim
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': YT_CONSENT_COOKIE,       // onay duvarını aş
      },
    });
  } catch (e) {
    return fail(502, 'YouTube\'a ulaşılamadı: ' + (e && e.message ? e.message : 'bilinmeyen'));
  }

  let kind = 'long';   // güvenli varsayılan: bilinmiyorsa İçerik tarafında kalsın
  const status = res.status;
  if (status >= 300 && status < 400) {
    // /watch'a yönlendi → normal (uzun) video. Başka yere yönlenirse yine uzun say.
    const loc = res.headers.get('location') || '';
    kind = /\/shorts\//i.test(loc) ? 'short' : 'long';
  } else if (status === 200) {
    // 200: ya gerçek Short ya da (çerez tutmadıysa) onay duvarı. Gövdeden doğrula.
    let html = '';
    try { html = await res.text(); } catch (_) { html = ''; }
    const wall = /consent\.youtube\.com|before you continue/i.test(html);
    if (wall) {
      // Çerez işe yaramadı → canonical yok; kararsız → uzun say (İçerik'te kalsın).
      kind = 'long';
    } else if (/rel=["']canonical["'][^>]*href=["'][^"']*\/watch/i.test(html)) {
      kind = 'long';    // canonical /watch → uzun
    } else {
      kind = 'short';   // yönlenmedi + duvar yok → Short
    }
  }

  return jsonResponse(JSON.stringify({ id, kind }));
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

    // /ytkind → YouTube Short/uzun tespiti (yalnız GET)
    if (url.pathname === '/ytkind') {
      if (request.method !== 'GET') return fail(405, 'Sadece GET destekleniyor');
      return handleYtKind(url.searchParams);
    }

    // Diğer her şey → mevcut proxy davranışı (yalnız GET)
    if (request.method !== 'GET') {
      return fail(405, 'Sadece GET destekleniyor');
    }
    return handleProxy(url.searchParams);
  },
};
