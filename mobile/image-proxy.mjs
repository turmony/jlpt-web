// Embedded in the generated Cloudflare Pages _worker.js; never shipped to the browser.
export function createImageProxy(manifest, { fetchUpstream = fetch, timeoutMs = 15000 } = {}) {
  const fail = (status, message, extra = {}) => new Response(message, {
    status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/images/')) {
        return env?.ASSETS ? env.ASSETS.fetch(request) : fail(404, 'Not found');
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      }
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { return fail(400, 'Invalid image path'); }
      // Only URLs generated from validated card links are reachable. No arbitrary URL proxy.
      if (!Object.hasOwn(manifest, path)) return fail(404, 'Image not in this release');
      const controller = new AbortController();
      let timeout;
      try {
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Image upstream timeout'));
          }, timeoutMs);
        });
        const download = (async () => {
          const response = await fetchUpstream(manifest[path], {
            method: request.method, signal: controller.signal, redirect: 'manual',
          });
          if (!response.ok) {
            await response.body?.cancel();
            return fail(response.status === 404 ? 404 : 502, 'GitHub image unavailable');
          }
          const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'].includes(type)) {
            await response.body?.cancel();
            return fail(502, 'Upstream did not return an image');
          }
          // The deadline covers both response headers and the complete image body.
          const body = request.method === 'HEAD' ? null : await response.arrayBuffer();
          return new Response(body, { headers: {
            'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          } });
        })();
        return await Promise.race([download, deadline]);
      } catch {
        return fail(controller.signal.aborted ? 504 : 502, 'Image download failed; please retry');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
