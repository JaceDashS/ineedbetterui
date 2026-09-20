export function handleReadRoutes(req, res, url, context) {
  const { runtime, broadcastMode, serverPort } = context.state();
  if (req.method === 'GET' && url.pathname === '/api/events') {
    context.openWatch(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    context.jsonResponse(res, 200, { ok: true, app: context.appName, sessionId: context.sessionId, pid: process.pid, port: serverPort, broadcast: broadcastMode });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    context.jsonResponse(res, 200, context.stateSummary());
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/sync') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const options = { limit: Number.isInteger(limit) && limit >= 0 ? limit : undefined };
    context.jsonResponse(res, 200, { ok: true, ...context.syncResult(runtime, url.searchParams.get('knownHead'), options) });
    return true;
  }
  if (req.method !== 'GET' || url.pathname !== '/api/entries') return false;

  const full = url.searchParams.get('full') === '1';
  const replyTo = url.searchParams.get('replyTo');
  const list = replyTo ? runtime.current.entries.filter(entry => entry.replyTo === replyTo) : runtime.current.entries;
  const total = list.length;
  const after = url.searchParams.get('after');
  const before = url.searchParams.get('before');
  const last = Number.parseInt(url.searchParams.get('last') ?? '', 10);
  let limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 1_000);
  let start = after ? list.findIndex(entry => entry.id === after) + 1 : 0;
  if (before) {
    const end = list.findIndex(entry => entry.id === before);
    start = Math.max(0, (end < 0 ? total : end) - limit);
    limit = Math.min(limit, (end < 0 ? total : end) - start);
  } else if (Number.isInteger(last) && last > 0) {
    limit = Math.min(last, 1_000);
    start = Math.max(0, total - limit);
  }
  const entries = list.slice(start, start + limit).map(entry => context.publicEntry(entry, full));
  context.jsonResponse(res, 200, {
    ok: true,
    entries,
    nextAfter: entries.at(-1)?.id || after || null,
    hasMore: start + entries.length < total,
    hasBefore: start > 0
  });
  return true;
}
