/**
 * Cloudflare Pages Function: Proxy reverso para a API do Taiga FNDE.
 *
 * Resolve o bloqueio de CORS do browser (taiga-api.fnde.gov.br não envia
 * headers de CORS na resposta a preflight OPTIONS com Authorization header).
 * Como roda no edge (server-to-server), não há restrição de CORS.
 */

interface EnvLike {
  [key: string]: unknown;
}

interface FnCtx<Env = EnvLike> {
  request: Request;
  env: Env;
  params: { path?: string | string[] };
}

const TAIGA_API_BASE = 'https://taiga-api.fnde.gov.br/api/v1';

export const onRequest = async (ctx: FnCtx): Promise<Response> => {
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      },
    });
  }

  const url = new URL(ctx.request.url);
  let subPath = '';
  if (Array.isArray(ctx.params.path)) {
    subPath = ctx.params.path.join('/');
  } else if (typeof ctx.params.path === 'string') {
    subPath = ctx.params.path;
  }

  const targetUrl = `${TAIGA_API_BASE}/${subPath}${url.search}`;

  const forwardHeaders = new Headers();
  forwardHeaders.set('Accept', 'application/json');
  const auth = ctx.request.headers.get('Authorization');
  if (auth) forwardHeaders.set('Authorization', auth);
  const contentType = ctx.request.headers.get('Content-Type');
  if (contentType) forwardHeaders.set('Content-Type', contentType);

  const init: RequestInit = {
    method: ctx.request.method,
    headers: forwardHeaders,
  };

  if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') {
    init.body = await ctx.request.arrayBuffer();
  }

  try {
    const upstream = await fetch(targetUrl, init);
    const respHeaders = new Headers();
    respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    respHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'UPSTREAM_ERROR', detail: String(err) }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};
