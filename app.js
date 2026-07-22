/* ==========================================================================
   mecra — algoritmasız, reklamsız kişisel RSS + YouTube okuyucu
   Saf JS, framework yok, build yok. Türkçe yorumlu.
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   AYARLAR — tek yerden değiştirilebilir
   -------------------------------------------------------------------------- */
const CONFIG = {
  // Uygulama adı: burayı değiştirmek her yeri değiştirir (başlık, marka, manifest ismi ayrı).
  APP_NAME: 'mecra',

  // CORS aşmak için proxy zinciri. Sırayla denenir; biri başarısız olursa sonraki.
  // Her eleman bir fonksiyondur: ham feed URL'sini alır, proxy'li URL döndürür.
  PROXIES: [
    // 1) KENDİ Cloudflare Worker'ın (birincil).
    (url) => 'https://mecra-proxy.mecra-talha.workers.dev/?url=' + encodeURIComponent(url),

    // 2) Yedek: allorigins
    (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),

    // 3) İkinci yedek: codetabs
    (url) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(url),

    // 4) Son çare: doğrudan (proxysiz) dene — CORS izni olan feed'ler için çalışır.
    (url) => url,
  ],

  // Her feed'den en fazla kaç öğe tutulsun (bellek/performans).
  MAX_ITEMS_PER_SOURCE: 60,

  // Akışta toplam gösterilecek öğe sınırı.
  MAX_ITEMS_TOTAL: 400,

  // Okundu (read) id listesi bu kadarla sınırlı; eskiler düşer (sınırsız büyümesin).
  MAX_READ_IDS: 4000,

  // Bulut senkron ucu (aynı Cloudflare Worker'ın /kv yolu). Worker adresin
  // değişirse burayı da güncelle.
  SYNC_ENDPOINT: 'https://mecra-proxy.mecra-talha.workers.dev/kv',

  // YouTube Short/uzun tespit ucu (aynı Worker'ın /ytkind yolu). Worker sunucu
  // tarafında consent duvarını aşıp yönlendirmeye bakar → güvenilir + hafif.
  YTKIND_ENDPOINT: 'https://mecra-proxy.mecra-talha.workers.dev/ytkind',

  // KV'ye yazma debounce süresi (ms). Hızlı değişiklikler tek yazıya toplanır.
  SYNC_DEBOUNCE_MS: 1500,
};

// Kategorisi boş/eksik kaynakların otomatik grubu (tek yerden değişir).
const UNCATEGORIZED = 'Kategorisiz';

// Kaynak simgesi (data URL) üst sınırı. Bulut senkron KV anahtar başına 1 MB
// ve tüm kaynakların ikonu aynı snapshot'a gidiyor → tek ikon büyük olmamalı.
const MAX_ICON_BYTES = 40 * 1024;   // ~40 KB (data URL karakter uzunluğu)

/* --------------------------------------------------------------------------
   GÜVENLİ DEPOLAMA — localStorage engelliyse belleğe düşer, uygulama çökmez
   -------------------------------------------------------------------------- */
const Store = (() => {
  const mem = {};                 // localStorage yoksa geçici bellek
  let ok = true;
  try {
    const k = '__mecra_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
  } catch (_) {
    ok = false;                   // gizli mod / kota / engel
  }
  return {
    get(key, fallback) {
      try {
        const raw = ok ? localStorage.getItem(key) : mem[key];
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, val) {
      const raw = JSON.stringify(val);
      try {
        if (ok) localStorage.setItem(key, raw);
        else mem[key] = raw;
      } catch (_) {
        mem[key] = raw;           // kota dolarsa belleğe
      }
    },
  };
})();

/* --------------------------------------------------------------------------
   DURUM
   -------------------------------------------------------------------------- */
const state = {
  sources: Store.get('mecra.sources', []),   // {id,title,url,type:'rss'|'youtube',site,category}
  read: new Set(Store.get('mecra.read', [])), // okunmuş öğe id'leri (link'ler)
  // Silinen kaynakların url'leri (tombstone): buluttaki eski kopya union'la geri gelmesin.
  deleted: new Set(Store.get('mecra.deleted', [])),
  cloudKey: Store.get('mecra.cloudKey', ''),  // bulut senkron anahtarı (varsa)
  allIcon: sanitizeIcon(Store.get('mecra.allIcon', '')),  // 'Hepsi' satırı için özel simge (data URL/http)
  items: [],                                  // birleşik akış
  filter: 'all',                              // 'all' | {type:'category',name} | kaynak id
  expandedCategory: null,                     // sidebar akordeonunda açık tek kategori (ad) ya da null
  lastRefreshed: Store.get('mecra.lastRefreshed', 0),  // son başarılı yenilenme (ms)
  loading: false,

  // --- "Hepsi" alt sekmeleri: uzun videolar/yazılar ('content') ↔ Shorts ---
  // YouTube RSS'i bir videonun Short olup olmadığını söylemez; her videoId bir kez
  // proxy ile kontrol edilip sonucu burada önbelleğe alınır (yerel; buluta gitmez).
  ytKind: Store.get('mecra.ytKind', {}),        // videoId -> 'short' | 'long'
  allTab: Store.get('mecra.allTab', 'content'), // 'content' | 'shorts' (yalnız 'Hepsi' için)

  // --- Seçim modu (bir karta basılı tut → çoklu seç → okundu yap) ---
  // YouTube'dan zaten izlenen videoları buraya girip linke gitmeden okundu yapmak için.
  selectMode: false,          // seçim modu açık mı
  selected: new Set(),        // seçili öğe id'leri (geçici; kalıcı DEĞİL)
};

function persist() {
  Store.set('mecra.sources', state.sources);
  Store.set('mecra.deleted', [...state.deleted]);
  Store.set('mecra.allIcon', state.allIcon);

  // Okundu listesi sınırsız büyümesin: en yeni MAX_READ_IDS kaydı tut.
  // Set ekleme sırasını korur → en eskiler baştadır; fazlasını baştan at.
  let ids = [...state.read];
  if (ids.length > CONFIG.MAX_READ_IDS) {
    ids = ids.slice(ids.length - CONFIG.MAX_READ_IDS);
    state.read = new Set(ids);   // bellekteki Set'i de küçült
  }
  Store.set('mecra.read', ids);

  // Her kalıcılaştırmada buluta debounce'lu yaz (anahtar yoksa no-op).
  schedulePush();
}

/* --------------------------------------------------------------------------
   KISA YARDIMCILAR
   -------------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// HTML özetini düz metne çevir (XSS'e karşı: asla innerHTML basmıyoruz).
// DOMParser ile ayrıştırıp yalnızca metni alıyoruz; <script> vs. çalışmaz.
function htmlToText(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (_) {
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// Göreli tarih ("3 sa önce") — Türkçe.
function timeAgo(date) {
  if (!date) return '';
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'az önce';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} gün önce`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} hf önce`;
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* --------------------------------------------------------------------------
   BULUT SENKRON (Cloudflare KV)
   Koruma modeli: tek gizli anahtar hem adres hem parola. Anahtar yoksa uygulama
   tamamen localStorage ile çalışır (geriye dönük uyumlu).

   Çakışma stratejisi (en basit sağlam çözüm):
     - Kaynaklar: url'ye göre birleştir; yerel kopya öncelikli (kullanıcının o an
       gördüğü/dokunduğu cihaz). Silinenler 'tombstone' (deleted) listesiyle ayıklanır
       ki buluttaki eski kopya union'la geri gelmesin. Silme de buluta yansır.
     - Okundu id'leri: DAİMA union (hiçbir cihazda kaybolmasın).
     - Yazma: son-yazan-kazanır (updatedAt damgalı tam snapshot).
   GÜVENLİK NOTU: anahtar URL query'sinde gider → Worker log'larına düşebilir.
   Kişisel liste için kabul edilebilir; ileride header'a taşınabilir.
   -------------------------------------------------------------------------- */
function syncEnabled() {
  return !!(state.cloudKey && state.cloudKey.length >= 12);
}

// Rastgele anahtar üret (varsayılan 20 karakter; harf+rakam, kriptografik).
function genCloudKey(len = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

// KV oku → JSON (yoksa null döner).
async function kvGet(key) {
  const res = await fetch(CONFIG.SYNC_ENDPOINT + '?key=' + encodeURIComponent(key));
  if (!res.ok) throw new Error('KV GET ' + res.status);
  return await res.json();   // null olabilir
}

// KV'ye yaz (tam snapshot).
async function kvPut(key, data) {
  const res = await fetch(CONFIG.SYNC_ENDPOINT + '?key=' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('KV PUT ' + res.status);
  return await res.json();
}

// Yerel durumun buluta yazılacak tam görüntüsü.
function snapshot() {
  return {
    v: 2,
    updatedAt: Date.now(),
    sources: state.sources,
    read: [...state.read],
    deleted: [...state.deleted],
    allIcon: state.allIcon,
  };
}

// Buluttan gelen veriyi yerelle birleştir (yukarıdaki stratejiye göre).
function mergeCloud(cloud) {
  const c = cloud && typeof cloud === 'object' ? cloud : {};
  const cSources = Array.isArray(c.sources) ? c.sources : [];
  const cRead = Array.isArray(c.read) ? c.read : [];
  const cDeleted = Array.isArray(c.deleted) ? c.deleted : [];

  // Tombstone union
  const deleted = new Set([...state.deleted, ...cDeleted]);

  // Kaynaklar: önce bulut, sonra yerel (yerel üzerine yazar) → url anahtarlı Map
  const byUrl = new Map();
  cSources.forEach((s) => { if (s && s.url) byUrl.set(s.url, normalizeSource(s)); });
  state.sources.forEach((s) => { if (s && s.url) byUrl.set(s.url, s); });

  // Silinenleri ayıkla
  state.sources = [...byUrl.values()].filter((s) => !deleted.has(s.url));
  state.read = new Set([...state.read, ...cRead]);
  state.deleted = deleted;

  // 'Hepsi' simgesi: yerelde yoksa buluttakini al (yerel öncelikli).
  if (!state.allIcon && typeof c.allIcon === 'string') state.allIcon = sanitizeIcon(c.allIcon);

  persist();   // yerel + ekranı besleyecek; ayrıca push planlar
}

// İçe/buluttan gelen kaynağı güvenli alanlarla normalize et.
function normalizeSource(s) {
  return {
    id: s.id || uid(),
    title: s.title || hostname(s.url),
    url: s.url,
    // URL bir YouTube adresiyse tip 'youtube' olsun (eski/yanlış kayıtlar da düzelsin).
    type: (s.type === 'youtube' || (s.url && isYouTube(s.url))) ? 'youtube' : 'rss',
    site: s.site || hostname(s.url),
    category: s.category ? String(s.category) : '',
    // Opsiyonel simge (data URL / http(s)); yoksa boş → harf rozeti kullanılır.
    icon: sanitizeIcon(s.icon),
  };
}

// Simge alanını güvene al: yalnız http(s) veya data:image kabul, boyut sınırı uygula.
function sanitizeIcon(icon) {
  const v = typeof icon === 'string' ? icon.trim() : '';
  if (!v) return '';
  if (!/^https?:\/\//i.test(v) && !/^data:image\//i.test(v)) return '';
  if (/^data:/i.test(v) && v.length > MAX_ICON_BYTES) return '';   // şişkin data URL'yi düşür
  return v;
}

// --- Debounce'lu yazma + sessiz retry + durum göstergesi ---
let _pushTimer = null;
function schedulePush(immediate) {
  if (!syncEnabled()) return;
  setCloudStatus('sync');
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => doPush(0), immediate ? 0 : CONFIG.SYNC_DEBOUNCE_MS);
}

async function doPush(retry) {
  if (!syncEnabled()) return;
  try {
    await kvPut(state.cloudKey, snapshot());
    setCloudStatus('saved');
  } catch (e) {
    // Sessiz retry (birkaç kez), sonra çevrimdışı bırak (online olunca tekrar denenir).
    setCloudStatus('offline');
    if ((retry || 0) < 3) setTimeout(() => doPush((retry || 0) + 1), 3000);
  }
}

// Açılışta / anahtar değişince: buluttan çek, birleştir, geri yaz (tek doğruya yakınsa).
async function initialSync() {
  if (!syncEnabled()) return;
  setCloudStatus('sync');
  try {
    const cloud = await kvGet(state.cloudKey);
    mergeCloud(cloud);          // yerelle birleştir + persist (push planlar)
    renderSources();
    renderSettings();
    renderFeed();
    schedulePush(true);         // birleşmiş sonucu hemen buluta yaz
    setCloudStatus('saved');
  } catch (e) {
    setCloudStatus('offline');  // çevrimdışı: yerelle çalışmaya devam
  }
}

// Anahtarı belirle/değiştir; boşsa senkronu kapat.
function setCloudKey(key) {
  const k = (key || '').trim();
  state.cloudKey = k;
  Store.set('mecra.cloudKey', k);
  if (!k) { setCloudStatus('off'); return; }
  if (k.length < 12) { setCloudStatus('invalid'); return; }
  initialSync();                // yeni anahtarla hemen çek + birleştir
}

// Küçük durum göstergesi (kaynaklar panelinde).
function setCloudStatus(kind) {
  const el = $('#cloudStatus');
  if (!el) return;
  const map = {
    off: '',
    invalid: 'Anahtar en az 12 karakter olmalı',
    sync: 'Senkronlanıyor…',
    saved: 'Kaydedildi',
    offline: 'Çevrimdışı — sonra denenecek',
  };
  el.textContent = map[kind] || '';
  el.className = 'cloud-status' + (kind ? ' ' + kind : '');
}

/* --------------------------------------------------------------------------
   AĞ — proxy zinciriyle metin çek
   -------------------------------------------------------------------------- */
async function fetchViaProxy(url) {
  let lastErr;
  for (const build of CONFIG.PROXIES) {
    try {
      const res = await fetch(build(url), { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text && text.trim()) return text;
      throw new Error('boş yanıt');
    } catch (e) {
      lastErr = e;   // bu proxy patladı, sıradakini dene
    }
  }
  throw lastErr || new Error('Tüm proxy denemeleri başarısız');
}

/* --------------------------------------------------------------------------
   SHORTS TESPİTİ — "Hepsi" sekmelerinde (İçerik/Shorts) ayrım için
   YouTube RSS'i Short bilgisi vermez. Bir videonun /shorts/ID adresi:
     - gerçek Short ise sayfa /shorts/ID olarak kalır (canonical/og:url /shorts/),
     - normal video ise /watch?v=ID'ye yönlenir (canonical /watch).
   Bu yüzden her videoId'yi bir kez proxy'den çekip kanonik adrese bakarız;
   sonuç state.ytKind'e (yerel önbellek) yazılır → bir daha kontrol edilmez.
   -------------------------------------------------------------------------- */
async function probeShort(videoId) {
  // 1) Birincil: kendi Worker'ımızın /ytkind ucu. Sunucu tarafında consent
  //    duvarını aşıp /shorts/ID yönlendirmesine bakar (303 /watch → uzun, 200 → Short).
  //    Hafif (ufak JSON) ve güvenilir; istemci 1+ MB HTML indirmez.
  try {
    const res = await fetch(CONFIG.YTKIND_ENDPOINT + '?id=' + encodeURIComponent(videoId));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.kind === 'short' || data.kind === 'long')) return data.kind === 'short';
    }
  } catch (_) { /* Worker ulaşılamadı → aşağıdaki yedek yönteme düş */ }

  // 2) Yedek: sayfayı proxy zinciriyle çekip canonical/og:url'de /shorts/ ara.
  const html = await fetchViaProxy('https://www.youtube.com/shorts/' + videoId);
  return (
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/shorts\//i.test(html) ||
    /<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']*\/shorts\//i.test(html) ||
    /"canonicalBaseUrl":"\/shorts\//.test(html)
  );
}

// Akıştaki bilinmeyen YouTube videolarını (sınırlı eşzamanlılıkla) sınıflandır,
// sonucu önbelleğe al ve gerekiyorsa 'Hepsi' akışını yeniden çiz.
let _probing = false;
async function ensureShortKinds() {
  if (_probing) return;
  const seen = new Set();
  const unknown = [];
  for (const it of state.items) {
    if (it.sourceType === 'youtube' && it.videoId &&
        !(it.videoId in state.ytKind) && !seen.has(it.videoId)) {
      seen.add(it.videoId);
      unknown.push(it.videoId);
    }
  }
  if (!unknown.length) return;

  _probing = true;
  let i = 0;
  let changed = false;
  const CONCURRENCY = 4;

  const worker = async () => {
    while (i < unknown.length) {
      const id = unknown[i++];
      try {
        state.ytKind[id] = (await probeShort(id)) ? 'short' : 'long';
      } catch (_) {
        state.ytKind[id] = 'long';   // tespit edilemedi → İçerik tarafında kalsın
      }
      changed = true;
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    _probing = false;
  }

  if (changed) {
    Store.set('mecra.ytKind', state.ytKind);
    // Yeni öğrenilen Short'lar doğru sekmeye geçsin (yalnız 'Hepsi' görünümünde).
    if (state.filter === 'all') { renderAllTabs(); renderFeed(); }
  }
}

/* --------------------------------------------------------------------------
   KAYNAK KEŞFİ — girdiyi çöz (RSS / site / YouTube)
   -------------------------------------------------------------------------- */

// Girdi bir YouTube adresi mi?
function isYouTube(input) {
  return /(^|\.)youtube\.com|youtu\.be/i.test(input);
}

// YouTube adresini gizli feed URL'sine çevir.
// Kabul: /channel/UC..., /@kullanici, /c/..., /user/...
async function resolveYouTube(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // 1) Doğrudan channel_id yakala
  const chMatch = url.match(/\/channel\/(UC[\w-]{20,})/i);
  if (chMatch) {
    // Avatar için kanal sayfasını bir kez çek. İkon isteğe bağlı: bu adım
    // patlarsa (ağ/proxy) kanal yine de eklenir, ikon boş kalır.
    let avatar = '';
    try {
      avatar = extractYouTubeAvatar(await fetchViaProxy(url));
    } catch (_) { /* ikon yok say */ }
    return { ...ytFeed(chMatch[1]), avatar };
  }

  // 2) @handle / c / user → kanal sayfasını çekip channelId + avatar ayıkla
  const html = await fetchViaProxy(url);
  // Sayfa kaynağında "channelId":"UC..." ya da externalId geçer
  const idMatch =
    html.match(/"channelId":"(UC[\w-]{20,})"/) ||
    html.match(/"externalId":"(UC[\w-]{20,})"/) ||
    html.match(/channel_id=(UC[\w-]{20,})/) ||
    html.match(/\/channel\/(UC[\w-]{20,})/);
  if (idMatch) return { ...ytFeed(idMatch[1]), avatar: extractYouTubeAvatar(html) };

  throw new Error('YouTube kanal kimliği bulunamadı');
}
function ytFeed(channelId) {
  return {
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId,
  };
}

// Kanal sayfası HTML'inden avatar (profil) görselini ayıkla.
// Önce og:image meta (büyük boy, yt3.googleusercontent.com/...), yoksa gömülü
// JSON'daki avatar thumbnail'i. Bulunamazsa boş → harf/▶ rozetine düşülür.
function extractYouTubeAvatar(html) {
  if (!html) return '';
  // og:image içeriği kanal avatarıdır; meta özellik/içerik sırası ikisi de olabilir.
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m && /^https?:\/\//i.test(m[1])) return m[1].replace(/&amp;/g, '&');
  // Yedek: gömülü JSON'daki avatar thumbnail listesi (kaçışlı /'leri düzelt).
  m = html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
  if (m && /^https?:\/\//i.test(m[1])) return m[1].replace(/\\\//g, '/');
  return '';
}

// Site adresinden RSS keşfet: <link rel="alternate" type="application/rss+xml">
function discoverFeedFromHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sel =
    'link[rel="alternate"][type="application/rss+xml"], ' +
    'link[rel="alternate"][type="application/atom+xml"], ' +
    'link[rel="alternate"][type="application/feed+json"]';
  const link = doc.querySelector(sel);
  if (!link) return null;
  const href = link.getAttribute('href');
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;   // göreli adresi mutlaka çevir
  } catch (_) {
    return href;
  }
}

// Bir feed URL'sini çek + ayrıştır (tek noktada).
async function fetchAndParse(url) {
  const text = await fetchViaProxy(url);
  return parseFeed(text, url);
}

// Girdiyi feed URL'sine + türe çöz.
// DÖNÜŞ: { type, url, parsed } — parsed = { isFeed, title, items }.
// Feed burada BİR KEZ çekilip ayrıştırılır; addSource ikinci kez çekmez.
async function resolveInput(raw) {
  let input = raw.trim();
  if (!input) throw new Error('Boş adres');

  // YouTube: kanalı feed URL'sine çevir, sonra feed'i çek + ayrıştır.
  if (isYouTube(input)) {
    const yt = await resolveYouTube(input);        // { type:'youtube', url, avatar }
    const parsed = await fetchAndParse(yt.url);
    if (!parsed.isFeed) throw new Error('YouTube feed okunamadı');
    return { type: 'youtube', url: yt.url, parsed, icon: yt.avatar || '' };
  }

  // http(s) yoksa ekle
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;

  // Önce doğrudan feed mi diye çek + ayrıştırmayı dene
  const text = await fetchViaProxy(input);
  const parsed = parseFeed(text, input);
  if (parsed.isFeed) {
    return { type: 'rss', url: input, parsed };
  }

  // Feed değilse HTML kabul et → içinden feed keşfet, keşfedileni çek + ayrıştır.
  const discovered = discoverFeedFromHtml(text, input);
  if (discovered) {
    const dParsed = await fetchAndParse(discovered);
    if (!dParsed.isFeed) throw new Error('Keşfedilen adres geçerli feed değil');
    return { type: 'rss', url: discovered, parsed: dParsed };
  }

  throw new Error('Bu adreste RSS/Atom bulunamadı');
}

/* --------------------------------------------------------------------------
   AYRIŞTIRMA — RSS + Atom (+ küçük görsel)
   -------------------------------------------------------------------------- */
function parseFeed(text, sourceUrl) {
  const xml = new DOMParser().parseFromString(text, 'text/xml');

  // Ayrıştırma hatası (ör. gelen şey XML değil)
  if (xml.querySelector('parsererror')) {
    return { isFeed: false, title: '', items: [] };
  }

  const isAtom = !!xml.querySelector('feed > entry, feed entry');
  const isRss = !!xml.querySelector('rss channel, channel > item, channel item');
  if (!isAtom && !isRss) {
    return { isFeed: false, title: '', items: [] };
  }

  const g = (parent, sel) => {
    const el = parent.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  };

  let feedTitle = '';
  const items = [];

  if (isAtom) {
    feedTitle = g(xml, 'feed > title') || g(xml, 'feed title');
    const entries = xml.querySelectorAll('feed > entry, entry');
    entries.forEach((e) => {
      // Atom link: rel="alternate" tercih
      let link = '';
      const links = e.querySelectorAll('link');
      links.forEach((l) => {
        const rel = l.getAttribute('rel');
        if (!link && (!rel || rel === 'alternate')) link = l.getAttribute('href') || '';
      });
      const dateStr = g(e, 'published') || g(e, 'updated');
      items.push(makeItem({
        title: g(e, 'title'),
        link,
        summary: g(e, 'summary') || g(e, 'content'),
        dateStr,
        el: e,
        sourceUrl,
      }));
    });
  } else {
    feedTitle = g(xml, 'channel > title') || g(xml, 'channel title');
    const nodes = xml.querySelectorAll('channel > item, item');
    nodes.forEach((it) => {
      items.push(makeItem({
        title: g(it, 'title'),
        link: g(it, 'link') || (it.querySelector('link') ? it.querySelector('link').textContent.trim() : ''),
        summary: g(it, 'description') || g(it, 'encoded') || g(it, 'summary'),
        dateStr: g(it, 'pubDate') || g(it, 'date') || g(it, 'published'),
        el: it,
        sourceUrl,
      }));
    });
  }

  return { isFeed: true, title: htmlToText(feedTitle), items };
}

// Tek bir öğe nesnesi üret (görsel + tarih + güvenli metin).
function makeItem({ title, link, summary, dateStr, el, sourceUrl }) {
  const date = dateStr ? new Date(dateStr) : null;
  return {
    id: (link || (title + dateStr) || uid()).trim(),  // link genelde benzersiz
    title: htmlToText(title) || '(başlıksız)',
    link: link || '',
    summary: htmlToText(summary),
    date: date && !isNaN(date) ? date : null,
    videoId: extractVideoId(el, link),
    thumb: extractThumb(el, link),
  };
}

// YouTube videoId'sini öğeden çıkar (yt:videoId, watch?v=, youtu.be/, /shorts/).
// Short/uzun ayrımı bu id üzerinden yapılır; YouTube dışı öğelerde boş döner.
function extractVideoId(el, link) {
  return (el && tagText(el, 'videoId')) ||
    (link && (link.match(/[?&]v=([\w-]{11})/) || [])[1]) ||
    (link && (link.match(/youtu\.be\/([\w-]{11})/) || [])[1]) ||
    (link && (link.match(/\/shorts\/([\w-]{11})/) || [])[1]) ||
    '';
}

// Küçük görsel çıkar: YouTube videoId → hqdefault, yoksa media:thumbnail/enclosure.
function extractThumb(el, link) {
  if (!el) return '';

  // 1) YouTube: yt:videoId
  const ytId = extractVideoId(el, link);
  if (ytId) return `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;

  // 2) media:thumbnail / media:content (url attribute)
  const media =
    el.querySelector('thumbnail[url]') ||
    el.querySelector('content[url][medium="image"]') ||
    el.querySelector('content[url][type^="image"]');
  if (media && media.getAttribute('url')) return media.getAttribute('url');

  // 3) enclosure (image tipli)
  const enc = el.querySelector('enclosure[url]');
  if (enc) {
    const t = enc.getAttribute('type') || '';
    if (!t || t.startsWith('image')) return enc.getAttribute('url');
  }

  // 4) içerikteki ilk <img src>
  const desc = el.querySelector('description, encoded, content, summary');
  if (desc) {
    const m = (desc.textContent || '').match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return '';
}

// Namespace'li etiketler (yt:videoId, media:thumbnail) için tag adına göre ara.
function tagText(el, localName) {
  // querySelector namespace'te sorun çıkarabilir; getElementsByTagName daha toleranslı.
  const direct = el.getElementsByTagName(localName);
  if (direct && direct.length) return (direct[0].textContent || '').trim();
  // "yt:videoId" gibi tam adla da dene
  const all = el.getElementsByTagName('*');
  for (const node of all) {
    if (node.localName === localName || node.nodeName === 'yt:' + localName) {
      return (node.textContent || '').trim();
    }
  }
  return '';
}

/* --------------------------------------------------------------------------
   KAYNAK YÖNETİMİ
   -------------------------------------------------------------------------- */
// Ekleme kutusunda seçili bekleyen kategori (varsayılan Kategorisiz).
let pendingCategory = UNCATEGORIZED;

async function addSource(raw) {
  setHint('Çözümleniyor…', 'busy');

  // Tek fetch: resolveInput feed'i çekip ayrıştırılmış sonucu (title+items) döndürür.
  let resolved;
  try {
    resolved = await resolveInput(raw);
  } catch (e) {
    setHint('Bulunamadı: ' + e.message, 'error');
    return;
  }

  // Zaten var mı?
  if (state.sources.some((s) => s.url === resolved.url)) {
    setHint('Bu kaynak zaten ekli.', 'error');
    return;
  }

  // Başlık, resolveInput'un döndürdüğü parse sonucundan gelir — ikinci fetch YOK.
  const title = resolved.parsed.title || hostname(resolved.url);
  const source = {
    id: uid(),
    title,
    url: resolved.url,
    type: resolved.type,
    site: hostname(resolved.url),
    // Seçili kategori; "Kategorisiz" ise boş sakla (kategori türetildiği için).
    category: pendingCategory === UNCATEGORIZED ? '' : pendingCategory,
    // YouTube'da otomatik kanal avatarı (varsa); RSS'te boş. Ayarlar'dan değiştirilir/kaldırılır.
    icon: sanitizeIcon(resolved.icon),
  };
  state.sources.push(source);
  // Daha önce silinmiş bir url yeniden ekleniyorsa tombstone'dan çıkar
  // (aksi halde birleştirmede tekrar ayıklanırdı).
  state.deleted.delete(source.url);
  persist();
  setHint('Eklendi: ' + source.title, '');
  $('#addInput').value = '';

  // Bekleyen kategoriyi varsayılana döndür.
  pendingCategory = UNCATEGORIZED;
  updateChooserLabel();

  renderSources();
  renderSettings();              // Ayarlar açıksa yeni kaynak listede belirsin
  await refresh();               // yeni kaynağı akışa kat (tek merkezi çekme noktası)
}

function removeSource(id) {
  const gone = state.sources.find((s) => s.id === id);
  state.sources = state.sources.filter((s) => s.id !== id);
  // Tombstone: silmenin buluta yansıması ve union'la geri gelmemesi için url'yi işaretle.
  if (gone && gone.url) state.deleted.add(gone.url);
  if (state.filter === id) state.filter = 'all';
  persist();
  renderSources();
  renderSettings();   // Ayarlar listesi de güncellensin
  rebuildFeed();
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return url; }
}

/* --------------------------------------------------------------------------
   KATEGORİLER — ayrı liste tutulmaz; kaynakların category alanından türetilir.
   Boş/eksik category → otomatik "Kategorisiz". Karşılaştırma büyük/küçük harf
   duyarsız; görüntüde kullanıcının yazdığı hal korunur.
   (UNCATEGORIZED sabiti en üstte CONFIG yanında tanımlıdır.)
   -------------------------------------------------------------------------- */

// Bir kaynağın etkin kategori adı (görüntülenecek hali).
function effCat(source) {
  const t = source && source.category ? String(source.category).trim() : '';
  return t || UNCATEGORIZED;
}

// Kaynakları kategoriye göre grupla. Dönüş: [{ name, key, sources[] }] — "Kategorisiz" sonda.
function categoryGroups() {
  const map = new Map();   // key(lowercase) -> { name, key, sources }
  state.sources.forEach((s) => {
    const name = effCat(s);
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { name, key, sources: [] });
    map.get(key).sources.push(s);
  });
  const uncat = UNCATEGORIZED.toLowerCase();
  // Stabil sıralama: "Kategorisiz" en sona, diğerleri ilk görülme sırasında.
  return [...map.values()].sort((a, b) =>
    a.key === uncat ? 1 : b.key === uncat ? -1 : 0
  );
}

// Bir kategorideki tüm kaynakların okunmamış toplamı.
function unreadForCategory(name) {
  const key = name.toLowerCase();
  const ids = new Set(state.sources.filter((s) => effCat(s).toLowerCase() === key).map((s) => s.id));
  return state.items.filter((it) => ids.has(it.sourceId) && !state.read.has(it.id)).length;
}

// Seçili filtreye göre toolbar başlığı.
function currentFilterTitle() {
  if (state.filter === 'all') return 'Hepsi';
  if (state.filter && state.filter.type === 'category') return state.filter.name;
  const s = state.sources.find((x) => x.id === state.filter);
  return s ? s.title : 'Hepsi';
}

// Filtre artık geçersizse (kategori/kaynak yok olduysa) "Hepsi"ye düş.
function ensureValidFilter() {
  if (state.filter === 'all') return;
  if (state.filter && state.filter.type === 'category') {
    const key = state.filter.name.toLowerCase();
    if (!state.sources.some((s) => effCat(s).toLowerCase() === key)) state.filter = 'all';
    return;
  }
  if (!state.sources.some((s) => s.id === state.filter)) state.filter = 'all';
}

/* --------------------------------------------------------------------------
   ÇEKME + BİRLEŞTİRME
   -------------------------------------------------------------------------- */
async function refresh() {
  if (state.loading) return;
  hideUndoToast();               // yenilemeyle bağlam değişiyor → geri-al balonunu kapat
  state.loading = true;
  renderState();

  // Tüm kaynakları PARALEL çek; biri patlarsa diğerleri etkilenmesin.
  const results = await Promise.allSettled(
    state.sources.map(async (s) => {
      const text = await fetchViaProxy(s.url);
      const parsed = parseFeed(text, s.url);
      return parsed.items
        .slice(0, CONFIG.MAX_ITEMS_PER_SOURCE)
        .map((it) => ({ ...it, sourceId: s.id, sourceTitle: s.title, sourceType: s.type }));
    })
  );

  const merged = [];
  results.forEach((r) => {
    if (r.status === 'fulfilled') merged.push(...r.value);
    // reddedilenler sessizce atlanır — uygulama çökmez
  });

  // Tarihe göre ters kronolojik; tarihsizler sona.
  merged.sort((a, b) => {
    const ta = a.date ? a.date.getTime() : 0;
    const tb = b.date ? b.date.getTime() : 0;
    return tb - ta;
  });

  state.items = merged.slice(0, CONFIG.MAX_ITEMS_TOTAL);
  state.loading = false;

  // Başarılı yenilenme zamanını sakla (bellek + localStorage).
  state.lastRefreshed = Date.now();
  Store.set('mecra.lastRefreshed', state.lastRefreshed);

  rebuildFeed();

  // Yeni videoların Short/uzun türünü arka planda öğren (akışı bloklamaz).
  ensureShortKinds();
}

// Ağ çekmeden mevcut öğelerden akışı yeniden çiz (filtre/silme sonrası).
function rebuildFeed() {
  renderSources();
  renderFeed();
  renderState();
}

/* --------------------------------------------------------------------------
   OKUNDU İŞARETLEME
   -------------------------------------------------------------------------- */
function markRead(id) {
  if (!state.read.has(id)) {
    state.read.add(id);
    persist();
    refreshSidebarState();   // yalnız sayaçları güncelle (listeyi yıkma → iOS repaint güvenli)
  }
}
function markAllRead() {
  // Yalnız gerçekten okunmamış olanları işaretle → geri al bunları geri getirsin.
  const newly = visibleItems().filter((it) => !state.read.has(it.id)).map((it) => it.id);
  newly.forEach((id) => state.read.add(id));
  persist();
  rebuildFeed();
  showUndoToast(newly);
}

/* --------------------------------------------------------------------------
   GERİ AL BALONU (undo) — yanlışlıkla okundu yapılanı kısa süre geri getirme
   Tek dokunuş, seçimle toplu ve "Tümünü okundu" yolları için ortak.
   Batch: en son okundu yapılan id'ler; süre dolunca ya da Geri al'dan sonra düşer.
   -------------------------------------------------------------------------- */
const UNDO_MS = 5000;    // balonun ekranda kalma süresi
let _undoBatch = null;   // en son okundu yapılan id listesi (geri alınabilir)
let _undoTimer = null;

function showUndoToast(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  _undoBatch = list;
  const msg = $('#undoMsg');
  if (msg) msg.textContent = list.length === 1 ? 'Okundu işaretlendi' : `${list.length} öğe okundu`;
  const el = $('#undoToast');
  if (!el) return;
  el.hidden = false;
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(hideUndoToast, UNDO_MS);
}

function hideUndoToast() {
  clearTimeout(_undoTimer);
  _undoTimer = null;
  _undoBatch = null;                 // pencere kapandı → artık geri alınamaz
  const el = $('#undoToast');
  if (el) el.hidden = true;
}

function undoLastRead() {
  const ids = _undoBatch;
  if (!ids || !ids.length) { hideUndoToast(); return; }
  ids.forEach((id) => state.read.delete(id));   // okundu işaretini kaldır → öğeler geri gelir
  persist();
  hideUndoToast();
  rebuildFeed();                     // sidebar sayaçları + akış tazelensin
}
function unreadCount(sourceId) {
  return state.items.filter(
    (it) => (sourceId === 'all' || it.sourceId === sourceId) && !state.read.has(it.id)
  ).length;
}

/* --------------------------------------------------------------------------
   SEÇİM MODU — bir karta basılı tut → çoklu seç → seçilenleri okundu yap
   Amaç: YouTube'da (ya da başka yerde) zaten izlediğin videoların kartlarını
   linke gidip dönmeden toplu "okundu" yapmak.
   Seçim geçici bir arayüz durumudur: akış her yeniden çizildiğinde sıfırlanır.
   -------------------------------------------------------------------------- */

// Bir kartı akıştan yumuşakça çıkar (daralt + solar). Tek tık ve toplu okundu ortak kullanır.
function dissolveCard(a) {
  a.style.maxHeight = a.offsetHeight + 'px';
  void a.offsetHeight;                 // reflow → daralma animasyonu tetiklensin
  a.classList.add('leaving');
  setTimeout(() => { a.remove(); renderState(); }, 340);
}

// Seçim durumunu tamamen sıfırla (mod kapalı, seçim boş, çubuk gizli).
function resetSelection() {
  state.selectMode = false;
  state.selected.clear();
  document.body.classList.remove('selecting');
  const bar = $('#selectBar');
  if (bar) bar.hidden = true;
}

// Seçim modundan çık: ekrandaki vurguları da temizle (akış YIKILMADAN — Vazgeç/ESC yolu).
function exitSelectMode() {
  const feed = $('#feed');
  if (feed) feed.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  resetSelection();
}

// Seçim moduna gir ve tetikleyen kartı seç.
function enterSelectMode(id, cardEl) {
  hideUndoToast();               // seçim başlarken varsa eski geri-al balonunu kaldır
  state.selectMode = true;
  document.body.classList.add('selecting');
  state.selected.clear();
  state.selected.add(id);
  cardEl.classList.add('selected');
  $('#selectBar').hidden = false;
  updateSelectBar();
}

// Bir kartın seçimini aç/kapat (seçim modunda tıklama).
function toggleSelect(id, cardEl) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
    cardEl.classList.remove('selected');
  } else {
    state.selected.add(id);
    cardEl.classList.add('selected');
  }
  updateSelectBar();
}

// Seçim çubuğundaki sayaç + "Okundu yap" butonunun etkinliğini güncelle.
function updateSelectBar() {
  const n = state.selected.size;
  const cnt = $('#selCount');
  if (cnt) cnt.textContent = n + ' seçili';
  const btn = $('#btnSelMarkRead');
  if (btn) btn.disabled = n === 0;
}

// Seçilenleri okundu işaretle, kartlarını akıştan çıkar, seçim modunu kapat.
function markSelectedRead() {
  const ids = [...state.selected];
  if (!ids.length) return;
  ids.forEach((id) => state.read.add(id));
  persist();
  // Seçili kartları yumuşakça çıkar (vurgu halkasını önce kaldır ki temiz görünsün).
  $('#feed').querySelectorAll('.card.selected').forEach((c) => {
    c.classList.remove('selected');
    dissolveCard(c);
  });
  resetSelection();
  refreshSidebarState();   // okunmamış sayaçları güncelle (listeyi yıkma)
  showUndoToast(ids);
}

/* --------------------------------------------------------------------------
   RENDER
   -------------------------------------------------------------------------- */
// Bir öğe Short mü? Yalnız türü bilinen ('short' olarak işaretlenmiş) YouTube
// videoları Short sayılır; yazılar ve türü henüz bilinmeyen videolar 'content' tarafında.
function ytKindOf(it) {
  if (!it || it.sourceType !== 'youtube' || !it.videoId) return 'content';
  return state.ytKind[it.videoId] === 'short' ? 'short' : 'content';
}

// Akışta hiç YouTube öğesi var mı? (Yoksa Short/İçerik sekmesi anlamsız → gizlenir.)
function hasYouTubeItems() {
  return state.items.some((it) => it.sourceType === 'youtube');
}

// "Hepsi" alt sekmeleri (İçerik/Shorts) etkin mi? Yalnız 'Hepsi' görünümünde ve
// akışta YouTube öğesi varken. Değilse ayrım yapılmaz (her şey tek akışta).
function allTabsActive() {
  return state.filter === 'all' && hasYouTubeItems();
}

function visibleItems() {
  // Seçili filtre: Hepsi / kategori / tek kaynak
  if (state.filter === 'all') {
    if (!allTabsActive()) return state.items;
    // 'Hepsi' → aktif alt sekmeye göre böl (Shorts ↔ İçerik).
    const wantShort = state.allTab === 'shorts';
    return state.items.filter((it) => (ytKindOf(it) === 'short') === wantShort);
  }
  if (state.filter && state.filter.type === 'category') {
    // Kategorinin tüm kaynakları birleşik (sıra korunur)
    const key = state.filter.name.toLowerCase();
    const ids = new Set(
      state.sources.filter((s) => effCat(s).toLowerCase() === key).map((s) => s.id)
    );
    return state.items.filter((it) => ids.has(it.sourceId));
  }
  // Tek kaynak
  return state.items.filter((it) => it.sourceId === state.filter);
}

// Sidebar akordeonunda "name" kategorisi açık mı? (büyük/küçük duyarsız)
function isExpanded(name) {
  return !!(state.expandedCategory &&
    state.expandedCategory.toLowerCase() === (name || '').toLowerCase());
}

// Açık kategori artık yoksa (tüm kaynakları silindi/taşındı) durumu sıfırla.
function clampExpanded() {
  if (!state.expandedCategory) return;
  const key = state.expandedCategory.toLowerCase();
  if (!state.sources.some((s) => effCat(s).toLowerCase() === key)) state.expandedCategory = null;
}

// SIDEBAR (filtre) — sade: "Hepsi" + kategori akordeonları. Aksiyon ikonu YOK.
function renderSources() {
  ensureValidFilter();               // yok olan kategori/kaynak seçiliyse "Hepsi"ye düş
  clampExpanded();
  const nav = $('#sourceList');
  if (!nav) return;
  nav.textContent = '';              // güvenli temizlik

  // "Hepsi" satırı (grupsuz, en üstte) — Ayarlar'dan yüklenmiş özel simge varsa onu göster.
  nav.appendChild(sourceRow({
    id: 'all',
    title: 'Hepsi',
    kind: 'all',
    count: unreadCount('all'),
    active: state.filter === 'all',
    source: state.allIcon ? { icon: state.allIcon } : undefined,
  }));

  // Kategoriye göre gruplar (her biri akordeon)
  categoryGroups().forEach((group) => {
    nav.appendChild(categoryHeader(group));

    // Akordeon gövdesi: grid 0fr↔1fr ile yumuşak aç/kapat
    const body = document.createElement('div');
    body.className = 'cat-body' + (isExpanded(group.name) ? ' open' : '');
    body.dataset.cat = group.key;
    const inner = document.createElement('div');
    inner.className = 'cat-body-inner';
    group.sources.forEach((s) => {
      inner.appendChild(sourceRow({
        id: s.id,
        title: s.title,
        kind: s.type === 'youtube' ? 'yt' : 'rss',
        count: unreadCount(s.id),
        active: state.filter === s.id,
        source: s,           // simge rozeti için (aksiyon ikonu için değil)
        nested: true,        // grup altında girintili
      }));
    });
    body.appendChild(inner);
    nav.appendChild(body);
  });

  // Toolbar başlığı + akıştaki büyük başlık seçili filtreye göre
  const title = currentFilterTitle();
  $('#toolbarTitle').textContent = title;
  $('#largeTitle').textContent = title;
}

// Kenar çubuğunu YIKMADAN güncelle: yalnız aktif satır (.active), akordeon
// açık/kapalı durumu (ok rotasyonu dahil) ve okunmamış sayaç rozetleri değişir.
// Yapı (kaynak/kategori ekle-sil) değişmediği sürece bunu kullan — böylece hem
// dokunmatikte focus/hit-test bozulmaz hem de iOS cam panel repaint sorunu olmaz.
// (Yapı değişince tam kurulum için renderSources() çağır.)
function refreshSidebarState() {
  ensureValidFilter();
  clampExpanded();
  const nav = $('#sourceList');
  if (!nav) return;

  // "Hepsi" + tek kaynak satırları: aktiflik + okunmamış sayacı
  nav.querySelectorAll('.source-item').forEach((row) => {
    const id = row.dataset.id;
    row.classList.toggle('active', state.filter === id);   // 'all' de string eşleşir

    const badge = row.querySelector('.source-count');
    if (badge) {
      const c = unreadCount(id);          // 'all' → tümü; diğerleri kaynak id
      badge.textContent = c > 99 ? '99+' : String(c);
      badge.classList.toggle('has', c > 0);
    }
  });

  // Kategori başlıkları: aktiflik + akordeon durumu (ok) + kategori sayacı
  nav.querySelectorAll('.cat-header').forEach((row) => {
    const key = row.dataset.cat;
    const active =
      state.filter && state.filter.type === 'category' &&
      state.filter.name.toLowerCase() === key;
    row.classList.toggle('active', active);
    row.classList.toggle('expanded', isExpanded(row.dataset.name));

    const badge = row.querySelector('.source-count');
    if (badge) {
      const c = unreadForCategory(row.dataset.name);
      badge.textContent = c > 99 ? '99+' : String(c);
      badge.classList.toggle('has', c > 0);
    }
  });

  // Akordeon gövdeleri: yalnız açık kategorininki genişler
  nav.querySelectorAll('.cat-body').forEach((body) => {
    body.classList.toggle('open',
      !!(state.expandedCategory && state.expandedCategory.toLowerCase() === body.dataset.cat));
  });

  // Başlıklar seçili filtreye göre
  const title = currentFilterTitle();
  $('#toolbarTitle').textContent = title;
  $('#largeTitle').textContent = title;

  // 'Hepsi' alt sekme sayaçları (okundu değişince güncellensin)
  renderAllTabs();
}

// Kategori grup başlığı — tek tıkla hem akordeonu aç/kapat hem akışı filtrele.
function categoryHeader(group) {
  const active =
    state.filter && state.filter.type === 'category' &&
    state.filter.name.toLowerCase() === group.key;
  const expanded = isExpanded(group.name);

  const row = document.createElement('button');
  row.className = 'cat-header' + (active ? ' active' : '') + (expanded ? ' expanded' : '');
  row.type = 'button';
  row.dataset.cat = group.key;    // kısmi güncelleme için (lowercase anahtar)
  row.dataset.name = group.name;  // sayaç hesabı unreadForCategory(name) ister

  const name = document.createElement('span');
  name.className = 'cat-header-name';
  name.textContent = group.name;
  row.appendChild(name);

  const c = unreadForCategory(group.name);
  const badge = document.createElement('span');
  badge.className = 'source-count' + (c > 0 ? ' has' : '');
  badge.textContent = c > 99 ? '99+' : String(c);
  row.appendChild(badge);

  // Sağda akordeon oku (kapalı → ›, açık → 90° dönüp aşağı)
  const chev = document.createElement('span');
  chev.className = 'cat-chevron';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '›';
  row.appendChild(chev);

  row.addEventListener('click', () => {
    if (isExpanded(group.name)) {
      // Aynı kategoriye tekrar dokunuş → akordeonu kapat + akışı "Hepsi"ye döndür.
      // Gerekçe: açık kategori == filtrelenen kategori; hiçbiri açık değilse Hepsi.
      // Böylece "açık akordeon" ile "filtre" daima kilitli (tutarlı, sürprizsiz).
      state.expandedCategory = null;
      state.filter = 'all';
    } else {
      // Tek değişken tutulduğu için önceki kategori otomatik kapanır.
      state.expandedCategory = group.name;
      state.filter = { type: 'category', name: group.name };
    }
    refreshSidebarState();   // DOM'u yıkmadan aç/kapat + aktif + sayaç
    renderFeed();
    // Çekmece açık kalsın: kullanıcı açılan akordeondan alt kaynağı seçebilsin.
  });

  return row;
}

// Kaynak rozeti: simge (icon) varsa yuvarlak <img>, yoksa harf/▶ noktası.
// Hem sidebar hem Ayarlar satırlarında kullanılır (geriye dönük uyumlu).
function sourceBadgeEl(source, kind, title) {
  if (source && source.icon) {
    const img = document.createElement('img');
    img.className = 'source-icon';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = source.icon;
    img.alt = '';
    // Simge yüklenmezse harf rozetine düş (kırık görsel kalmasın).
    img.addEventListener('error', () => {
      if (img.parentNode) img.parentNode.replaceChild(makeDot(kind, title), img);
    });
    return img;
  }
  return makeDot(kind, title);
}
function makeDot(kind, title) {
  const dot = document.createElement('span');
  dot.className = 'source-dot ' + (kind === 'yt' ? 'yt' : kind === 'all' ? 'all' : '');
  dot.textContent = kind === 'yt' ? '▶' : kind === 'all' ? '' : ((title && title[0]) || '?').toUpperCase();
  return dot;
}

// SIDEBAR kaynak satırı — sadece rozet + isim + sayaç; tıklayınca yalnız filtreler.
// (Kategori değiştir / sil / simge aksiyonları Ayarlar'daki yönetim satırındadır.)
function sourceRow({ id, title, kind, count, active, source, nested }) {
  const row = document.createElement('button');
  row.className = 'source-item' + (active ? ' active' : '') + (nested ? ' nested' : '');
  row.type = 'button';
  row.dataset.id = String(id);   // kısmi güncelleme (refreshSidebarState) için kimlik

  row.appendChild(sourceBadgeEl(source, kind, title));

  const name = document.createElement('span');
  name.className = 'source-name';
  name.textContent = title;
  row.appendChild(name);

  const badge = document.createElement('span');
  badge.className = 'source-count' + (count > 0 ? ' has' : '');
  badge.textContent = count > 99 ? '99+' : String(count);
  row.appendChild(badge);

  // Filtreye tıkla
  row.addEventListener('click', () => {
    state.filter = id;
    refreshSidebarState();   // yapı değişmez → listeyi yıkma (focus/iOS repaint güvenli)
    renderFeed();
    closeSidebar();     // mobilde seçince kapan
  });

  return row;
}

/* --------------------------------------------------------------------------
   AYARLAR — tam ekran yönetim sayfası (ekleme + kaynak yönetimi + yedek + senkron)
   -------------------------------------------------------------------------- */

// 'Hepsi' satırının sanal simge hedefi: kaynak simge menüsünü (URL / cihazdan yükle /
// kaldır) aynen kullanabilmek için source-benzeri bir nesne. .icon → state.allIcon.
function allIconTarget() {
  return {
    type: 'all',
    title: 'Hepsi',
    get icon() { return state.allIcon; },
    set icon(v) { state.allIcon = v || ''; },
  };
}

// Ayarlar'daki '«Hepsi» simgesi' önizleme rozetini güncelle (simge yoksa nokta).
function updateAllIconPreview() {
  const badge = $('#allIconBadge');
  if (!badge) return;
  badge.textContent = '';
  const src = state.allIcon ? { icon: state.allIcon } : undefined;
  badge.appendChild(sourceBadgeEl(src, 'all', 'Hepsi'));
}

// Ayarlar'daki kaynak yönetim listesi: kategoriye göre gruplu düz liste (akordeon YOK).
function renderSettings() {
  updateChannelsCount();            // "Kanallar" butonundaki sayı her zaman güncel kalsın
  updateAllIconPreview();           // «Hepsi» simgesi önizlemesi güncel kalsın
  const list = $('#settingsList');
  if (!list) return;
  list.textContent = '';

  if (state.sources.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-empty';
    empty.textContent = 'Henüz kaynak yok. Yukarıdaki kutudan ekleyebilirsin.';
    list.appendChild(empty);
    return;
  }

  categoryGroups().forEach((group) => {
    const title = document.createElement('div');
    title.className = 'settings-group-title';
    title.textContent = group.name;
    list.appendChild(title);
    group.sources.forEach((s) => list.appendChild(settingsSourceRow(s)));
  });
}

// Ayarlar kaynak satırı (yönetim): simge kutusu + isim + kategori değiştir + sil.
function settingsSourceRow(source) {
  const row = document.createElement('div');
  row.className = 'settings-row';

  // Simge kutusu — tıklanınca simge menüsü (URL / cihazdan yükle / kaldır)
  const iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.className = 'settings-icon';
  iconBtn.setAttribute('aria-label', 'Simge değiştir');
  iconBtn.title = 'Simge';
  iconBtn.appendChild(sourceBadgeEl(source, source.type === 'youtube' ? 'yt' : 'rss', source.title));
  iconBtn.addEventListener('click', () => openIconMenu(source));
  row.appendChild(iconBtn);

  const name = document.createElement('span');
  name.className = 'settings-name';
  name.textContent = source.title;
  row.appendChild(name);

  // Yönetim menüsü (⋯) — tıklanınca düzenle/sil sayfası açılır
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'settings-menu';
  menuBtn.setAttribute('aria-label', 'Kaynağı düzenle');
  menuBtn.title = 'Düzenle';
  menuBtn.textContent = '⋯';
  menuBtn.addEventListener('click', () => openManageMenu(source));
  row.appendChild(menuBtn);

  return row;
}

/* --------------------------------------------------------------------------
   KAYNAK YÖNETİM MENÜSÜ — düzenle/sil (isim, simge, kategori, sil)
   Simge menüsüyle aynı görsel dilde, alttan kayan sayfa.
   -------------------------------------------------------------------------- */
function openManageMenu(source) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap icon-menu';   // 'icon-menu' → global ESC'i çakıştırmasın

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  wrap.appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Kaynağı düzenle');

  const grip = document.createElement('div');
  grip.className = 'sheet-grip';
  sheet.appendChild(grip);
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = source.title;
  sheet.appendChild(title);

  const listEl = document.createElement('div');
  listEl.className = 'sheet-list';

  const close = () => {
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 300);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  // a) İsmi değiştir
  listEl.appendChild(iconMenuItem('İsmi değiştir', () => {
    close();
    const name = prompt('Kaynak adı:', source.title);
    if (name && name.trim()) {
      source.title = name.trim();
      persist();
      renderSettings();
      renderSources();
      renderFeed();
    }
  }));

  // b) Simgeyi değiştir → mevcut simge menüsünü aç
  listEl.appendChild(iconMenuItem('Simgeyi değiştir', () => {
    close();
    openIconMenu(source);
  }));

  // c) Kategori değiştir
  listEl.appendChild(iconMenuItem('Kategori değiştir', async () => {
    close();
    const picked = await openCategorySheet(effCat(source));
    if (picked !== null) {
      source.category = picked === UNCATEGORIZED ? '' : picked;   // "Kategorisiz" → boş
      persist();
      ensureValidFilter();
      renderSettings();
      renderSources();
      renderFeed();
    }
  }));

  // d) Kaynağı sil (tehlikeli)
  listEl.appendChild(iconMenuItem('Kaynağı sil', () => {
    close();
    if (confirm(`"${source.title}" kaynağı silinsin mi?`)) removeSource(source.id);
  }, true));

  sheet.appendChild(listEl);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Vazgeç';
  cancel.addEventListener('click', close);
  sheet.appendChild(cancel);

  wrap.appendChild(sheet);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
}

function openSettings() {
  renderSettings();
  const v = $('#settings');
  v.hidden = false;
  requestAnimationFrame(() => v.classList.add('open'));   // sağdan kayış animasyonu
}
function closeSettings() {
  const v = $('#settings');
  v.classList.remove('open');
  setTimeout(() => { v.hidden = true; }, 380);   // kayış bitince gizle
  renderSources();   // ekleme/silme/kategori/simge değişiklikleri sidebar'a yansısın
}
function settingsOpen() {
  return !$('#settings').hidden;
}

// Kanallar sayfası (Ayarlar üstünde açılan ayrı tam-ekran görünüm)
function openChannels() {
  renderSettings();                 // kaynak listesini kur (#settingsList kanallar sayfasında)
  const v = $('#channels');
  v.hidden = false;
  requestAnimationFrame(() => v.classList.add('open'));   // sağdan kayış animasyonu
}
function closeChannels() {
  const v = $('#channels');
  v.classList.remove('open');
  setTimeout(() => { v.hidden = true; }, 380);   // kayış bitince gizle
  renderSources();   // ekleme/silme/kategori/simge değişiklikleri sidebar'a yansısın
}
function channelsOpen() {
  return !$('#channels').hidden;
}

// "Kanallar" butonundaki kaynak sayısını güncelle.
function updateChannelsCount() {
  const el = $('#channelsCount');
  if (el) el.textContent = state.sources.length;
}

/* --------------------------------------------------------------------------
   KAYNAK SİMGESİ — menü (URL / cihazdan yükle / kaldır) + görsel küçültme
   -------------------------------------------------------------------------- */
let _iconTarget = null;   // "Cihazdan yükle" için hedef kaynak (dosya seçici geri dönüşü)

// Simge menüsü — kategori sheet'iyle aynı görsel dilde, dinamik alttan kayan sayfa.
function openIconMenu(source) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap icon-menu';   // 'icon-menu' → global ESC'i çakıştırmasın

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  wrap.appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Simge');

  const grip = document.createElement('div');
  grip.className = 'sheet-grip';
  sheet.appendChild(grip);
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = 'Simge';
  sheet.appendChild(title);

  const listEl = document.createElement('div');
  listEl.className = 'sheet-list';

  const close = () => {
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 300);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  // a) URL yapıştır
  listEl.appendChild(iconMenuItem('Bağlantı (URL) yapıştır', () => {
    close();
    const cur = source.icon && /^https?:/i.test(source.icon) ? source.icon : '';
    const url = prompt('Görsel adresi (URL):', cur);
    if (url && url.trim()) applyIconUrl(source, url.trim());
  }));

  // b) Cihazdan yükle (dosya seçici → küçült → data URL)
  listEl.appendChild(iconMenuItem('Cihazdan yükle', () => {
    close();
    _iconTarget = source;
    $('#iconFile').click();
  }));

  // c) Kaldır (yalnız simge varsa)
  if (source.icon) {
    listEl.appendChild(iconMenuItem('Simgeyi kaldır', () => {
      close();
      source.icon = '';
      persist();
      renderSettings();
      renderSources();
    }, true));
  }

  sheet.appendChild(listEl);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Vazgeç';
  cancel.addEventListener('click', close);
  sheet.appendChild(cancel);

  wrap.appendChild(sheet);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
}

function iconMenuItem(label, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sheet-item' + (danger ? ' danger' : '');
  const lbl = document.createElement('span');
  lbl.textContent = label;
  b.appendChild(lbl);
  b.addEventListener('click', onClick);
  return b;
}

// URL simgesini uygula (http(s) ya da data:image). Boyut sınırı yalnız data URL için.
function applyIconUrl(source, url) {
  if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
    setHint('Simge adresi http(s) ya da data:image olmalı.', 'error');
    return;
  }
  if (/^data:/i.test(url) && url.length > MAX_ICON_BYTES) {
    setHint('Simge çok büyük (en fazla 40 KB). Daha küçük bir görsel dene.', 'error');
    return;
  }
  source.icon = url;
  persist();
  renderSettings();
  renderSources();
  setHint('Simge güncellendi.', '');
}

// Seçilen görseli 64×64 kare (cover/crop) JPEG data URL'e çevir + boyut sınırına sıkıştır.
// Sonuç MAX_ICON_BYTES üstündeyse reddet (bulut senkronu şişirmesin).
function resizeImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      reject(new Error('geçerli bir görsel değil'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('dosya okunamadı'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('görsel çözümlenemedi'));
      img.onload = () => {
        const SIZE = 64;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        // cover/crop: kısa kenarı kareye sığdır, taşan kısmı ortadan kırp
        const scale = Math.max(SIZE / img.width, SIZE / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);

        // JPEG kalitesini kademeli düşürerek boyut sınırının altına in
        let q = 0.85;
        let url = canvas.toDataURL('image/jpeg', q);
        while (url.length > MAX_ICON_BYTES && q > 0.3) {
          q -= 0.15;
          url = canvas.toDataURL('image/jpeg', q);
        }
        if (url.length > MAX_ICON_BYTES) {
          reject(new Error('resim çok büyük, daha küçük bir tane dene'));
          return;
        }
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// "Hepsi" alt sekmeleri (İçerik/Shorts): görünürlük + aktiflik + okunmamış sayaçları.
function renderAllTabs() {
  const el = $('#allTabs');
  if (!el) return;
  if (!allTabsActive()) { el.hidden = true; return; }
  el.hidden = false;
  const onShorts = state.allTab === 'shorts';
  const cBtn = $('#segContent');
  const sBtn = $('#segShorts');
  cBtn.classList.toggle('active', !onShorts);
  sBtn.classList.toggle('active', onShorts);
  cBtn.setAttribute('aria-selected', String(!onShorts));
  sBtn.setAttribute('aria-selected', String(onShorts));
  setSegCount('#segContentCount', tabUnread(false));
  setSegCount('#segShortsCount', tabUnread(true));
}
function setSegCount(sel, n) {
  const el = $(sel);
  if (el) el.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
}
// Bir alt sekmedeki okunmamış öğe sayısı (wantShort=true → Shorts, false → İçerik).
function tabUnread(wantShort) {
  return state.items.filter(
    (it) => !state.read.has(it.id) && (ytKindOf(it) === 'short') === wantShort
  ).length;
}
// Alt sekmeyi değiştir (İçerik ↔ Shorts).
function setAllTab(tab) {
  if (state.allTab === tab) return;
  state.allTab = tab;
  Store.set('mecra.allTab', tab);
  renderAllTabs();
  renderFeed();
}

function renderFeed() {
  // Akış baştan kuruluyor → eski kart referansları gidiyor; varsa seçim modunu kapat.
  if (state.selectMode) resetSelection();
  renderAllTabs();                 // 'Hepsi' sekmeleri görünür/güncel kalsın
  const feed = $('#feed');
  feed.textContent = '';
  // Okunan öğeler akışta yer kaplamasın (görüldükten sonra kaybolsunlar).
  const items = visibleItems().filter((it) => !state.read.has(it.id));

  for (const it of items) {
    feed.appendChild(card(it));
  }
  renderState();
}

// Tek akış kartı — <a>, innerHTML yok, tüm metin textContent.
// İki tür: video (YouTube) = üstte büyük 16:9 + ▶; yazı (RSS) = metin-odaklı, küçük görsel.
function card(it) {
  const isVideo = it.sourceType === 'youtube';

  const a = document.createElement('a');
  a.className = 'card ' + (isVideo ? 'video' : 'article') + (state.read.has(it.id) ? ' read' : '');
  a.href = it.link || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';   // güvenlik: dış linkler

  if (isVideo && it.thumb) {
    // Video: üstte büyük 16:9 görsel + oynatma göstergesi.
    // Görsel yüklenmezse tüm sarmalayıcıyı kaldır (16:9 boş kutu kalmasın).
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.className = 'card-thumb-lg';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = it.thumb;
    img.alt = '';
    img.addEventListener('error', () => wrap.remove());
    wrap.appendChild(img);
    const play = document.createElement('span');
    play.className = 'play-badge';
    play.textContent = '▶';
    wrap.appendChild(play);
    a.appendChild(wrap);
  } else if (!isVideo && it.thumb) {
    // Yazı: küçük, solda görsel (varsa).
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = it.thumb;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    a.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const h = document.createElement('div');
  h.className = 'card-title';
  h.textContent = it.title;
  body.appendChild(h);

  // Özet: yazı kartlarında öne çıkar; videoda göstermeyiz (video hissi için sade).
  if (!isVideo && it.summary) {
    const p = document.createElement('div');
    p.className = 'card-summary';
    p.textContent = it.summary;
    body.appendChild(p);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const src = document.createElement('span');
  src.className = 'card-source';
  src.textContent = it.sourceTitle || '';
  meta.appendChild(src);

  const time = document.createElement('span');
  time.textContent = it.date ? timeAgo(it.date) : '';
  meta.appendChild(time);

  if (!state.read.has(it.id)) {
    const dot = document.createElement('span');
    dot.className = 'unread-mark';
    dot.title = 'Okunmadı';
    meta.appendChild(dot);
  }
  body.appendChild(meta);
  a.appendChild(body);

  // Seçim modu onay rozeti (sağ üstte; yalnız .card.selected iken görünür).
  const check = document.createElement('span');
  check.className = 'card-check';
  check.setAttribute('aria-hidden', 'true');
  check.textContent = '✓';
  a.appendChild(check);

  // Nadir de olsa yeniden çizim sırasında seçili kalmışsa vurguyu koru.
  if (state.selected.has(it.id)) a.classList.add('selected');

  // --- Basılı tut (long-press) algılama: seçim moduna gir / seçime ekle ---
  const LP_MS = 420;     // basılı tutma eşiği (ms)
  const LP_MOVE = 12;    // bu kadar px kayarsa "kaydırma"dır, iptal et
  let lpTimer = null;
  let lpFired = false;   // basılı tutma bu dokunuşta seçim yaptı mı → click linki açmasın
  let lpX = 0, lpY = 0;
  const clearLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };

  a.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;   // yalnız sol tık/dokunuş
    lpFired = false;
    lpX = e.clientX; lpY = e.clientY;
    clearLp();
    lpTimer = setTimeout(() => {
      lpTimer = null;
      lpFired = true;
      if (!state.selectMode) enterSelectMode(it.id, a);
      else toggleSelect(it.id, a);
    }, LP_MS);
  });
  a.addEventListener('pointermove', (e) => {
    if (!lpTimer) return;
    if (Math.abs(e.clientX - lpX) > LP_MOVE || Math.abs(e.clientY - lpY) > LP_MOVE) clearLp();
  });
  a.addEventListener('pointerup', clearLp);
  a.addEventListener('pointercancel', clearLp);
  // Basılı tutunca çıkan tarayıcı/iOS link menüsünü bastır (seçim için basılı tutuyoruz).
  a.addEventListener('contextmenu', (e) => {
    if (state.selectMode || lpFired) e.preventDefault();
  });

  a.addEventListener('click', (e) => {
    // Basılı tutma seçim yaptıysa bu tıklama linke gitmesin.
    if (lpFired) { e.preventDefault(); lpFired = false; return; }
    // Seçim modunda tıklama = seç/bırak (linke gitme).
    if (state.selectMode) { e.preventDefault(); toggleSelect(it.id, a); return; }
    // Normal: okundu işaretle (link yeni sekmede açılır) + kartı akıştan çıkar.
    markRead(it.id);
    dissolveCard(a);
    showUndoToast([it.id]);
  });

  return a;
}

// Boş / yükleniyor durum kutusu.
// --- Yükleme iskeleti (skeleton) --------------------------------------------
// Statik, kullanıcı verisi içermez → createElement ile kurulur (innerHTML yok).
function skelBlock(cls) {
  const d = document.createElement('div');
  d.className = 'skel ' + cls;
  return d;
}

function skeletonCard(kind) {
  const c = document.createElement('div');
  c.className = 'card ' + kind + ' card--skeleton';
  c.setAttribute('aria-hidden', 'true');

  // Görsel: videoda üstte büyük 16:9, yazıda solda küçük 16:9.
  c.appendChild(skelBlock(kind === 'video' ? 'skel-thumb-lg' : 'skel-thumb'));

  const body = document.createElement('div');
  body.className = 'card-body';
  body.appendChild(skelBlock('skel-line'));       // başlık satırı 1
  body.appendChild(skelBlock('skel-line mid'));   // başlık satırı 2
  if (kind === 'article') body.appendChild(skelBlock('skel-line short')); // özet
  body.appendChild(skelBlock('skel-meta'));       // kaynak · zaman
  c.appendChild(body);
  return c;
}

// Kaynak türlerine göre doğal bir karışım üret (video varsa aralara serpiştir).
function renderSkeletons(feed) {
  feed.textContent = '';
  const hasVideo = state.sources.some((s) => s.type === 'youtube');
  const pattern = hasVideo
    ? ['video', 'article', 'article', 'video', 'article']
    : ['article', 'article', 'article', 'article', 'article'];
  for (const kind of pattern) feed.appendChild(skeletonCard(kind));
}

function renderState() {
  const box = $('#stateBox');
  const feed = $('#feed');

  if (state.loading && state.items.length === 0) {
    // İlk/soğuk yükleme: spinner yerine kart düzeninde parıldayan iskeletler.
    box.hidden = true;
    feed.hidden = false;
    renderSkeletons(feed);
    return;
  }

  feed.hidden = false;

  if (state.sources.length === 0) {
    box.hidden = false;
    box.textContent = '';
    stateMsg(box, 'Henüz kaynak yok', 'Soldaki kutudan bir RSS, site ya da YouTube adresi ekle.');
    return;
  }

  if (visibleItems().length === 0) {
    box.hidden = false;
    box.textContent = '';
    stateMsg(box, 'Öğe yok', state.loading ? 'Yükleniyor…' : 'Bu filtrede gösterilecek bir şey bulunamadı.');
    return;
  }

  box.hidden = true;
}

function stateMsg(box, title, text) {
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.appendChild(h);
  box.appendChild(p);
}

function setHint(msg, kind) {
  const el = $('#addHint');
  el.textContent = msg;
  el.className = 'add-hint' + (kind ? ' ' + kind : '');
}

/* --------------------------------------------------------------------------
   ÇEKMECE (mobil) aç/kapa
   -------------------------------------------------------------------------- */
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
}

/* --------------------------------------------------------------------------
   AŞAĞI ÇEK-YENİLE (pull-to-refresh) — mobil, hafif
   Akışın en üstündeyken (scrollY<=0) parmakla aşağı çekince refresh tetikler.
   -------------------------------------------------------------------------- */
function setupPullToRefresh() {
  const ptr = $('#ptr');
  const THRESHOLD = 70;    // tetikleme eşiği (px)
  const MAX = 120;         // görsel maksimum çekiş
  const DAMP = 0.5;        // direnç: gerçek mesafenin yarısı kadar hareket

  let startY = 0;
  let dist = 0;
  let pulling = false;

  // Göstergeyi başlangıç konumuna al.
  function resetPtr() {
    ptr.classList.remove('spinning');
    ptr.classList.add('snap');           // yumuşak geri dönüş
    ptr.style.opacity = '0';
    ptr.style.transform = 'translateY(-24px) scale(0.8)';
    setTimeout(() => ptr.classList.remove('snap'), 320);
  }

  window.addEventListener('touchstart', (e) => {
    // Pull-to-refresh YALNIZ ana feed alanında çalışsın. Sidebar/sheet
    // içindeki dokunuşta devreye girmesin; yoksa touchmove'daki preventDefault
    // o panellerin doğal kaydırmasını kilitler ("yenilendikten sonra kaymıyor").
    if ($('#sidebar').classList.contains('open') ||
        (e.target && e.target.closest &&
         e.target.closest('.sidebar, .sheet-wrap'))) {
      pulling = false;
      return;
    }

    // Sadece en üstteyken, tek parmakla, yükleme yokken başlat.
    if (state.loading || window.scrollY > 0 || e.touches.length !== 1) {
      pulling = false;
      return;
    }
    startY = e.touches[0].clientY;
    dist = 0;
    pulling = true;
    ptr.classList.remove('snap');        // takip sırasında geçiş olmasın
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) return;               // yukarı hareket → normal kaydırma

    const pulled = Math.min(MAX, dist * DAMP);
    const progress = Math.min(1, pulled / THRESHOLD);
    ptr.style.opacity = String(progress);
    ptr.style.transform =
      `translateY(${pulled}px) scale(${0.8 + progress * 0.2}) rotate(${pulled * 2.6}deg)`;

    // Yalnız aktif çekişte sayfa kaymasını/overscroll'u engelle.
    if (window.scrollY <= 0 && e.cancelable) e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;

    const pulled = Math.min(MAX, dist * DAMP);
    if (pulled >= THRESHOLD && !state.loading) {
      // Eşiği geçti → yenile. Spinner'ı eşik konumunda tut, bitince gizle.
      ptr.classList.add('snap', 'spinning');
      ptr.style.opacity = '1';
      ptr.style.transform = `translateY(${THRESHOLD}px) scale(1)`;
      Promise.resolve(refresh()).finally(resetPtr);
    } else {
      resetPtr();
    }
  });
}

/* --------------------------------------------------------------------------
   KATEGORİ ALT SAYFASI (action sheet) — hem ekleme seçici hem satır değiştir
   openCategorySheet(current) → Promise<string|null>
     - seçilen kategori adı (UNCATEGORIZED dahil) ya da iptalde null
   -------------------------------------------------------------------------- */
let _sheetResolve = null;

function openCategorySheet(current) {
  return new Promise((resolve) => {
    _sheetResolve = resolve;
    // Açılışta "Yeni kategori" alanını kapalı başlat (temiz durum).
    $('#sheetNewForm').hidden = true;
    $('#sheetNewToggle').hidden = false;
    $('#sheetNewInput').value = '';
    buildSheet(current);
    const wrap = $('#sheet');
    wrap.hidden = false;
    // Bir sonraki kareye ertele ki alttan kayış animasyonu tetiklensin.
    requestAnimationFrame(() => wrap.classList.add('open'));
  });
}

function closeSheet(value) {
  const wrap = $('#sheet');
  wrap.classList.remove('open');
  setTimeout(() => { wrap.hidden = true; }, 300);   // animasyon bitince gizle
  // "Yeni kategori" formunu sıfırla
  $('#sheetNewForm').hidden = true;
  $('#sheetNewToggle').hidden = false;
  $('#sheetNewInput').value = '';
  const r = _sheetResolve;
  _sheetResolve = null;
  if (r) r(value);
}

// Alt sayfa listesini kur: mevcut kategoriler + her zaman "Kategorisiz".
function buildSheet(current) {
  const list = $('#sheetList');
  list.textContent = '';

  const names = categoryGroups().map((g) => g.name);
  const uncat = UNCATEGORIZED.toLowerCase();
  if (!names.some((n) => n.toLowerCase() === uncat)) names.push(UNCATEGORIZED);
  // "Kategorisiz" en üste
  names.sort((a, b) => (a.toLowerCase() === uncat ? -1 : b.toLowerCase() === uncat ? 1 : 0));

  const curKey = (current || '').toLowerCase();
  names.forEach((name) => {
    const isCur = name.toLowerCase() === curKey;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item' + (isCur ? ' current' : '');

    const lbl = document.createElement('span');
    lbl.textContent = name;
    b.appendChild(lbl);

    if (isCur) {
      const chk = document.createElement('span');
      chk.className = 'sheet-check';
      chk.textContent = '✓';
      b.appendChild(chk);
    }
    b.addEventListener('click', () => closeSheet(name));
    list.appendChild(b);
  });
}

// Ekleme kutusundaki seçili kategori etiketini güncelle.
function updateChooserLabel() {
  $('#catChooserLabel').textContent = pendingCategory;
}

/* --------------------------------------------------------------------------
   OLAY BAĞLAMA + BAŞLATMA
   -------------------------------------------------------------------------- */
function bind() {
  // Marka adını CONFIG'ten yaz (tek yerden değişsin)
  $('#brandName').textContent = CONFIG.APP_NAME;
  document.title = CONFIG.APP_NAME;

  // Kaynak ekleme
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('#addInput').value;
    if (val.trim()) addSource(val);
  });

  // Ekleme kutusu kategori seçici → alt sayfayı aç
  updateChooserLabel();
  $('#catChooser').addEventListener('click', async () => {
    const picked = await openCategorySheet(pendingCategory);
    if (picked !== null) {
      pendingCategory = picked;
      updateChooserLabel();
    }
  });

  // Alt sayfa: "Yeni kategori" alanını aç/gönder, vazgeç, perde
  $('#sheetNewToggle').addEventListener('click', () => {
    $('#sheetNewToggle').hidden = true;
    $('#sheetNewForm').hidden = false;
    $('#sheetNewInput').focus();
  });
  $('#sheetNewForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#sheetNewInput').value.trim();
    closeSheet(v || UNCATEGORIZED);   // boşsa Kategorisiz say
  });
  $('#sheetCancel').addEventListener('click', () => closeSheet(null));
  $('#sheetScrim').addEventListener('click', () => closeSheet(null));

  // Yenile (toolbar + tabbar)
  $('#btnRefresh').addEventListener('click', refresh);
  $('#tabRefresh').addEventListener('click', refresh);

  // "Hepsi" alt sekmeleri: İçerik ↔ Shorts
  $('#segContent').addEventListener('click', () => setAllTab('content'));
  $('#segShorts').addEventListener('click', () => setAllTab('shorts'));

  // Çekmece aç/kapa
  $('#btnOpenSidebar').addEventListener('click', openSidebar);
  $('#tabSources').addEventListener('click', openSidebar);
  $('#btnCloseSidebar').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  // Ayarlar (tam ekran) aç/kapa
  $('#btnOpenSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);

  // Kanallar (tam ekran) aç/kapa — Ayarlar üstünde açılır
  $('#btnOpenChannels').addEventListener('click', openChannels);
  $('#btnCloseChannels').addEventListener('click', closeChannels);

  // «Hepsi» simgesi: satıra dokununca kaynaklardaki simge menüsünü aç (sanal hedef).
  $('#allIconBtn').addEventListener('click', () => openIconMenu(allIconTarget()));

  // Simge: "Cihazdan yükle" dosya seçici geri dönüşü → küçült + uygula
  $('#iconFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';                       // aynı dosya tekrar seçilebilsin
    const source = _iconTarget;
    _iconTarget = null;
    if (!file || !source) return;
    setHint('Simge işleniyor…', 'busy');
    resizeImageToDataUrl(file).then((dataUrl) => {
      source.icon = dataUrl;
      persist();
      renderSettings();
      renderSources();
      setHint('Simge güncellendi.', '');
    }).catch((err) => {
      setHint('Simge yüklenemedi: ' + err.message, 'error');
    });
  });

  // Tümünü okundu say
  $('#tabMarkAll').addEventListener('click', markAllRead);

  // Seçim çubuğu: Vazgeç (moddan çık) / Okundu yap (seçilenleri işaretle)
  $('#btnSelCancel').addEventListener('click', exitSelectMode);
  $('#btnSelMarkRead').addEventListener('click', markSelectedRead);

  // "Geri al" balonu: son okundu işaretini geri getir
  $('#undoBtn').addEventListener('click', undoLastRead);

  // ESC ile açık katmanı kapat (en üstteki katman öncelikli)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Seçim modu açıksa önce ondan çık.
    if (state.selectMode) { exitSelectMode(); return; }
    // Dinamik simge menüsü açıksa onu kendi ESC dinleyicisi kapatır — burada dokunma.
    if (document.querySelector('.sheet-wrap.icon-menu.open')) return;
    if (!$('#sheet').hidden) closeSheet(null);
    else if (channelsOpen()) closeChannels();
    else if (settingsOpen()) closeSettings();
    else closeSidebar();
  });

  // --- Bulut senkron anahtarı ---
  const keyInput = $('#cloudKeyInput');
  keyInput.value = state.cloudKey || '';
  if (syncEnabled()) setCloudStatus('saved');
  // Yazıp odaktan çıkınca (ya da Enter) anahtarı uygula
  keyInput.addEventListener('change', () => setCloudKey(keyInput.value));
  // Rastgele oluştur → alanı doldur + uygula
  $('#cloudGen').addEventListener('click', () => {
    keyInput.value = genCloudKey(20);
    keyInput.type = 'text';                 // yeni anahtarı görülebilir yap
    setCloudKey(keyInput.value);
  });
  // Göster/gizle
  $('#cloudReveal').addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
}

// Eski/yanlış kaydedilmiş kaynakları düzelt: URL'si YouTube olduğu halde tipi
// 'rss' kalmış kanalları 'youtube' yap. Böylece İçerik/Shorts sekmeleri açılır,
// Shorts tespiti çalışır ve kartlar doğru (video) düzende gösterilir.
// Değişiklik varsa kalıcılaştır (bulut senkronuna da yansır).
function migrateSourceTypes() {
  let changed = false;
  state.sources.forEach((s) => {
    if (s && s.type !== 'youtube' && s.url && isYouTube(s.url)) {
      s.type = 'youtube';
      changed = true;
    }
  });
  if (changed) persist();
}

function init() {
  bind();
  migrateSourceTypes();          // kaynak tiplerini düzelt (render'dan önce)
  setupPullToRefresh();
  renderSources();
  renderSettings();
  renderState();

  // Bulut anahtarı varsa açılışta çek + birleştir (sonra akışı yenile).
  if (syncEnabled()) initialSync();

  // Ağ geri gelince bekleyen değişiklikleri buluta yaz.
  window.addEventListener('online', () => schedulePush(true));

  if (state.sources.length) refresh();

  // Service worker (PWA) — sessiz kayıt, hata olsa da uygulama çalışır
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
