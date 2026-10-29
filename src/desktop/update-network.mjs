import { Readable } from 'node:stream';

// Electron net.fetch cancels manual redirects without exposing their response.
// Return that response explicitly so UpdateDownload can validate every next URL.
export function createUpdateFetch(net) {
  return (url, { headers, signal } = {}) => new Promise((resolve, reject) => {
    const aborted = () => signal?.reason || new DOMException('Update request aborted', 'AbortError');
    if (signal?.aborted) { reject(aborted()); return; }
    let request, incoming, finished = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = error => {
      if (finished) return;
      finished = true; cleanup();
      incoming?.destroy(error); reject(error); request?.abort();
    };
    const onAbort = () => fail(aborted());
    try {
      request = net.request({ url: String(url), method: 'GET', redirect: 'manual',
        credentials: 'omit', useSessionCookies: false, cache: 'no-store' });
      for (const [key, value] of new Headers(headers)) request.setHeader(key, value);
      signal?.addEventListener('abort', onAbort, { once: true });
      request.on('error', fail);
      request.on('abort', () => fail(aborted()));
      request.on('redirect', (status, _method, location) => {
        if (finished) return;
        // Stop this request before following; cross-origin headers are removed by the caller.
        finished = true; cleanup();
        resolve(new Response(null, { status, headers: { location } }));
        request.abort();
      });
      request.on('response', response => {
        if (finished) { response.destroy(); return; }
        incoming = response;
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
          }
          response.once('end', () => { finished = true; cleanup(); });
          response.once('close', () => { finished = true; cleanup(); });
          response.once('error', fail);
          const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
          resolve(new Response(body, { status: response.statusCode, headers: responseHeaders }));
          if (!body) response.resume();
        } catch (error) { fail(error); }
      });
      request.end();
    } catch (error) { fail(error); }
  });
}
