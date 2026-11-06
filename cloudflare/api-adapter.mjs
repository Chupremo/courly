import { Buffer } from 'node:buffer';

// These endpoints accept small JSON requests. Media uploads go to Supabase.
export const MAX_API_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

function errorResponse(status, code, error) {
  return new Response(JSON.stringify({ success: false, code, error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function readBody(request) {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return undefined;
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_API_BODY_BYTES) throw new BodyTooLarge();

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_API_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function queryParameters(searchParams) {
  const query = Object.create(null);
  for (const [key, value] of searchParams) {
    if (!Object.hasOwn(query, key)) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }
  return query;
}

/** Run the existing req/res handlers without changing their authentication logic. */
export async function invokeNodeHandler(request, handler) {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return error instanceof BodyTooLarge
      ? errorResponse(413, 'REQUEST_TOO_LARGE', 'This request is too large.')
      : errorResponse(400, 'INVALID_REQUEST', 'The request body could not be read.');
  }

  const url = new URL(request.url);
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers),
    query: queryParameters(url.searchParams),
    body
  };
  const headers = new Headers();
  let responseBody = null;
  let ended = false;
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      if (ended) throw new Error('Response has already ended.');
      headers.delete(name);
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
      return this;
    },
    getHeader(name) { return headers.get(name); },
    end(value) {
      if (ended) throw new Error('Response has already ended.');
      if (value != null) responseBody = typeof value === 'string' ? value : Buffer.from(value);
      ended = true;
      return this;
    }
  };

  try {
    await handler(req, res);
    if (!ended) throw new Error('API handler did not complete a response.');
    const hasNoBody = request.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
    return new Response(hasNoBody ? null : responseBody, { status: res.statusCode, headers });
  } catch {
    // Never print the exception: provider errors can contain credentials or URLs.
    console.error('Courtly Worker API adapter failed.', { code: 'UNEXPECTED_ERROR' });
    return errorResponse(500, 'API_UNAVAILABLE', 'This service is temporarily unavailable.');
  }
}
