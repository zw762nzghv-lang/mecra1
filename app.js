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

  // KV'ye yazma debounce süresi (ms). Hızlı değişiklikler tek yazıya toplanır.
  SYNC_DEBOUNCE_MS: 1500,
};

// Kategorisi boş/eksik kaynakların otomatik grubu (tek yerden değişir).
const UNCATEGORIZED = 'Kategorisiz';

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
  items: [],                                  // birleşik akış
  filter: 'all',                              // 'all' | {type:'category',name} | kaynak id
  search: '',                                 // canlı arama metni (yalnız bellek)
  lastRefreshed: Store.get('mecra.lastRefreshed', 0),  // son başarılı yenilenme (ms)
  loading: false,
};

function persist() {
  Store.set('mecra.sources', state.sources);
  Store.set('mecra.deleted', [...state.deleted]);

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

// Arama için normalize: büyük/küçük + Türkçe karakter duyarsız.
// "İstanbul"→"istanbul", "ışık"→"isik", "ğ/ş/ç/ö/ü"→"g/s/c/o/u".
function foldTr(s) {
  return (s || '')
    .toLowerCase()                                   // I→i, İ→i̇(nokta), Ş→ş...
    .replace(/ı/g, 'i')                              // noktasız ı → i
    .normalize('NFD')                                // ş→s+̧, ö→o+̈ ...
    .replace(/[̀-ͯ]/g, '');                // birleşik diakritikleri sil
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

  persist();   // yerel + ekranı besleyecek; ayrıca push planlar
}

// İçe/buluttan gelen kaynağı güvenli alanlarla normalize et.
function normalizeSource(s) {
  return {
    id: s.id || uid(),
    title: s.title || hostname(s.url),
    url: s.url,
    type: s.type === 'youtube' ? 'youtube' : 'rss',
    site: s.site || hostname(s.url),
    category: s.category ? String(s.category) : '',
  };
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
    return ytFeed(chMatch[1]);
  }

  // 2) @handle / c / user → kanal sayfasını çekip channelId ayıkla
  const html = await fetchViaProxy(url);
  // Sayfa kaynağında "channelId":"UC..." ya da externalId geçer
  const idMatch =
    html.match(/"channelId":"(UC[\w-]{20,})"/) ||
    html.match(/"externalId":"(UC[\w-]{20,})"/) ||
    html.match(/channel_id=(UC[\w-]{20,})/) ||
    html.match(/\/channel\/(UC[\w-]{20,})/);
  if (idMatch) return ytFeed(idMatch[1]);

  throw new Error('YouTube kanal kimliği bulunamadı');
}
function ytFeed(channelId) {
  return {
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId,
  };
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
    const yt = await resolveYouTube(input);        // { type:'youtube', url }
    const parsed = await fetchAndParse(yt.url);
    if (!parsed.isFeed) throw new Error('YouTube feed okunamadı');
    return { type: 'youtube', url: yt.url, parsed };
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
    thumb: extractThumb(el, link),
  };
}

// Küçük görsel çıkar: YouTube videoId → hqdefault, yoksa media:thumbnail/enclosure.
function extractThumb(el, link) {
  if (!el) return '';

  // 1) YouTube: yt:videoId
  const ytId =
    tagText(el, 'videoId') ||
    (link && (link.match(/[?&]v=([\w-]{11})/) || [])[1]) ||
    (link && (link.match(/youtu\.be\/([\w-]{11})/) || [])[1]);
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
    renderSources();   // okunmamış sayaçları güncelle
  }
}
function markAllRead() {
  visibleItems().forEach((it) => state.read.add(it.id));
  persist();
  rebuildFeed();
}
function unreadCount(sourceId) {
  return state.items.filter(
    (it) => (sourceId === 'all' || it.sourceId === sourceId) && !state.read.has(it.id)
  ).length;
}

/* --------------------------------------------------------------------------
   RENDER
   -------------------------------------------------------------------------- */
function visibleItems() {
  // 1) Önce mevcut filtre (Hepsi / kategori / kaynak)
  let items;
  if (state.filter === 'all') {
    items = state.items;
  } else if (state.filter && state.filter.type === 'category') {
    // Kategorinin tüm kaynakları birleşik (sıra korunur)
    const key = state.filter.name.toLowerCase();
    const ids = new Set(
      state.sources.filter((s) => effCat(s).toLowerCase() === key).map((s) => s.id)
    );
    items = state.items.filter((it) => ids.has(it.sourceId));
  } else {
    // Tek kaynak
    items = state.items.filter((it) => it.sourceId === state.filter);
  }

  // 2) Sonra arama daraltır (başlık + özet, Türkçe-duyarsız). Boşsa dokunma.
  const q = foldTr(state.search).trim();
  if (q) {
    items = items.filter(
      (it) => foldTr(it.title).includes(q) || (it.summary && foldTr(it.summary).includes(q))
    );
  }
  return items;
}

function renderSources() {
  ensureValidFilter();               // yok olan kategori/kaynak seçiliyse "Hepsi"ye düş
  const nav = $('#sourceList');
  nav.textContent = '';              // güvenli temizlik

  // "Hepsi" satırı (grupsuz, en üstte)
  nav.appendChild(sourceRow({
    id: 'all',
    title: 'Hepsi',
    kind: 'all',
    count: unreadCount('all'),
    active: state.filter === 'all',
  }));

  // Kategoriye göre gruplar
  categoryGroups().forEach((group) => {
    nav.appendChild(categoryHeader(group));
    group.sources.forEach((s) => {
      nav.appendChild(sourceRow({
        id: s.id,
        title: s.title,
        kind: s.type === 'youtube' ? 'yt' : 'rss',
        count: unreadCount(s.id),
        active: state.filter === s.id,
        deletable: true,
        source: s,           // kategori değiştir butonu için
        nested: true,        // grup altında girintili
      }));
    });
  });

  // Toolbar başlığı + akıştaki büyük başlık seçili filtreye göre
  const title = currentFilterTitle();
  $('#toolbarTitle').textContent = title;
  $('#largeTitle').textContent = title;
}

// Kategori grup başlığı — tıklayınca o kategoriyi filtreler.
function categoryHeader(group) {
  const active =
    state.filter && state.filter.type === 'category' &&
    state.filter.name.toLowerCase() === group.key;

  const row = document.createElement('button');
  row.className = 'cat-header' + (active ? ' active' : '');
  row.type = 'button';

  const name = document.createElement('span');
  name.className = 'cat-header-name';
  name.textContent = group.name;
  row.appendChild(name);

  const c = unreadForCategory(group.name);
  const badge = document.createElement('span');
  badge.className = 'source-count' + (c > 0 ? ' has' : '');
  badge.textContent = c > 99 ? '99+' : String(c);
  row.appendChild(badge);

  row.addEventListener('click', () => {
    state.filter = { type: 'category', name: group.name };
    renderSources();
    renderFeed();
    closeSidebar();
  });

  return row;
}

// Tek kaynak satırı (DOM, innerHTML kullanmadan — güvenli).
function sourceRow({ id, title, kind, count, active, deletable, source, nested }) {
  const row = document.createElement('button');
  row.className = 'source-item' + (active ? ' active' : '') + (nested ? ' nested' : '');
  row.type = 'button';

  const dot = document.createElement('span');
  dot.className = 'source-dot ' + (kind === 'yt' ? 'yt' : kind === 'all' ? 'all' : '');
  dot.textContent = kind === 'yt' ? '▶' : kind === 'all' ? '' : (title[0] || '?').toUpperCase();
  row.appendChild(dot);

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
    renderSources();
    renderFeed();
    closeSidebar();     // mobilde seçince kapan
  });

  // Kategori değiştir (⋯) — alt sayfayı açar
  if (source) {
    const catBtn = document.createElement('span');
    catBtn.className = 'source-cat';
    catBtn.setAttribute('role', 'button');
    catBtn.setAttribute('aria-label', 'Kategori değiştir');
    catBtn.title = 'Kategori değiştir';
    catBtn.textContent = '⋯';
    catBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const picked = await openCategorySheet(effCat(source));
      if (picked !== null) {
        // "Kategorisiz" → boş sakla; diğerleri yazıldığı gibi.
        source.category = picked === UNCATEGORIZED ? '' : picked;
        persist();
        ensureValidFilter();
        rebuildFeed();          // gruplama + akış anında güncellenir
      }
    });
    row.appendChild(catBtn);
  }

  // Silme
  if (deletable) {
    const del = document.createElement('span');
    del.className = 'source-del';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', 'Kaynağı sil');
    del.title = 'Sil';
    del.textContent = '🗑';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();       // filtre tıklamasını tetikleme
      if (confirm(`"${title}" kaynağı silinsin mi?`)) removeSource(id);
    });
    row.appendChild(del);
  }

  return row;
}

function renderFeed() {
  const feed = $('#feed');
  feed.textContent = '';
  const items = visibleItems();

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

  // Tıklayınca okundu işaretle (link yeni sekmede açılır)
  a.addEventListener('click', () => {
    markRead(it.id);
    a.classList.add('read');
    const um = a.querySelector('.unread-mark');
    if (um) um.remove();
  });

  return a;
}

// Boş / yükleniyor durum kutusu.
function renderState() {
  const box = $('#stateBox');
  const feed = $('#feed');

  if (state.loading && state.items.length === 0) {
    feed.hidden = true;
    box.hidden = false;
    box.textContent = '';
    const sp = document.createElement('div');
    sp.className = 'spinner';
    box.appendChild(sp);
    const p = document.createElement('p');
    p.textContent = 'Akış getiriliyor…';
    box.appendChild(p);
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
    if (state.search.trim()) {
      // Arama aktif ama sonuç yok → nazik "eşleşme yok"
      stateMsg(box, 'Eşleşme yok', `"${state.search.trim()}" için sonuç bulunamadı.`);
    } else {
      stateMsg(box, 'Öğe yok', state.loading ? 'Yükleniyor…' : 'Bu filtrede gösterilecek bir şey bulunamadı.');
    }
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
   DIŞA / İÇE AKTAR (JSON yedek)
   -------------------------------------------------------------------------- */
function exportSources() {
  const data = {
    app: CONFIG.APP_NAME,
    version: 2,                    // v2: kaynaklar 'category' alanı içerir
    exportedAt: new Date().toISOString(),
    sources: state.sources,        // category alanı dahil tüm alanlar
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${CONFIG.APP_NAME}-kaynaklar.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSources(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.sources;
      if (!Array.isArray(incoming)) throw new Error('Geçersiz dosya');

      let added = 0;
      incoming.forEach((s) => {
        if (!s || !s.url) return;
        if (state.sources.some((x) => x.url === s.url)) return;   // tekrarı atla
        state.sources.push({
          id: uid(),
          title: s.title || hostname(s.url),
          url: s.url,
          type: s.type === 'youtube' ? 'youtube' : 'rss',
          site: s.site || hostname(s.url),
          // Kategori alanı; eski/eksik kayıtta boş (→ "Kategorisiz").
          category: s.category ? String(s.category) : '',
        });
        added++;
      });
      persist();
      setHint(`${added} kaynak içe aktarıldı.`, '');
      renderSources();
      refresh();
    } catch (e) {
      setHint('İçe aktarma hatası: ' + e.message, 'error');
    }
  };
  reader.readAsText(file);
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
   ARAMA — toolbar'da açılan alan; canlı, filtreyle birlikte çalışır
   -------------------------------------------------------------------------- */
function openSearch() {
  $('#searchBar').hidden = false;
  $('#searchInput').focus();
}
function closeSearch() {
  $('#searchBar').hidden = true;
  $('#searchInput').value = '';
  $('#btnSearchClear').hidden = true;
  state.search = '';
  renderFeed();               // normal akışa dön
}
function onSearchInput() {
  const v = $('#searchInput').value;
  state.search = v;
  $('#btnSearchClear').hidden = !v;
  renderFeed();               // canlı filtre
}
function searchActive() {
  return !$('#searchBar').hidden;
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

  // Arama (toolbar ikonu + alt çubuk sekmesi)
  $('#btnSearch').addEventListener('click', openSearch);
  $('#tabSearch').addEventListener('click', openSearch);
  $('#btnSearchCancel').addEventListener('click', closeSearch);
  $('#searchInput').addEventListener('input', onSearchInput);
  $('#btnSearchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.search = '';
    $('#btnSearchClear').hidden = true;
    $('#searchInput').focus();
    renderFeed();
  });

  // Çekmece aç/kapa
  $('#btnOpenSidebar').addEventListener('click', openSidebar);
  $('#tabSources').addEventListener('click', openSidebar);
  $('#btnCloseSidebar').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  // Tümünü okundu say
  $('#tabMarkAll').addEventListener('click', markAllRead);

  // Dışa / içe aktar
  $('#btnExport').addEventListener('click', exportSources);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importSources(e.target.files[0]);
    e.target.value = '';
  });

  // ESC ile açık alt sayfayı / aramayı / çekmeceyi kapat
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#sheet').hidden) closeSheet(null);
    else if (searchActive()) closeSearch();
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

function init() {
  bind();
  setupPullToRefresh();
  renderSources();
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
