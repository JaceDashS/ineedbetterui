export async function handleMutationRoutes(req, res, url, context) {
  const runtime = () => context.runtime();
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'POST' && url.pathname === '/api/entries') {
    try {
      const body = await context.readJson(req);
      if (!context.kinds.has(body.kind)) throw new Error('kind must be question, report, decision, error, done or other.');
      const hasBody = typeof body.body === 'string';
      const hasRaw = typeof body.rawBody === 'string';
      const hasCleaned = typeof body.cleanedBody === 'string';
      if (!hasBody && !hasRaw && !hasCleaned) throw new Error('Send body, or rawBody and cleanedBody for a question.');
      if (body.kind === 'question' && !(hasRaw && hasCleaned)) throw new Error("A question needs both rawBody (the user's words) and cleanedBody (your cleaned version, in the conversation's language).");
      const fallback = hasBody ? body.body : (hasRaw ? body.rawBody : body.cleanedBody);
      const rawBody = body.kind === 'question' ? (hasRaw ? body.rawBody : fallback) : undefined;
      const cleanedBody = body.kind === 'question' ? (hasCleaned ? body.cleanedBody : fallback) : undefined;
      const sourceBody = body.kind === 'question'
        ? (runtime().current.questionMode === 'raw' ? rawBody : cleanedBody)
        : fallback;
      const turnNo = context.readTurnNo(body);
      const clientRef = typeof body.clientRef === 'string' && body.clientRef
        ? body.clientRef
        : (body.kind === 'question' ? `${res.writer}-turn-${turnNo}-q` : '');
      context.requiredText(sourceBody, 'body');
      if (clientRef && runtime().clientRefs.has(clientRef)) {
        const existing = runtime().clientRefs.get(clientRef);
        context.writeResponse(res, 200, { written: false, deduplicated: true, entry: context.publicEntry(existing, true) }, body.knownHead, null, { brief: existing.kind === 'question' });
        return true;
      }
      if (body.kind === 'question' && context.turnLocked() && runtime().current.turn.agent !== res.writer) {
        throw context.statusError(409, `${runtime().current.turn.agent} is answering right now, so this message was not recorded. Tell the user that it cannot be recorded while another agent is mid-turn, and that they can ask you to try again once it has answered. Do not record a reply, and do not retry on your own; record the message again only when the user asks you to.`);
      }
      context.refuseFinal(body);
      if (body.kind === 'question') context.checkQuestionTurn(turnNo, runtime().turnNo.get(res.writer));
      else context.checkOpenTurn(turnNo, runtime().current.turn.no);
      if (body.kind !== 'question' && !runtime().current.turn.open) {
        throw context.statusError(409, "This turn is closed, so nothing was recorded. One question takes one reply. Record the user's next message as a question before replying again.");
      }
      context.refuseOtherTurn(res);
      const pinned = body.kind === 'question' ? null : context.activeReplyTarget();
      if (pinned) throw new Error(`Add reply is on for pinned entry ${pinned.id}: this turn's reply edits that document. Send it to POST /api/pin/edit as old and new.`);
      if (body.kind !== 'question') context.enforceResponseLimit(sourceBody, runtime().current.maxResponseChars);
      const id = `a-${runtime().nextEntryNo + 1}`;
      const event = {
        t: 'entry',
        id,
        kind: body.kind,
        time: context.nowIso(),
        heading: typeof body.heading === 'string' ? body.heading : '',
        body: sourceBody
      };
      if (res.writer) event.agent = res.writer;
      if (body.kind !== 'question') {
        const step = context.currentOutlineNo();
        if (step) event.outlineNo = step;
      }
      if (body.kind === 'question') {
        event.rawBody = rawBody;
        event.cleanedBody = cleanedBody;
        event.questionMode = runtime().current.questionMode;
      }
      if (clientRef) event.clientRef = clientRef;
      event.turn = turnNo;
      const ownHash = context.appendEvent(event);
      context.writeResponse(res, 201, { written: true, entry: context.publicEntry(runtime().current.byId.get(id), true) }, body.knownHead, ownHash, { brief: body.kind === 'question' });
    } catch (error) {
      context.errorResponse(res, error.status || 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/pin/edit') {
    try {
      const body = await context.readJson(req);
      const pinned = context.activeReplyTarget();
      if (!pinned) throw new Error('Add reply is off, so the pinned document cannot be edited. Do not edit it another way: reply to the user asking them to pin the reply and turn on Add reply, then make the edit in the next turn.');
      if (body.body !== undefined) throw new Error('A pinned document is edited only with old and new; send the part that changes.');
      context.refuseFinal(body);
      if (!runtime().current.turn.open) throw context.statusError(409, "This turn is closed, so nothing was recorded. Record the user's next message as a question before editing again.");
      context.checkOpenTurn(context.readTurnNo(body), runtime().current.turn.no);
      context.refuseOtherTurn(res);
      const document = context.applyPatch(pinned.body || '', body, 'the pinned document', `read it with GET /api/entries/${pinned.id}`);
      context.requiredText(document, 'The edited document');
      context.enforceResponseLimit(body.new, runtime().current.maxResponseChars);
      const id = `a-${runtime().nextEntryNo + 1}`;
      const event = {
        t: 'entry', id, kind: pinned.kind, time: context.nowIso(),
        heading: typeof body.heading === 'string' ? body.heading : pinned.heading,
        body: document, revises: pinned.id, patch: { old: body.old, new: body.new }
      };
      if (res.writer) event.agent = res.writer;
      const step = context.currentOutlineNo();
      if (step) event.outlineNo = step;
      const ownHash = context.appendEvent(event);
      context.appendEvent({ t: 'pin', time: context.nowIso(), target: id, source: 'agent' });
      context.writeResponse(res, 201, { written: true, entry: context.publicEntry(runtime().current.byId.get(id), true) }, body.knownHead, ownHash);
    } catch (error) {
      context.errorResponse(res, error.status || 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'entries' && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    try {
      const entry = context.currentEntry(id);
      if (req.method === 'GET' && !parts[3]) {
        context.jsonResponse(res, 200, { ok: true, entry: context.publicEntry(entry, true) });
        return true;
      }
      if (req.method === 'POST' && (parts[3] === 'notes' || parts[3] === 'revisions')) {
        throw new Error('Recorded replies cannot be edited. To correct something, say so in a new reply; to work on a reply as a document, the user pins it and turns on Add reply, then send the change to POST /api/pin/edit.');
      }
      context.errorResponse(res, 404, 'Unsupported endpoint.');
    } catch (error) {
      context.errorResponse(res, 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/progress') {
    try {
      const body = await context.readJson(req);
      if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('text must be a non-empty string saying what you are doing.');
      if (body.text.length > 200) throw new Error('text must be 200 characters or fewer: it is one line under the conversation, not a reply.');
      if (!runtime().current.turn.open) throw context.statusError(409, "There is no open turn, so there is nothing to report progress on. Record the user's message first.");
      context.checkOpenTurn(context.readTurnNo(body), runtime().current.turn.no);
      context.refuseOtherTurn(res);
      runtime().progress = body.text.trim();
      runtime().stateVersion += 1;
      context.notifyWatchers();
      context.jsonResponse(res, 200, { ok: true, written: false, state: context.responseState(res), next: 'Keep working; record your reply when you give it.' });
    } catch (error) {
      context.errorResponse(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/pin') {
    try {
      const body = await context.readJson(req);
      if (body.target !== null && typeof body.target !== 'string') throw new Error('target must be a reply ID or null.');
      if (body.target) context.pinEntry(body.target);
      const source = res.fromPage ? 'user' : 'agent';
      const ownHash = context.appendEvent({ t: 'pin', time: context.nowIso(), target: body.target, source });
      context.writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      context.errorResponse(res, 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/pin/reply') {
    try {
      const body = await context.readJson(req);
      if (typeof body.active !== 'boolean') throw new Error('This switches Add reply for the pinned entry and needs {"active": true|false}. To edit the pinned document, send old and new to POST /api/pin/edit.');
      const pinned = runtime().current.pin?.target ? context.currentEntry(runtime().current.pin.target) : null;
      if (body.active && (!pinned || pinned.kind === 'question')) throw new Error('Pin a reply before turning on Add reply.');
      const source = res.fromPage ? 'user' : 'agent';
      const ownHash = context.appendEvent({ t: 'pin-reply', time: context.nowIso(), active: body.active, target: body.active ? pinned.id : null, source });
      context.writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      context.errorResponse(res, 400, error.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/reply-target') {
    context.errorResponse(res, 400, 'This endpoint was renamed: switch Add reply with POST /api/pin/reply {"active": true|false}.');
    return true;
  }

  if (req.method !== 'POST' || url.pathname !== '/api/reset') return false;
  try {
    const body = await context.readJson(req);
    if (!res.fromPage || !context.isLoopbackRequest(req)) {
      throw new Error('Only the user resets the conversation, with the Reset button in the page\'s settings on this computer. If the user asks you to reset, tell them where that button is.');
    }
    if (context.turnLocked()) throw context.statusError(409, 'A turn is in progress; reset once it has been answered.');
    if (body.confirm !== true) throw new Error('Reset needs confirm:true.');
    const ownHash = context.appendEvent({ t: 'reset', time: context.nowIso() });
    context.writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
  } catch (error) {
    context.errorResponse(res, error.status || 400, error.message);
  }
  return true;
}
