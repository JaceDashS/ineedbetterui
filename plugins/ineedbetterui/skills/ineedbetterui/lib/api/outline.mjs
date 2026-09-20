export async function handleOutlineRoutes(req, res, url, context) {
  if (url.pathname !== '/api/outline' && url.pathname !== '/api/outline/status') return false;
  const runtime = context.runtime();

  if (req.method === 'GET' && url.pathname === '/api/outline') {
    const { outline } = runtime.current;
    context.jsonResponse(res, 200, { ok: true, version: runtime.outlineVersion, items: context.derivedOutline(outline.items) });
    return true;
  }
  if (req.method === 'PATCH' && url.pathname === '/api/outline') {
    try {
      const body = await context.readJson(req);
      if (body.done !== undefined) throw new Error('Only the user can clear the outline, on the page. Move the remaining items to done instead.');
      if (body.text !== undefined) throw new Error('Send items, an array of {no, title, type}.');
      const existing = runtime.current.outline.items;
      let items = context.readOutlineInput(body.items);
      if (existing.length) {
        if (body.version !== runtime.outlineVersion) {
          context.errorResponse(res, 409, `The outline is at version ${runtime.outlineVersion}. Read it again with GET /api/outline and send that version.`);
          return true;
        }
        items = context.mergeOutlineEdit(existing, items);
      }
      const ownHash = context.appendEvent({ t: 'outline', time: context.nowIso(), items });
      context.writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      context.errorResponse(res, 400, error.message);
    }
    return true;
  }
  if (req.method === 'PATCH' && url.pathname === '/api/outline/status') {
    try {
      const body = await context.readJson(req);
      const existing = runtime.current.outline.items;
      if (!existing.length) throw new Error('There is no outline. Make one with PATCH /api/outline.');
      if (body.version !== undefined && body.version !== runtime.outlineVersion) {
        context.errorResponse(res, 409, `The outline is at version ${runtime.outlineVersion}. Read it again with GET /api/outline and send that version.`);
        return true;
      }
      const items = context.stepOutlineStatus(existing, body.items);
      const ownHash = context.appendEvent({ t: 'outline', time: context.nowIso(), items });
      context.writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      context.errorResponse(res, 400, error.message);
    }
    return true;
  }
  if (req.method !== 'DELETE' || url.pathname !== '/api/outline') return false;
  if (!res.fromPage || !context.isLoopbackRequest(req)) {
    context.errorResponse(res, 403, 'Only the user can clear the outline, from the page on the computer running the server.');
    return true;
  }
  context.appendEvent({ t: 'outline', time: context.nowIso(), items: [] });
  context.jsonResponse(res, 200, { ok: true, written: true, state: context.responseState(res) });
  return true;
}
