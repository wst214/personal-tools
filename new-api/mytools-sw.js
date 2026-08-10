/* DevToolbox: 一次性恢复 New API 登录态（绕过 iframe 第三方 Cookie 限制） */
const CACHE = 'mytools-auth-v1';
const BUNDLE = '/__mytools_auth_bundle__';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.pathname !== '/api/user/auth/refresh') return;

  event.respondWith(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(BUNDLE);
        if (hit) {
          // 只喂给 SPA 引导一次，之后走真实 refresh（依赖网关改写后的 Cookie）
          await cache.delete(BUNDLE);
          return hit;
        }
      } catch {}
      return fetch(req);
    })(),
  );
});
