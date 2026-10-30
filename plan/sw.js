/* 安宏旅行社 互動行程 service worker（由 build_plan.py 產生版本號，勿手改 77ca243bdd） */
const VERSION = "77ca243bdd";
const SHELL = "plan-shell-" + VERSION;
const DATA = "plan-data-v1";          // 行程資料：stale-while-revalidate（跨版本保留，舊 ?v= 會被修剪）
const TILES = "plan-tiles-v1";        // 地圖圖磚：使用者開啟才快取，上限 TILE_MAX
const CFG = "plan-cfg";
const SW_GEN = "2";                   // 2＝修正資料快取（舊版 1 會把新 ?v= 資料回成舊快取）
const TILE_MAX = 400;
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png", "./data/trips.json"];
const CDN = ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
let tileOn = null;

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" })));
    await Promise.all(CDN.map(u => fetch(u, { mode: "cors", credentials: "omit" }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    // 首次安裝直接啟用；從第 1 代 SW（資料快取有誤）升級時也直接接管，避免繼續顯示舊資料；之後的更新等使用者按「更新」
    const gen = await (await caches.open(CFG)).match("gen");
    if (!self.registration.active || !gen) await self.skipWaiting();
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("plan-shell-") && k !== SHELL) await caches.delete(k);
    await (await caches.open(CFG)).put("gen", new Response(SW_GEN));
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "TILE_CACHE") {
    tileOn = !!d.on;
    e.waitUntil((async () => {
      const c = await caches.open(CFG); await c.put("tile", new Response(tileOn ? "1" : "0"));
      if (!tileOn) await caches.delete(TILES);
    })());
  }
});
async function tilesEnabled() {
  if (tileOn !== null) return tileOn;
  const r = await (await caches.open(CFG)).match("tile");
  tileOn = r ? (await r.text()) === "1" : false; return tileOn;
}
const BLANK = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), ch => ch.charCodeAt(0));
function blankTile() { return new Response(BLANK, { status: 200, headers: { "Content-Type": "image/png", "X-Offline": "1" } }); }
async function trim(name, max) {
  const c = await caches.open(name); const ks = await c.keys();
  for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}
// 行程資料：
//  - 帶 ?v=（data_version）的檔案內容固定：快取有「完全相同網址」就直接回（背景再驗證），沒有就走網路；離線才退回同路徑的舊版。
//  - 不帶版本的索引（data/trips.json）：網路優先（4 秒逾時），失敗才用快取，確保看到最新 data_version。
async function putData(c, req, r) {
  const path = new URL(req.url).pathname;
  for (const k of await c.keys()) if (new URL(k.url).pathname === path && k.url !== req.url) await c.delete(k);
  await c.put(req, r);
}
async function dataFetch(e, req) {
  const c = await caches.open(DATA); const versioned = new URL(req.url).searchParams.has("v");
  const net = () => fetch(req, { cache: "no-cache" }).then(async r => { if (r && r.ok) await putData(c, req, r.clone()); return r; });
  if (versioned) {
    const hit = await c.match(req);
    if (hit) { if (self.navigator.onLine !== false) e.waitUntil(net().catch(() => {})); return hit; }
    if (self.navigator.onLine === false) { const old = await c.match(req, { ignoreSearch: true }); if (old) return old; }
    try { return await net(); } catch (err) { return (await c.match(req, { ignoreSearch: true })) || Response.error(); }
  }
  if (self.navigator.onLine === false) { const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; }
  const p = net();
  try {
    const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    if (r && r.ok) return r; throw new Error("HTTP " + (r && r.status));
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true }); if (hit) { e.waitUntil(p.catch(() => {})); return hit; }
    return p;
  }
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      try {
        const on = await tilesEnabled(); const c = on ? await caches.open(TILES) : null; const hit = c && await c.match(req); if (hit) return hit;
        if (self.navigator && self.navigator.onLine === false) return blankTile();   // 離線就不發請求
        if (!on) return await fetch(req);
        const r = await fetch(req); if (r && (r.ok || r.type === "opaque")) { await c.put(req, r.clone()); e.waitUntil(trim(TILES, TILE_MAX)); }
        return r;
      } catch (err) { return blankTile(); }  // 離線且沒快取：回透明圖磚，不讓頁面報錯
    })());
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith(new URL("./data/", self.registration.scope).pathname)) {
    e.respondWith(dataFetch(e, req)); return;
  }
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      if (self.navigator.onLine === false) { const h = (await c.match("./index.html")) || (await c.match(req, { ignoreSearch: true })); if (h) return h; }
      try { const r = await fetch(req); if (r && r.ok) return r; throw new Error(r.status); }
      catch (_) { return (await c.match("./index.html")) || (await c.match(req, { ignoreSearch: true })) || Response.error(); }
    })());
    return;
  }
  if (url.origin === location.origin || CDN.includes(req.url)) {
    e.respondWith(caches.open(SHELL).then(c => c.match(req, { ignoreSearch: url.origin === location.origin }).then(hit => hit || fetch(req))));
  }
});
