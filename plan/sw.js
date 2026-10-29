/* 安宏旅行社 互動行程 service worker（由 build_plan.py 產生版本號，勿手改 7f2e1604bc） */
const VERSION = "7f2e1604bc";
const SHELL = "plan-shell-" + VERSION;
const DATA = "plan-data-v1";          // 行程資料：stale-while-revalidate（跨版本保留，舊 ?v= 會被修剪）
const TILES = "plan-tiles-v1";        // 地圖圖磚：使用者開啟才快取，上限 TILE_MAX
const CFG = "plan-cfg";
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
    if (!self.registration.active) await self.skipWaiting();  // 首次安裝直接啟用；更新版等使用者按「更新」
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("plan-shell-") && k !== SHELL) await caches.delete(k);
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
async function trim(name, max) {
  const c = await caches.open(name); const ks = await c.keys();
  for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}
async function swr(e, req) {
  const c = await caches.open(DATA);
  const hit = await c.match(req) || await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(async r => {
    if (r && r.ok) {
      const path = new URL(req.url).pathname;
      for (const k of await c.keys()) if (new URL(k.url).pathname === path && k.url !== req.url) await c.delete(k);
      await c.put(req, r.clone());
    }
    return r;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      if (!(await tilesEnabled())) return fetch(req);
      const c = await caches.open(TILES); const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r && (r.ok || r.type === "opaque")) { await c.put(req, r.clone()); e.waitUntil(trim(TILES, TILE_MAX)); }
      return r;
    })());
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith(new URL("./data/", self.registration.scope).pathname)) {
    e.respondWith(swr(e, req)); return;
  }
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try { const r = await fetch(req); if (r && r.ok) return r; throw new Error(r.status); }
      catch (_) { return (await c.match("./index.html")) || (await c.match(req, { ignoreSearch: true })) || Response.error(); }
    })());
    return;
  }
  if (url.origin === location.origin || CDN.includes(req.url)) {
    e.respondWith(caches.open(SHELL).then(c => c.match(req, { ignoreSearch: url.origin === location.origin }).then(hit => hit || fetch(req))));
  }
});
