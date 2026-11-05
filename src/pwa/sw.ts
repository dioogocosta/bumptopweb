/**
 * Service Worker (injectManifest) — precache do app shell + WASM + assets,
 * runtime cache de imagens, e atualização controlada.
 *
 * O vite-plugin-pwa injeta `self.__WB_MANIFEST` com a lista de arquivos a cache.
 * `self` é tipado como ServiceWorkerGlobalScope (o lib DOM define `self` como
 * Window, então fazemos cast explícito).
 */
/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;
const manifest = (
  self as unknown as { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }
).__WB_MANIFEST;

const CACHE = 'bumptop-shell-v1';
const RUNTIME = 'bumptop-runtime-v1';

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(manifest.map((m) => m.url))),
  );
  sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== sw.location.origin) return;

  // Imagens/thumbs: stale-while-revalidate
  if (req.destination === 'image') {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached as Response);
        return cached ?? network;
      }),
    );
    return;
  }

  // Shell, JS, CSS, WASM: cache-first com fallback p/ rede
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        }),
    ),
  );
});

export {};
