/* 阳光3S遥感平台 · Service Worker
 * 目的：让重复访问秒开（静态资源走缓存），同时杜绝此前“页面卡在旧版”的坑。
 * 策略
 *  - HTML 导航 / 入口逻辑脚本(app.js/gate.js)：网络优先，失败回退缓存（结构始终最新）
 *  - 同源静态资源（geo*.js / data*.js / css / img）：stale-while-revalidate（先用缓存秒开，后台静默更新）
 *  - 跨域瓦片 / 腾讯 SDK：直连网络（瓦片体量大，交给浏览器与服务端缓存，不占 SW 配额）
 *  - 新版本激活即接管（skipWaiting + clients.claim），旧缓存自动清理，避免“旧 JS + 新 HTML”错配
 * 部署若改动了资源，把下方 CACHE_VERSION 升一档即可强制旧缓存整体失效。
 */
const CACHE_VERSION = 'agri-v1';
const CACHE = 'agri3s-' + CACHE_VERSION;

// 入口逻辑脚本走网络优先，避免旧逻辑配新结构
const NETWORK_FIRST_RE = /(^|\/)(app\.js|gate\.js|index\.html?)$/i;

self.addEventListener('install', function () {
  // 直接激活新 SW，不用等旧页面关闭
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
      return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) 导航请求（HTML）：网络优先，保证结构/路由永远最新；离线时回退已缓存的页面
  if (req.mode === 'navigate') {
    e.respondWith((async function () {
      const key = url.pathname;            // 不含 hash，避免按锚点裂变缓存
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(key, net.clone());
        return net;
      } catch (err) {
        const cached = await caches.match(key);
        if (cached) return cached;
        return new Response('离线且无可用的页面缓存', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 2) 跨域（瓦片/腾讯SDK）：直连，不进 SW 缓存
  if (url.origin !== self.location.origin) {
    e.respondWith(fetch(req));
    return;
  }

  // 3) 同源静态资源
  const path = url.pathname;
  if (NETWORK_FIRST_RE.test(path)) {
    // 入口脚本：网络优先 + 失败回退缓存
    e.respondWith((async function () {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, net.clone());
        return net;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 其余重资源：stale-while-revalidate（先用缓存秒开，后台更新）
  e.respondWith((async function () {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then(function (res) {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(function () { return null; });
    return cached || network;
  })());
});
