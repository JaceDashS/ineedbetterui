(() => {
  'use strict';
  const root = document.documentElement;
  const sidebar = document.getElementById('sidebar');
  const outlineSection = document.getElementById('outline-section');
  const outlineScroll = document.getElementById('outline-scroll');
  const pinned = document.getElementById('pinned');
  const pinnedScroll = document.getElementById('pinned-scroll');
  const pinnedResize = document.getElementById('pinned-resize');
  const entriesList = document.getElementById('entries-list');
  const empty = document.getElementById('empty');
  const pageKey = location.pathname;
  const viewKey = 'agent-view:' + pageKey;
  const themeKey = 'agent-theme:' + pageKey;
  const visKey = 'agent-vis:' + pageKey;
  const sidebarKey = 'agent-sidebar:v3:' + pageKey;
  const sidebarWidthKey = 'agent-sidebar-width:' + pageKey;
  const outlineHKey = 'agent-outline-h:' + pageKey;
  const pinnedHKey = 'agent-pinned-h:' + pageKey;
  const outlineColumnsKey = 'agent-outline-columns:' + pageKey;
  const fontSizeKey = 'agent-font-size:' + pageKey;
  // Text size of the conversation: a viewing preference kept in this browser,
  // like the theme, not a setting shared through the server.
  const FONT_SIZES = { 13: 'Small', 15: 'Medium', 17: 'Large', 19: 'Extra large' };
  function applyFontSize(value) {
    const size = FONT_SIZES[value] ? Number(value) : 15;
    root.style.setProperty('--content-font-size', size + 'px');
    const select = document.getElementById('font-size'); if (select) select.value = String(size);
    return size;
  }
  const defaults = { pin: true };
  const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, value); } catch {} };
  // A page opened from the QR code carries ?t=<token>. It is kept for this
  // browser and sent with every request; the address bar is cleaned so the
  // token is not shown or copied by accident.
  const tokenKey = 'agent-token:' + pageKey;
  let accessToken = read(localStorage, tokenKey) || '';
  try {
    const fromUrl = new URL(location.href).searchParams.get('t');
    if (fromUrl) {
      accessToken = fromUrl;
      write(localStorage, tokenKey, fromUrl);
      history.replaceState(null, '', location.pathname);
    }
  } catch {}
  const withToken = url => accessToken ? url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(accessToken) : url;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  // The page UI is English only; recorded content keeps the conversation's language.
  const language = 'en';
  const strings = { en: { title: 'I Need Better UI', themeLight: 'Switch to light theme', themeDark: 'Switch to dark theme', lightMode: 'Light Mode', darkMode: 'Dark Mode', collapse: 'Collapse sidebar', expand: 'Expand sidebar', outline: 'Outline', showPinned: 'Show pinned', hidePinned: 'Hide pinned', pin: 'Pin', unpin: 'Unpin', addReply: 'Add reply', addReplyActive: 'Add reply (on)', replies: 'Replies', note: 'Note', empty: 'No entries yet.', questionMode: 'Use AI-cleaned questions', questionHintCleaned: 'Checked records the concise AI-cleaned wording.', questionHintRaw: "Unchecked records the user's original wording.", resizeColumns: 'Resize outline columns', stepColumn: 'Step', settings: 'Settings', cancel: 'Cancel', apply: 'Apply', save: 'Save', applying: 'Applying…', maxResponseChars: 'Max response chars', maxResponseHint: '0 = unlimited · applies from the next response', maxUnseen: 'Max unseen events', maxUnseenHint: 'Sent to agents per sync · 0 = unlimited', broadcastToggle: 'Broadcast access', broadcastHintOff: 'Off: only this computer can open this page.', broadcastHintOn: 'On: anyone on your network can read and change this transcript. Turns off when the server restarts.', copyUrl: 'Copy address', copied: 'Copied.', copyFailed: 'Copy failed. Select the address and copy it.', broadcast: 'Broadcast access', scanBroadcast: 'Scan this QR code to open the broadcast', legend: 'Entry colors', resizeSidebar: 'Resize sidebar', resizeOutline: 'Resize outline', resizePinned: 'Resize pinned response', clearOutline: 'Clear outline', clearOutlineConfirm: 'Clear the outline? The agent cannot make it again by itself.', requestFailed: 'Request failed.', resetting: 'Resetting…', needToken: 'Open this page from the QR code in the settings on the computer that runs the server.', textSize: 'Text size', textSizeHint: 'Conversation text on this browser only', resetButton: 'Reset conversation', resetHint: 'Starts an empty conversation. The transcript file keeps every line.', resetLocalOnly: 'Only the page on this computer can reset.', resetConfirm: 'Reset the conversation? The page starts empty; the transcript file keeps every line.', working: 'The agent is still working on this turn…', cancelTurn: 'Cancel turn', cancelTurnConfirm: 'Cancel this turn? The question stays in the transcript, marked as cancelled, and the agent is told not to answer it.', cancelTurnLocalOnly: 'Only the page on this computer can cancel a turn.', turnQuiet: 'The agent has said nothing for more than 10 minutes.', turnCancelled: 'The user cancelled this turn; it was never answered.', outlineStep: 'Outline step', goToStep: 'Go to this step', writtenBy: 'Written by', missedTurn: 'Turn {turns} was not recorded.', missedTurns: 'Turns {turns} were not recorded.', lockedDuringTurn: 'Unavailable while the agent is answering', kind: { question: 'Question', report: 'Report', decision: 'Decision', error: 'Error', done: 'Done', other: 'Other' }, kindHint: { question: 'User message', report: 'Progress or explanation', decision: 'Awaiting your choice', error: 'Failure or blocked step', done: 'Completed work', other: 'Other response' } } };
  let view = { ...defaults };
  try {
    const savedView = JSON.parse(read(localStorage, visKey) || 'null');
    if (savedView && typeof savedView.pin === 'boolean') view.pin = savedView.pin;
  } catch {}
  // Entry cards keep their own keyed render cache. The transcript controller
  // clears it when a reset replaces the loaded window.
  let transcript;
  const entryRenderer = ineedbetteruiEntries.create({
    document,
    root,
    entriesList,
    markdown: ineedbetteruiMarkdown,
    labels: L,
    language,
    getState: () => transcript.state,
    getEntries: () => transcript.entries,
    setPin,
    setPinReply,
    makeQrFigure
  });
  transcript = ineedbetteruiTranscript.create({
    window,
    document,
    fetchJson,
    withToken,
    render,
    captureView,
    restoreView,
    clearRendered: entryRenderer.clear,
    hasAccessToken: () => Boolean(accessToken),
    isThisComputer,
    initialState: { head: null, outline: [], pin: null, questionMode: 'cleaned', broadcast: null, maxResponseChars: 3000, maxUnseenEvents: 20, entryCount: 0 }
  });

  function L() { return strings[language]; }
  // The sidebar pin lights up like the one on a pinned entry when it is showing.
  function updatePinVisButton() {
    const button = document.getElementById('vis-pin');
    const label = view.pin ? L().hidePinned : L().showPinned;
    document.getElementById('vis-pin-label').textContent = label;
    button.dataset.active = String(view.pin);
    button.setAttribute('aria-pressed', String(view.pin));
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
  function updateThemeButton() { const button = document.getElementById('theme'); const dark = root.dataset.theme === 'dark'; const label = dark ? L().themeLight : L().themeDark; button.setAttribute('aria-label', label); button.setAttribute('title', label); document.getElementById('theme-label').textContent = dark ? L().lightMode : L().darkMode; }
  function statusLabel(status) { return { pending: 'Pending', active: 'Active', done: 'Done' }[status] || status || ''; }
  function makeQrFigure(qr, address) {
    const size = Number(qr?.size);
    const modules = typeof qr?.modules === 'string' ? qr.modules : '';
    if (!Number.isInteger(size) || size < 21 || size > 177 || modules.length !== size * size || /[^01]/.test(modules)) return null;
    let url;
    try {
      url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
    } catch { return null; }
    const quiet = 4;
    const figure = document.createElement('figure'); figure.className = 'qr-card';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + (size + quiet * 2) + ' ' + (size + quiet * 2));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', L().scanBroadcast); svg.setAttribute('focusable', 'false');
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('width', String(size + quiet * 2)); background.setAttribute('height', String(size + quiet * 2)); background.setAttribute('fill', '#fff'); svg.append(background);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (modules[row * size + column] !== '1') continue;
        const module = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        module.setAttribute('x', String(column + quiet)); module.setAttribute('y', String(row + quiet)); module.setAttribute('width', '1'); module.setAttribute('height', '1'); module.setAttribute('fill', '#000'); svg.append(module);
      }
    }
    const caption = document.createElement('figcaption'); caption.textContent = L().scanBroadcast;
    const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = url.href;
    figure.append(svg, caption, link);
    return figure;
  }
  // Cell text folds away like a legend word does; a table cell's own width
  // cannot be animated, so the text inside it carries the transition.
  function cellText(value) {
    const span = document.createElement('span');
    span.className = 'cell-text';
    span.textContent = value;
    return span;
  }
  // Rebuilding the table on every render replaced the cells mid-transition, so
  // they started at their new state and never faded. It is rebuilt only when
  // something in it actually differs.
  let outlineDrawn = null;
  function renderOutline() {
    const hasContent = Array.isArray(transcript.state.outline) && transcript.state.outline.length > 0;
    outlineSection.hidden = !hasContent;
    outlineSection.classList.toggle('is-visible', hasContent);
    if (!hasContent) { outlineDrawn = null; outlineScroll.replaceChildren(); return; }
    const drawn = JSON.stringify([transcript.state.outline, language, layout.columns, transcript.entries.length]);
    if (drawn === outlineDrawn && outlineScroll.firstElementChild) return;
    outlineDrawn = drawn;
    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    layout.columns.forEach(width => { const column = document.createElement('col'); column.style.width = (width * 100) + '%'; colgroup.append(column); });
    table.append(colgroup);
    const head = document.createElement('thead'); const headerRow = document.createElement('tr');
    ['#', L().stepColumn, 'Type', 'Status'].forEach((value, index) => { const cell = document.createElement('th'); cell.append(cellText(value)); if (index > 0 && index < layout.columns.length - 1) layout.addOutlineColumnHandle(cell, table, colgroup, index); headerRow.append(cell); }); head.append(headerRow); table.append(head);
    const body = document.createElement('tbody');
    const isParent = item => transcript.state.outline.some(other => String(other.no || '').startsWith(item.no + '-'));
    transcript.state.outline.forEach(item => {
      const row = document.createElement('tr');
      if (String(item.no || '').includes('-')) row.dataset.sub = '1';
      row.dataset.status = item.status || 'pending';
      if (item.status === 'active' && !isParent(item)) row.setAttribute('aria-current', 'step');
      [item.no || '', item.title || '', L().kind[item.type] || item.type || '', statusLabel(item.status)].forEach(value => { const cell = document.createElement('td'); cell.append(cellText(value)); row.append(cell); });
      const first = transcript.state.outline.indexOf(item) >= 0 ? firstEntryOfStep(item.no) : null;
      if (first) {
        row.classList.add('is-linked');
        row.tabIndex = 0; row.setAttribute('role', 'link'); row.title = L().goToStep;
        const go = () => goToEntry(first);
        row.addEventListener('click', go);
        row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); } });
      }
      body.append(row);
    });
    table.append(body); outlineScroll.replaceChildren(table);
  }
  // The first reply recorded while that step was the one being worked on.
  function firstEntryOfStep(no) {
    return document.querySelector('.entries-list .entry[data-outline-no="' + CSS.escape(no) + '"]');
  }
  function goToEntry(article) {
    article.scrollIntoView({ block: 'center', behavior: 'smooth' });
    article.classList.remove('is-found');
    void article.offsetWidth;
    article.classList.add('is-found');
  }
  const layout = ineedbetteruiLayout.create({
    document,
    window,
    storage: localStorage,
    keys: {
      sidebar: sidebarKey,
      sidebarWidth: sidebarWidthKey,
      outlineHeight: outlineHKey,
      pinnedHeight: pinnedHKey,
      outlineColumns: outlineColumnsKey
    },
    labels: L,
    read,
    write,
    render
  });
  const settings = ineedbetteruiSettings.create({
    document,
    storage: localStorage,
    fontSizeKey,
    fontSizes: FONT_SIZES,
    labels: L,
    read,
    write,
    applyFontSize,
    fetchJson,
    getState: () => transcript.state,
    setState: transcript.setState,
    render,
    showError: message => window.alert(message)
  });
  function render() {
    document.title = L().title; document.documentElement.lang = language;
    document.getElementById('app-title').textContent = L().title;
    const expanded = sidebar.classList.contains('open'); const sidebarToggle = document.getElementById('sidebar-toggle'); sidebarToggle.setAttribute('aria-label', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('title', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('aria-expanded', String(expanded)); sidebarToggle.querySelector('.menu-icon').classList.toggle('is-open', expanded);
    updateThemeButton(); updatePinVisButton(); document.getElementById('question-mode-label').textContent = L().questionMode;
    document.getElementById('settings-cancel').textContent = L().cancel;
    document.getElementById('settings-apply').textContent = L().apply;
    document.getElementById('settings-save').textContent = L().save;
    document.getElementById('legend-heading').textContent = L().legend;
    document.getElementById('sidebar-resize').setAttribute('aria-label', L().resizeSidebar); document.getElementById('outline-resize').setAttribute('aria-label', L().resizeOutline); pinnedResize.setAttribute('aria-label', L().resizePinned);
    document.querySelectorAll('.legend-item[data-kind]').forEach(item => { const kind = item.dataset.kind; item.title = L().kind[kind] + ' — ' + L().kindHint[kind]; const word = L().kind[kind]; item.querySelector('.label-head').textContent = word.slice(0, 1); item.querySelector('.label-rest').textContent = word.slice(1); item.querySelector('.legend-description').textContent = ' — ' + L().kindHint[kind]; });
    document.getElementById('outline-heading').textContent = L().outline;
    const clear = document.getElementById('outline-clear');
    clear.title = L().clearOutline; clear.setAttribute('aria-label', L().clearOutline); clear.hidden = !isThisComputer(); empty.textContent = L().empty;
    settings.syncForm(false);
    document.getElementById('settings-heading').textContent = L().settings;
    const settingsButton = document.getElementById('settings-button');
    settingsButton.setAttribute('aria-label', L().settings); settingsButton.setAttribute('title', L().settings);
    document.getElementById('max-response-title').textContent = L().maxResponseChars;
    document.getElementById('max-response-hint').textContent = L().maxResponseHint;
    document.getElementById('max-unseen-title').textContent = L().maxUnseen;
    document.getElementById('max-unseen-hint').textContent = L().maxUnseenHint;
    document.getElementById('broadcast-toggle-label').textContent = L().broadcastToggle;
    document.getElementById('copy-url').textContent = L().copyUrl;
    document.getElementById('font-size-title').textContent = L().textSize;
    document.getElementById('font-size-hint').textContent = L().textSizeHint;
    // Reset is the user's: only the page on this computer offers it, and not
    // while the agent is answering.
    const resetButton = document.getElementById('reset-button');
    resetButton.textContent = resetBusy ? L().resetting : L().resetButton;
    resetButton.disabled = settings.busy || resetBusy || !isThisComputer() || turnOpen();
    resetButton.title = turnOpen() ? L().lockedDuringTurn : '';
    document.getElementById('reset-hint').textContent = isThisComputer() ? L().resetHint : L().resetLocalOnly;
    const broadcastOn = Boolean(transcript.state.broadcast && transcript.state.broadcast.enabled);
    document.getElementById('broadcast-row').classList.toggle('is-busy', settings.busy);
    const broadcastBox = document.getElementById('broadcast-box'); broadcastBox.hidden = !broadcastOn || settings.busy;
    const qrHolder = document.getElementById('broadcast-qr'); qrHolder.replaceChildren();
    if (broadcastOn) { const figure = makeQrFigure(transcript.state.broadcast.qr, transcript.state.broadcast.url); if (figure) qrHolder.append(figure); }
    // The gear is hidden while the sidebar is collapsed, so close the panel with it.
    if (!sidebar.classList.contains('open')) settings.setOpen(false);
    updatePinVisButton();
    renderOutline();
    const target = transcript.pinnedData && transcript.state.pin && transcript.pinnedData.id === transcript.state.pin.target ? transcript.pinnedData.entry : null;
    pinned.hidden = !target || !view.pin;
    pinnedResize.hidden = pinned.hidden;
    pinnedScroll.replaceChildren();
    if (target && view.pin) pinnedScroll.append(entryRenderer.makePinnedEntry(target, transcript.pinnedData.replies));
    const shown = target && view.pin ? target.id + ':' + (transcript.pinnedData.replies.length) + ':' + (transcript.state.pin.revisionCount || 0) : null;
    layout.syncPinned(shown);
    entryRenderer.render(target ? target.id : null);
    empty.textContent = transcript.needsToken ? L().needToken : L().empty;
    empty.hidden = !(transcript.needsToken || transcript.loaded) || transcript.entries.length > 0;
    // A turn stays open until the agent's final reply; show that it is not over.
    document.querySelectorAll('.pin-toggle, .reply-toggle').forEach(button => { button.disabled = turnOpen(); if (turnOpen()) button.title = L().lockedDuringTurn; });
    // A turn that ends without a reply - cancelled, or left behind by an agent
    // that stopped recording - says so where the spinner was, so it cannot be
    // mistaken for a finished conversation.
    const spinner = document.getElementById('turn-spinner');
    const answering = Boolean(transcript.state.turn && transcript.state.turn.open);
    const lastEntry = transcript.entries[transcript.entries.length - 1];
    const quiet = !answering && transcript.loaded && lastEntry && lastEntry.kind === 'question' && !lastEntry.cancelled;
    spinner.hidden = !(answering || quiet);
    spinner.dataset.state = answering ? 'working' : 'quiet';
    document.getElementById('turn-spinner-dot').hidden = !answering;
    spinner.querySelector('.turn-spinner-text').textContent = answering
      ? (transcript.state.turn.progress || L().working)
      : L().turnQuiet;
    const cancelButton = document.getElementById('turn-cancel');
    cancelButton.hidden = !answering;
    cancelButton.textContent = L().cancelTurn;
    cancelButton.disabled = cancelBusy || !isThisComputer();
    cancelButton.title = isThisComputer() ? '' : L().cancelTurnLocalOnly;
  }
  // The turn is what gets the transition, so it is switched on for the length of
  // one and then off again.
  let themeTurn = 0;
  function turnTheme(change) {
    root.classList.add('theme-turning');
    change();
    clearTimeout(themeTurn);
    themeTurn = setTimeout(() => root.classList.remove('theme-turning'), 260);
  }
  function applyTheme() {
    const saved = read(localStorage, themeKey); root.dataset.theme = saved || (systemTheme.matches ? 'dark' : 'light');
    updateThemeButton();
  }
  function saveView() { write(localStorage, visKey, JSON.stringify(view)); }
  function isAtBottom() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return scrollY >= maxScroll - 24;
  }
  function scrollToBottom() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    scrollTo(0, maxScroll);
  }
  function isElementAtBottom(element) {
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
  }
  function scrollElementToBottom(element) {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }
  function captureView() {
    const visible = Array.from(document.querySelectorAll('[data-entry-id]')).find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
    return { atBottom: isAtBottom(), pinnedAtBottom: !pinned.hidden && isElementAtBottom(pinnedScroll), pinnedScrollTop: pinnedScroll.scrollTop, atTop: scrollY < 80, id: visible?.dataset.entryId, top: visible?.getBoundingClientRect().top, y: scrollY };
  }
  function restoreView(saved) {
    const restorePinned = () => {
      if (!pinned.hidden && saved?.pinnedAtBottom) scrollElementToBottom(pinnedScroll);
      else if (!pinned.hidden && Number.isFinite(saved?.pinnedScrollTop)) pinnedScroll.scrollTop = saved.pinnedScrollTop;
    };
    if (!saved) { scrollToBottom(); scrollElementToBottom(pinnedScroll); return; }
    if (saved.atBottom) { scrollToBottom(); restorePinned(); return; }
    if (saved.atTop) { scrollTo(0, 0); restorePinned(); return; }
    const node = Array.from(document.querySelectorAll('[data-entry-id]')).find(item => item.dataset.entryId === saved.id);
    if (node && Number.isFinite(saved.top)) scrollBy(0, node.getBoundingClientRect().top - saved.top);
    else scrollTo(0, saved.y || 0);
    restorePinned();
  }
  async function fetchJson(url, options) { const response = await fetch(withToken(url), options); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(L().requestFailed + (data.error ? ' ' + data.error : '')); return data; }
  // While the agent is answering, the pinned document and Add reply must not
  // change under it, so the pin controls are locked for the whole turn.
  function turnOpen() { return Boolean(transcript.state.turn && transcript.state.turn.open); }
  function isThisComputer() { return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname); }
  let cancelBusy = false;
  // The user's way out of a turn the agent stopped answering.
  async function cancelTurn() {
    if (cancelBusy || !turnOpen() || !isThisComputer() || !window.confirm(L().cancelTurnConfirm)) return;
    cancelBusy = true; render();
    try {
      const result = await fetchJson('/api/turn/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-Agent': 'user' }, body: JSON.stringify({}) });
      transcript.setState(result.state); transcript.scheduleRefresh();
    } catch (error) {
      window.alert(error.message);
    } finally {
      cancelBusy = false; render();
    }
  }

  let resetBusy = false;
  async function resetConversation() {
    if (resetBusy || turnOpen() || !isThisComputer() || !window.confirm(L().resetConfirm)) return;
    resetBusy = true; render();
    try {
      const result = await fetchJson('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-Agent': 'user' }, body: JSON.stringify({ confirm: true }) });
      transcript.setState(result.state); settings.setOpen(false); transcript.scheduleRefresh();
    } catch (error) {
      window.alert(error.message);
    } finally {
      resetBusy = false; render();
    }
  }
  async function setPin(target) {
    if (turnOpen()) return;
    try { const result = await fetchJson('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-Agent': 'user' }, body: JSON.stringify({ target }) }); transcript.setState(result.state); await transcript.syncPinned(); render(); }
    catch (error) { window.alert(error.message); }
  }
  async function setPinReply(active) {
    if (turnOpen()) return;
    try { const result = await fetchJson('/api/pin/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-Agent': 'user' }, body: JSON.stringify({ active }) }); transcript.setState(result.state); render(); }
    catch (error) { window.alert(error.message); }
  }
  document.getElementById('theme').addEventListener('click', () => turnTheme(() => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; write(localStorage, themeKey, root.dataset.theme); updateThemeButton(); }));
  systemTheme.addEventListener('change', () => { if (!read(localStorage, themeKey)) turnTheme(applyTheme); });
  document.getElementById('question-mode').addEventListener('change', () => settings.markDirty('questionMode'));
  document.getElementById('reset-button').addEventListener('click', resetConversation);
  document.getElementById('turn-cancel').addEventListener('click', cancelTurn);
  applyFontSize(read(localStorage, fontSizeKey));
  document.getElementById('font-size').addEventListener('change', () => settings.markDirty('fontSize'));
  document.getElementById('max-response-chars').addEventListener('input', event => { event.target.setCustomValidity(''); settings.markDirty('maxResponseChars'); });
  document.getElementById('max-unseen-events').addEventListener('input', event => { event.target.setCustomValidity(''); settings.markDirty('maxUnseenEvents'); });
  document.getElementById('broadcast-toggle').addEventListener('change', () => settings.markDirty('broadcast'));
  document.getElementById('settings-cancel').addEventListener('click', settings.cancel);
  document.getElementById('settings-apply').addEventListener('click', () => { void settings.apply(false); });
  document.getElementById('settings-panel').addEventListener('submit', event => { event.preventDefault(); void settings.apply(true); });
  document.getElementById('vis-pin').addEventListener('click', () => { view.pin = !view.pin; saveView(); render(); });
  document.getElementById('settings-button').addEventListener('click', () => { if (document.getElementById('settings-overlay').hidden) settings.setOpen(true); else settings.cancel(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.getElementById('settings-overlay').hidden) return;
    settings.cancel();
  });
  document.addEventListener('pointerdown', event => {
    // A click outside the panel (on the dimmed background) closes it.
    const overlay = document.getElementById('settings-overlay');
    if (overlay.hidden) return;
    if (document.getElementById('settings-panel').contains(event.target) || document.getElementById('settings-button').contains(event.target)) return;
    settings.cancel();
  });
  document.getElementById('copy-url').addEventListener('click', async () => {
    const address = transcript.state.broadcast && transcript.state.broadcast.url ? transcript.state.broadcast.url : '';
    if (!address) return;
    const status = document.getElementById('copy-status');
    let copied = false;
    // navigator.clipboard is unavailable over plain http on other devices.
    try { if (isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(address); copied = true; } } catch {}
    status.hidden = false; status.textContent = copied ? L().copied : L().copyFailed;
  });
  // Clearing the outline is the user's call; the agent only moves items to done.
  document.getElementById('outline-clear').addEventListener('click', async () => {
    if (!window.confirm(L().clearOutlineConfirm)) return;
    try {
      const result = await fetchJson('/api/outline', { method: 'DELETE', headers: { 'X-Ineedbetterui-Agent': 'user' } });
      transcript.setState(result.state); render();
    } catch (error) { window.alert(error.message); }
  });
  applyTheme();
  render();
  // The first refresh loads the state and the latest page (the page has no
  // head yet, so it reloads), then the reading position is restored.
  let savedView = null;
  try { savedView = JSON.parse(sessionStorage.getItem(viewKey) || 'null'); sessionStorage.removeItem(viewKey); } catch {}
  transcript.start(savedView);
  addEventListener('pagehide', () => write(sessionStorage, viewKey, JSON.stringify(captureView())));
})();
