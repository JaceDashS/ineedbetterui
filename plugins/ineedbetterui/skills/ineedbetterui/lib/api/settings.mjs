export async function handleSettingsRoutes(req, res, url, context) {
  if (req.method === 'POST' && url.pathname === '/api/broadcast') {
    context.errorResponse(res, 400, 'Broadcast is a setting now: PATCH /api/settings {"broadcast": true|false}, from the page on this computer.');
    return true;
  }
  if (req.method !== 'PATCH' || url.pathname !== '/api/settings') return false;

  try {
    const body = await context.readJson(req);
    const has = key => Object.prototype.hasOwnProperty.call(body, key);
    const event = { t: 'settings', time: context.nowIso() };
    if (has('questionMode')) {
      if (!context.questionModes.has(body.questionMode)) throw new Error('questionMode must be cleaned or raw.');
      event.questionMode = body.questionMode;
    }
    for (const key of ['maxResponseChars', 'maxUnseenEvents']) {
      if (!has(key)) continue;
      if (!Number.isInteger(body[key]) || body[key] < 0) throw new Error(`${key} must be an integer of 0 or more.`);
      event[key] = body[key];
    }
    if (has('broadcast')) {
      if (typeof body.broadcast !== 'boolean') throw new Error('broadcast must be true or false.');
      if (!context.isLoopbackRequest(req)) throw new Error('Broadcast can only be switched from the page on this computer.');
    }
    const switchBroadcast = has('broadcast') && body.broadcast !== context.state().broadcastMode;
    if (Object.keys(event).length === 2 && !has('broadcast')) throw new Error('No setting was given.');
    let ownHash = null;
    if (Object.keys(event).length > 2) ownHash = context.appendEvent(event);
    if (switchBroadcast) {
      context.setBroadcastMode(body.broadcast);
      context.updateBroadcastInfo();
      const { broadcastMode, broadcastInfo, serverPort } = context.state();
      context.appendEvent({
        t: 'broadcast',
        time: context.nowIso(),
        enabled: broadcastMode,
        url: broadcastInfo ? broadcastInfo.url : null,
        port: serverPort,
        source: res.fromPage ? 'user' : 'agent'
      });
      res.on('finish', () => setTimeout(() => { void context.applyBroadcast(context.state().broadcastMode); }, 50));
    }
    context.writeResponse(res, 200, { written: Boolean(ownHash) || switchBroadcast }, body.knownHead, ownHash);
  } catch (error) {
    context.errorResponse(res, 400, error.message);
  }
  return true;
}
