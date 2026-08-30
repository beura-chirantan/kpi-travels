// Same-origin relay for production. Authentication and authorization stay in FastAPI.
// The Vite dev proxy handles this path during development.
export const dynamic = 'force-dynamic';

async function relay(request: Request) {
  const backend = process.env.API_ORIGIN || 'http://127.0.0.1:8000';
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, backend);
  const headers = new Headers();
  for (const name of ['content-type', 'cookie', 'origin', 'x-requested-with', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.text(),
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
    const outgoing = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of [
      'content-type',
      'content-disposition',
      'content-security-policy',
      'set-cookie',
      'x-content-type-options',
    ]) {
      const value = response.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    return new Response(response.status === 204 ? null : response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch {
    return Response.json(
      { detail: 'The Python booking API is unavailable. Start it and retry.' },
      { status: 503 },
    );
  }
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
