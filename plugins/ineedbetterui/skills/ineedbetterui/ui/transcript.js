const ineedbetteruiTranscript = (() => {
  'use strict';

  async function fetchEntries(fetchJson, after) {
    const collected = [];
    let cursor = after;
    for (;;) {
      const query = (cursor ? 'after=' + encodeURIComponent(cursor) + '&' : '') + 'limit=1000&full=1';
      const response = await fetchJson('/api/entries?' + query, { cache: 'no-store' });
      collected.push(...response.entries);
      if (!response.hasMore || !response.entries.length) return collected;
      cursor = response.nextAfter;
    }
  }

  function signature(value) {
    return JSON.stringify({ head: value.head, turn: value.turn?.open === true, progress: value.turn?.progress || null, entryCount: value.entryCount, last: value.lastEntry?.id || null, pin: value.pin, broadcast: value.broadcast || null, outline: value.outline, questionMode: value.questionMode, maxResponseChars: value.maxResponseChars, maxUnseenEvents: value.maxUnseenEvents });
  }

  function create(options) {
    const { window, document, fetchJson, withToken, render, captureView, restoreView, clearRendered, hasAccessToken, isThisComputer, initialState, pageSize = 50 } = options;
    let state = initialState;
    let entries = [];
    let hasOlder = false;
    let loaded = false;
    let pinnedData = null;
    let needsToken = false;
    let seenHead = null;
    let lastSignature = '';
    let refreshing = false;
    let refreshAgain = false;
    let loadingOlder = false;
    let seenStateVersion = null;

    async function scheduleRefresh() {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        do { refreshAgain = false; await refresh(); } while (refreshAgain);
      } finally {
        refreshing = false;
      }
    }

    async function loadLatest() {
      const response = await fetchJson('/api/entries?last=' + pageSize + '&full=1', { cache: 'no-store' });
      entries = response.entries;
      hasOlder = response.hasBefore === true;
      clearRendered();
      loaded = true;
    }

    async function loadOlder() {
      if (loadingOlder || !hasOlder || !entries.length) return;
      loadingOlder = true;
      try {
        const response = await fetchJson('/api/entries?before=' + encodeURIComponent(entries[0].id) + '&limit=' + pageSize + '&full=1', { cache: 'no-store' });
        const heightBefore = document.documentElement.scrollHeight;
        entries = response.entries.concat(entries);
        hasOlder = response.hasBefore === true;
        render();
        window.scrollBy(0, document.documentElement.scrollHeight - heightBefore);
      } catch {} finally {
        loadingOlder = false;
      }
    }

    async function fillViewport() {
      while (hasOlder && document.documentElement.scrollHeight <= window.innerHeight + 200) {
        const count = entries.length;
        await loadOlder();
        if (entries.length === count) return;
      }
    }

    async function syncPinned(force) {
      const target = state.pin && state.pin.target ? state.pin.target : null;
      if (!target) { pinnedData = null; return; }
      if (!force && pinnedData && pinnedData.id === target) return;
      const [entry, replies] = await Promise.all([
        fetchJson('/api/entries/' + encodeURIComponent(target), { cache: 'no-store' }),
        fetchJson('/api/entries?replyTo=' + encodeURIComponent(target) + '&limit=1000&full=1', { cache: 'no-store' })
      ]);
      pinnedData = { id: target, entry: entry.entry, replies: replies.entries };
    }

    async function refresh() {
      try {
        const next = await fetchJson('/api/state', { cache: 'no-store' }).catch(error => {
          if (!hasAccessToken() || /access token/i.test(error.message)) needsToken = !isThisComputer();
          render();
          throw error;
        });
        const nextSignature = signature(next);
        if (nextSignature === lastSignature) return;
        const viewPosition = captureView();
        let reload = !seenHead || !entries.length;
        const touched = new Set();
        let pinnedChanged = false;
        if (!reload && next.head !== seenHead) {
          const sync = await fetchJson('/api/sync?knownHead=' + encodeURIComponent(seenHead) + '&limit=0', { cache: 'no-store' }).catch(() => null);
          if (!sync || (sync.status !== 'behind' && sync.status !== 'current') || sync.unseen.some(event => event.t === 'reset')) reload = true;
          else {
            const pinnedId = next.pin?.target || null;
            for (const event of sync.unseen) {
              if (event.t === 'note' || event.t === 'revision') touched.add(event.target);
              if (pinnedId && (event.target === pinnedId || event.replyTo === pinnedId)) pinnedChanged = true;
            }
            if (sync.unseen.some(event => event.t === 'entry')) entries = entries.concat(await fetchEntries(fetchJson, entries.at(-1).id));
          }
        }
        if (reload) await loadLatest();
        for (const id of touched) {
          const index = entries.findIndex(entry => entry.id === id);
          if (index < 0) continue;
          const fresh = await fetchJson('/api/entries/' + encodeURIComponent(id), { cache: 'no-store' }).catch(() => null);
          if (fresh?.entry) entries[index] = fresh.entry;
        }
        state = next;
        seenHead = next.head;
        await syncPinned(pinnedChanged || reload).catch(() => {});
        lastSignature = nextSignature;
        render();
        window.requestAnimationFrame(() => restoreView(viewPosition));
      } catch {}
    }

    function start(savedView) {
      scheduleRefresh().then(() => window.requestAnimationFrame(async () => { restoreView(savedView); await fillViewport(); }));
      window.addEventListener('scroll', () => { if (window.scrollY < 300) loadOlder(); }, { passive: true });
      try {
        new window.EventSource(withToken('/api/events')).onmessage = event => {
          try {
            const pushed = JSON.parse(event.data);
            const stateChanged = seenStateVersion !== null && pushed.state !== seenStateVersion;
            seenStateVersion = pushed.state;
            if (pushed.head !== seenHead || stateChanged) scheduleRefresh();
          } catch { scheduleRefresh(); }
        };
      } catch {}
      window.setInterval(scheduleRefresh, 30000);
    }

    return {
      get state() { return state; },
      get entries() { return entries; },
      get loaded() { return loaded; },
      get pinnedData() { return pinnedData; },
      get needsToken() { return needsToken; },
      setState(next) { state = next; },
      scheduleRefresh,
      syncPinned,
      loadOlder,
      fillViewport,
      start
    };
  }

  return { create, fetchEntries };
})();
