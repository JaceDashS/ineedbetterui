(() => {
  'use strict';
  const root = document.documentElement;
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');
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
  const outlineColumnsKey = 'agent-outline-columns:' + pageKey;
  const pinnedHKey = 'agent-pinned-h:' + pageKey;
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
  const outlineColumnDefaults = [0.12, 0.42, 0.22, 0.24];
  const outlineColumnMinimums = [40, 96, 60, 60];
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
  const strings = { en: { title: 'I Need Better UI', themeLight: 'Switch to light theme', themeDark: 'Switch to dark theme', lightMode: 'Light Mode', darkMode: 'Dark Mode', collapse: 'Collapse sidebar', expand: 'Expand sidebar', outline: 'Outline', pinned: 'Pinned', pin: 'Pin', unpin: 'Unpin', addReply: 'Add reply', addReplyActive: 'Add reply (on)', replies: 'Replies', note: 'Note', empty: 'No entries yet.', questionMode: 'Use AI-cleaned questions', questionHintCleaned: 'Checked records the concise AI-cleaned wording.', questionHintRaw: "Unchecked records the user's original wording.", resizeColumns: 'Resize outline columns', settings: 'Settings', maxResponseChars: 'Max response chars', maxResponseHint: '0 = unlimited · applies from the next response', maxUnseen: 'Max unseen events', maxUnseenHint: 'Sent to agents per sync · 0 = unlimited', broadcastToggle: 'Broadcast access', broadcastHintOff: 'Off: only this computer can open this page.', broadcastHintOn: 'On: anyone on your network can read and change this transcript. Turns off when the server restarts.', copyUrl: 'Copy address', copied: 'Copied.', copyFailed: 'Copy failed. Select the address and copy it.', broadcast: 'Broadcast access', scanBroadcast: 'Scan this QR code to open the broadcast', cleaned: 'AI-cleaned', raw: 'Original', legend: 'Entry colors', resizeSidebar: 'Resize sidebar', resizeOutline: 'Resize outline', resizePinned: 'Resize pinned response', requestFailed: 'Request failed.', switchingBroadcast: 'Switching…', resetting: 'Resetting…', needToken: 'Open this page from the QR code in the settings on the computer that runs the server.', textSize: 'Text size', textSizeHint: 'Conversation text on this browser only', resetButton: 'Reset conversation', resetHint: 'Starts an empty conversation. The transcript file keeps every line.', resetLocalOnly: 'Only the page on this computer can reset.', resetConfirm: 'Reset the conversation? The page starts empty; the transcript file keeps every line.', docChanged: 'Edited version of', working: 'The agent is still working on this turn…', lockedDuringTurn: 'Unavailable while the agent is answering', kind: { question: 'Question', report: 'Report', decision: 'Decision', error: 'Error', done: 'Done', other: 'Other' }, kindShort: { question: 'Q', report: 'R', decision: 'D', error: 'E', done: 'D', other: 'O' }, kindHint: { question: 'User message', report: 'Progress or explanation', decision: 'Awaiting your choice', error: 'Failure or blocked step', done: 'Completed work', other: 'Other response' } } };
  let view = { ...defaults };
  try {
    const savedView = JSON.parse(read(localStorage, visKey) || 'null');
    if (savedView && typeof savedView.pin === 'boolean') view.pin = savedView.pin;
  } catch {}
  // The page ships without data; the first refresh loads it from the API. Until then the
  // state holds the defaults so every control can render.
  let state = { head: null, outline: [], outlineDone: false, pin: null, questionMode: 'cleaned', broadcast: null, maxResponseChars: 3000, maxUnseenEvents: 20, entryCount: 0 };
  // The loaded window of the conversation, oldest first: the latest PAGE_SIZE
  // entries at first, extended upwards as the reader scrolls.
  const PAGE_SIZE = 50;
  let entries = [];
  let hasOlder = false;
  let loaded = false;
  // The pinned reply and its thread are loaded on their own, because either
  // may lie outside the loaded window.
  let pinnedData = null;
  // Entry ID -> { node, version } for what is on screen, so a change redraws
  // only the entries it touched.
  const rendered = new Map();
  // The head up to which this page has applied events. The page's own writes
  // (pin, settings) return a newer state.head, but events written just before
  // them by others are still unapplied, so refresh syncs from this head instead.
  let seenHead = null;
  let lastSignature = '';
  let questionBusy = false;
  let limitBusy = false;
  let outlineColumns = outlineColumnDefaults.slice();
  try {
    const savedColumns = JSON.parse(read(localStorage, outlineColumnsKey) || 'null');
    if (Array.isArray(savedColumns) && savedColumns.length === outlineColumnDefaults.length && savedColumns.every(value => Number.isFinite(value) && value > 0)) {
      const total = savedColumns.reduce((sum, value) => sum + value, 0);
      if (total > 0) outlineColumns = savedColumns.map(value => value / total);
    }
  } catch {}

  function L() { return strings[language]; }
  function setDualLabel(id, full, short) { const node = document.getElementById(id); node.querySelector('.label-full').textContent = full; node.querySelector('.label-short').textContent = short; }
  function updateThemeButton() { const button = document.getElementById('theme'); const dark = root.dataset.theme === 'dark'; const label = dark ? L().themeLight : L().themeDark; button.setAttribute('aria-label', label); button.setAttribute('title', label); document.getElementById('theme-label').textContent = dark ? L().lightMode : L().darkMode; }
  function statusLabel(status) { return { pending: 'Pending', active: 'Active', done: 'Done' }[status] || status || ''; }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  }
  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    const tokens = [];
    const hold = html => { tokens.push(html); return '\u0001' + (tokens.length - 1) + '\u0002'; };
    text = text.replace(/\x60([^\x60\n]+)\x60/g, (_, code) => hold('<code>' + code + '</code>'));
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      if (!/^(?:https?:\/\/|mailto:|\/|#)/i.test(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });
    text = text.replace(/&lt;br\s*\/?&gt;/gi, () => hold('<br>'));
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
    return text.replace(/\u0001(\d+)\u0002/g, (_, index) => tokens[Number(index)]);
  }
  function cells(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map(cell => cell.trim());
  }
  function tableSeparator(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
  const CODE_LANGUAGES = { js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', json: 'json', jsonl: 'json', py: 'py', python: 'py', sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', ps1: 'ps1', powershell: 'ps1', pwsh: 'ps1', html: 'html', xml: 'html', svg: 'html', css: 'css' };
  const CODE_KEYWORDS = {
    js: new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
    json: new Set(['true', 'false', 'null']),
    py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield'.split(' ')),
    bash: new Set('case do done echo elif else esac exit export fi for function if in local return then until while'.split(' ')),
    ps1: new Set('$false $null $true begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while'.split(' ')),
    css: new Set(['!important'])
  };
  function codeLanguageName(tag) { return CODE_LANGUAGES[String(tag || '').toLowerCase()] || ''; }
  function highlightCode(source, tag) {
    const lang = codeLanguageName(tag);
    const text = String(source ?? '');
    if (!lang) return escapeHtml(text);
    try { return tokenizeCode(text, lang); } catch { return escapeHtml(text); }
  }
  // A small single-pass tokenizer. It only separates comments, strings, keywords,
  // numbers and names; every token is escaped before it is wrapped in a span.
  function tokenizeCode(source, lang) {
    const span = (kind, value) => '<span class="tok-' + kind + '">' + escapeHtml(value) + '</span>';
    const keywords = CODE_KEYWORDS[lang] || new Set();
    const quoted = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y;
    const template = /\x60(?:\\.|[^\x60\\])*\x60?/y;
    const config = {
      js: { block: /\/\*[\s\S]*?(?:\*\/|$)/y, line: /\/\/[^\n]*/y, strings: [quoted, template], word: /[A-Za-z_$][\w$]*/y, calls: true },
      json: { strings: [quoted], word: /[A-Za-z_]\w*/y, keys: true },
      py: { line: /#[^\n]*/y, strings: [quoted], word: /[A-Za-z_]\w*/y, calls: true },
      bash: { line: /#[^\n]*/y, hashAfterSpace: true, strings: [quoted], word: /[A-Za-z_][\w-]*/y, calls: true },
      ps1: { block: /<#[\s\S]*?(?:#>|$)/y, line: /#[^\n]*/y, hashAfterSpace: true, strings: [quoted], word: /\$?[A-Za-z_][\w-]*/y, calls: true, lower: true },
      css: { block: /\/\*[\s\S]*?(?:\*\/|$)/y, strings: [quoted], word: /[@!]?-{0,2}[A-Za-z_][\w-]*/y },
      html: { strings: [quoted] }
    }[lang];
    const numberRe = lang === 'css' ? /\d+(?:\.\d+)?(?:px|em|rem|vh|vw|ms|s|%)?/y : /\d+(?:\.\d+)?/y;
    const colonAhead = /\s*:/y;
    const parenAhead = /\s*\(/y;
    const at = (re, pos) => { re.lastIndex = pos; return re.exec(source); };
    let out = '', i = 0, depth = 0, inTag = false, m;
    while (i < source.length) {
      const ch = source[i];
      if (lang === 'html') {
        if (!inTag) {
          if ((m = at(/<!--[\s\S]*?(?:-->|$)/y, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
          if ((m = at(/<(\/?)([A-Za-z][\w:.-]*)/y, i))) { out += '&lt;' + m[1] + span('keyword', m[2]); i += m[0].length; inTag = true; continue; }
        } else {
          if (ch === '>') { out += '&gt;'; i += 1; inTag = false; continue; }
          if ((m = at(quoted, i))) { out += span('string', m[0]); i += m[0].length; continue; }
          if ((m = at(/[A-Za-z_:][\w:.-]*/y, i))) { out += span('function', m[0]); i += m[0].length; continue; }
        }
        out += escapeHtml(ch); i += 1; continue;
      }
      if (config.block && (m = at(config.block, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      if (config.line && (!config.hashAfterSpace || i === 0 || /\s/.test(source[i - 1])) && (m = at(config.line, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      const str = config.strings.map(re => at(re, i)).find(Boolean);
      if (str) { const end = i + str[0].length; out += span(config.keys && at(colonAhead, end) ? 'function' : 'string', str[0]); i = end; continue; }
      if ((m = at(config.word, i))) {
        const word = m[0]; const end = i + word.length; let kind = '';
        if (keywords.has(config.lower ? word.toLowerCase() : word) || (lang === 'css' && word[0] === '@')) kind = 'keyword';
        else if (lang === 'css' && depth > 0 && at(colonAhead, end)) kind = 'function';
        else if (lang === 'ps1' && /^[A-Za-z]+-[A-Za-z]+$/.test(word)) kind = 'function';
        else if (config.calls && at(parenAhead, end)) kind = 'function';
        out += kind ? span(kind, word) : escapeHtml(word); i = end; continue;
      }
      if ((m = at(numberRe, i))) { out += span('number', m[0]); i += m[0].length; continue; }
      if (ch === '{') depth += 1; else if (ch === '}') depth = Math.max(0, depth - 1);
      out += escapeHtml(ch); i += 1;
    }
    return out;
  }
  function renderMarkdown(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    const fence = String.fromCharCode(96).repeat(3);
    const tildeFence = '~~~';
    let paragraph = [];
    let list = null;
    let code = null; let codeFence = null; let codeLanguage = '';
    const flushParagraph = () => { if (paragraph.length) { output.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>'); paragraph = []; } };
    const flushList = () => { if (list) { output.push('<' + list.type + '>' + list.items.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</' + list.type + '>'); list = null; } };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (code !== null) {
        if (line.trim() === codeFence) { const source = code.join('\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); code = null; codeFence = null; codeLanguage = ''; }
        else code.push(line);
        continue;
      }
      const opening = line.trim();
      if (opening.startsWith(fence) || opening.startsWith(tildeFence)) { flushParagraph(); flushList(); code = []; codeFence = opening.startsWith(tildeFence) ? tildeFence : fence; codeLanguage = opening.slice(3).trim().split(/\s+/)[0].toLowerCase(); continue; }
      if (index + 1 < lines.length && line.includes('|') && tableSeparator(lines[index + 1])) {
        flushParagraph(); flushList();
        const head = cells(line); index += 1; const rows = [];
        while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) { index += 1; rows.push(cells(lines[index])); }
        let table = '<div class="table-scroll"><table><thead><tr>' + head.map(cell => '<th>' + inlineMarkdown(cell) + '</th>').join('') + '</tr></thead><tbody>';
        table += rows.map(row => '<tr>' + head.map((_, cellIndex) => '<td>' + inlineMarkdown(row[cellIndex] || '') + '</td>').join('') + '</tr>').join('');
        output.push(table + '</tbody></table></div>'); continue;
      }
      // Body headings start at h4: the entry's own heading is the h3 above them.
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushParagraph(); flushList();
        const level = Math.min(6, heading[1].length + 3);
        output.push('<h' + level + ' class="md-heading">' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        continue;
      }
      const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph(); flushList();
        const quoted = [quote[1]];
        while (index + 1 < lines.length) {
          const next = /^\s{0,3}>\s?(.*)$/.exec(lines[index + 1]);
          if (!next) break;
          index += 1; quoted.push(next[1]);
        }
        while (quoted.length && !quoted[quoted.length - 1].trim()) quoted.pop();
        output.push('<blockquote>' + quoted.map(inlineMarkdown).join('<br>') + '</blockquote>');
        continue;
      }
      const unordered = /^\s*-\s+(.+)$/.exec(line);
      const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph(); const type = unordered ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push((unordered || ordered)[1]); continue;
      }
      if (!line.trim()) { flushParagraph(); flushList(); continue; }
      flushList(); paragraph.push(line);
    }
    if (code !== null) { const source = code.join('\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); }
    flushParagraph(); flushList();
    return output.join('');
  }
  function bodyHtml(entry) {
    let html = renderMarkdown(entry.body || '');
    const notes = Array.isArray(entry.notes) ? entry.notes : [];
    if (!notes.length) return html;
    const pending = [];
    notes.forEach(note => {
      const content = '<aside class="note" aria-label="' + escapeHtml(L().note) + ': ' + escapeHtml(note.anchor || '') + '"><strong>' + escapeHtml(note.title || L().note) + '</strong>' + renderMarkdown(note.text || '') + '</aside>';
      const anchor = escapeHtml(note.anchor || '');
      if (anchor) {
        const position = html.indexOf(anchor);
        if (position >= 0) { pending.push({ position: position + anchor.length, content }); return; }
      }
      html += content;
    });
    pending.sort((a, b) => b.position - a.position);
    pending.forEach(note => { html = html.slice(0, note.position) + note.content + html.slice(note.position); });
    return html;
  }
  function formatTime(value) {
    try { return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return value; }
  }
  function svgPin() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pin-icon'); icon.setAttribute('width', '22'); icon.setAttribute('height', '22'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', L().pinned);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = L().pinned; icon.append(title);
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathNode.setAttribute('d', 'M16 3 21 8 17 9 14 12 14 16 8 10 12 10 15 7 Z M11 13 4 20'); icon.append(pathNode);
    return icon;
  }
  function pinButtonIcon(active) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pin-symbol'); icon.setAttribute('width', '18'); icon.setAttribute('height', '18'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', active ? 'currentColor' : 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true');
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathNode.setAttribute('d', 'M16 3 21 8 17 9 14 12 14 16 8 10 12 10 15 7 Z M11 13 4 20'); icon.append(pathNode);
    return icon;
  }
  function addReplyButton(targetId) {
    const active = Boolean(state.pin && state.pin.target === targetId && state.pin.replyActive);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'reply-toggle'; button.dataset.active = String(active); button.textContent = L().addReply; button.setAttribute('aria-label', active ? L().addReplyActive : L().addReply); button.setAttribute('title', active ? L().addReplyActive : L().addReply); button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => setPinReply(!active));
    return button;
  }
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
  function makeEntry(entry, isPinned, options = {}) {
    const article = document.createElement('article');
    article.className = 'entry'; article.dataset.kind = entry.kind; article.dataset.entryId = entry.id;
    if (options.reply) article.classList.add('reply-entry');
    if (entry.replyTo) article.dataset.replyTo = entry.replyTo;
    const meta = document.createElement('div'); meta.className = 'entry-meta';
    const time = document.createElement('time'); time.dateTime = entry.time; time.textContent = formatTime(entry.time); meta.append(time);
    const kind = document.createElement('span'); kind.className = 'kind-label'; kind.textContent = L().kind[entry.kind] || entry.kind; meta.append(kind);
    if (entry.kind === 'question') { const mode = document.createElement('span'); mode.className = 'mode-label'; mode.textContent = '· ' + (entry.questionMode === 'raw' ? L().raw : L().cleaned); meta.append(mode); }
    article.append(meta);
    if (entry.heading) { const heading = document.createElement('h3'); heading.innerHTML = inlineMarkdown(entry.heading); article.append(heading); }
    // A new version of a pinned document shows only its change in the
    // conversation; the whole document is in the pinned area.
    if (entry.patch && !isPinned) article.append(makeChange(entry));
    else { const body = document.createElement('div'); body.innerHTML = bodyHtml(entry); article.append(body); }
    const qrFigure = makeQrFigure(entry.qr, entry.broadcastUrl);
    if (qrFigure) { article.classList.add('broadcast-entry'); article.append(qrFigure); }
    if (isPinned) { article.append(addReplyButton(entry.id)); article.append(svgPin()); }
    if (!isPinned && options.showPin !== false && entry.kind !== 'question') {
      const actions = document.createElement('div'); actions.className = 'entry-actions';
      const active = Boolean(state.pin && state.pin.target === entry.id);
      const pinButton = document.createElement('button'); pinButton.type = 'button'; pinButton.className = 'pin-toggle'; pinButton.dataset.active = String(active);pinButton.setAttribute('aria-label', active ? L().unpin : L().pin); pinButton.setAttribute('title', active ? L().unpin : L().pin); pinButton.setAttribute('aria-pressed', String(active)); pinButton.append(pinButtonIcon(active));
      pinButton.addEventListener('click', () => setPin(active ? null : entry.id)); actions.append(pinButton); article.append(actions);
    }
    return article;
  }
  function makeChange(entry) {
    const change = document.createElement('div'); change.className = 'doc-change';
    const label = document.createElement('p'); label.className = 'doc-change-label'; label.textContent = L().docChanged + ' ' + entry.revises; change.append(label);
    [['removed', entry.patch.old], ['added', entry.patch.new]].forEach(([kind, text]) => {
      if (!text) return;
      const block = document.createElement('div'); block.className = 'doc-change-' + kind; block.innerHTML = renderMarkdown(text); change.append(block);
    });
    return change;
  }
  function makePinnedEntry(entry, replies) {
    const article = makeEntry(entry, true);
    if (replies.length) {
      const list = document.createElement('div'); list.className = 'reply-list'; list.setAttribute('aria-label', L().replies);
      replies.forEach(reply => list.append(makeEntry(reply, false, { reply: true, showPin: false })));
      article.append(list);
    }
    return article;
  }
  function addOutlineColumnHandle(cell, table, colgroup, index) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'outline-column-handle';
    handle.setAttribute('aria-label', L().resizeColumns);
    handle.setAttribute('title', L().resizeColumns);
    handle.setAttribute('aria-orientation', 'vertical');
    let drag = null;
    const finish = event => {
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      const currentWidths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
      const total = currentWidths.reduce((sum, width) => sum + width, 0);
      if (total > 0) {
        outlineColumns = currentWidths.map(width => width / total);
        write(localStorage, outlineColumnsKey, JSON.stringify(outlineColumns));
      }
      drag = null;
      document.body.classList.remove('resizing-outline-columns');
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const widths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
      drag = { pointerId: event.pointerId, startX: event.clientX, widths };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-outline-columns');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const pairTotal = drag.widths[index] + drag.widths[index + 1];
      const minimumLeft = outlineColumnMinimums[index];
      const minimumRight = outlineColumnMinimums[index + 1];
      const nextLeft = Math.min(Math.max(drag.widths[index] + event.clientX - drag.startX, minimumLeft), pairTotal - minimumRight);
      const nextWidths = drag.widths.slice();
      nextWidths[index] = nextLeft;
      nextWidths[index + 1] = pairTotal - nextLeft;
      const tableWidth = table.getBoundingClientRect().width;
      if (tableWidth > 0) nextWidths.forEach((width, columnIndex) => { colgroup.children[columnIndex].style.width = (width / tableWidth * 100) + '%'; });
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    cell.append(handle);
  }
  function renderOutline() {
    const hasContent = state.outlineDone !== true && Array.isArray(state.outline) && state.outline.length > 0;
    outlineSection.hidden = !hasContent;
    outlineSection.classList.toggle('is-visible', hasContent);
    if (!hasContent) { outlineScroll.replaceChildren(); return; }
    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    outlineColumns.forEach(width => { const column = document.createElement('col'); column.style.width = (width * 100) + '%'; colgroup.append(column); });
    table.append(colgroup);
    const head = document.createElement('thead'); const headerRow = document.createElement('tr');
    ['#', L().outline, 'Type', 'Status'].forEach((value, index) => { const cell = document.createElement('th'); cell.textContent = value; if (index < outlineColumns.length - 1) addOutlineColumnHandle(cell, table, colgroup, index); headerRow.append(cell); }); head.append(headerRow); table.append(head);
    const body = document.createElement('tbody');
    state.outline.forEach(item => { const row = document.createElement('tr'); if (String(item.no || '').includes('-')) row.dataset.sub = '1'; if (item.current === true) row.setAttribute('aria-current', 'step'); [item.no || '', item.title || '', L().kind[item.type] || item.type || '', statusLabel(item.status)].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); body.append(row); });
    table.append(body); outlineScroll.replaceChildren(table);
  }
  function setSettingsOpen(open) {
    document.getElementById('settings-overlay').hidden = !open;
    document.getElementById('settings-button').setAttribute('aria-expanded', String(open));
  }
  function render() {
    document.title = L().title; document.documentElement.lang = language;
    document.getElementById('app-title').textContent = L().title;
    const expanded = sidebar.classList.contains('open'); const sidebarToggle = document.getElementById('sidebar-toggle'); sidebarToggle.setAttribute('aria-label', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('title', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('aria-expanded', String(expanded)); sidebarToggle.querySelector('.menu-icon').classList.toggle('is-open', expanded);
    updateThemeButton(); setDualLabel('vis-pin-label', L().pinned, 'P'); document.getElementById('question-mode-label').textContent = L().questionMode;
    document.getElementById('legend-heading').textContent = L().legend;
    document.getElementById('sidebar-resize').setAttribute('aria-label', L().resizeSidebar); document.getElementById('outline-resize').setAttribute('aria-label', L().resizeOutline); document.getElementById('pinned-resize').setAttribute('aria-label', L().resizePinned);
    document.querySelectorAll('.legend-item[data-kind]').forEach(item => { const kind = item.dataset.kind; item.title = L().kind[kind] + ' — ' + L().kindHint[kind]; item.querySelector('.label-full').textContent = L().kind[kind]; item.querySelector('.label-short').textContent = L().kindShort[kind]; item.querySelector('.legend-description').textContent = ' — ' + L().kindHint[kind]; });
    document.getElementById('outline-heading').textContent = L().outline; empty.textContent = L().empty;
    document.getElementById('question-mode').checked = state.questionMode !== 'raw';
    document.getElementById('question-mode-hint').textContent = document.getElementById('question-mode').checked ? L().questionHintCleaned : L().questionHintRaw;
    const limitInput = document.getElementById('max-response-chars'); if (document.activeElement !== limitInput) limitInput.value = String(state.maxResponseChars ?? 3000);
    const unseenInput = document.getElementById('max-unseen-events'); if (document.activeElement !== unseenInput) unseenInput.value = String(state.maxUnseenEvents ?? 20);
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
    resetButton.disabled = resetBusy || !isThisComputer() || turnOpen();
    resetButton.title = turnOpen() ? L().lockedDuringTurn : '';
    document.getElementById('reset-hint').textContent = isThisComputer() ? L().resetHint : L().resetLocalOnly;
    const broadcastOn = Boolean(state.broadcast && state.broadcast.enabled);
    const broadcastToggle = document.getElementById('broadcast-toggle');
    if (document.activeElement !== broadcastToggle) broadcastToggle.checked = broadcastOn;
    broadcastToggle.disabled = broadcastBusy;
    document.getElementById('broadcast-hint').textContent = broadcastBusy ? L().switchingBroadcast : (broadcastOn ? L().broadcastHintOn : L().broadcastHintOff);
    document.getElementById('broadcast-row').classList.toggle('is-busy', broadcastBusy);
    const broadcastBox = document.getElementById('broadcast-box'); broadcastBox.hidden = !broadcastOn || broadcastBusy;
    const qrHolder = document.getElementById('broadcast-qr'); qrHolder.replaceChildren();
    if (broadcastOn) { const figure = makeQrFigure(state.broadcast.qr, state.broadcast.url); if (figure) qrHolder.append(figure); }
    // The gear is hidden while the sidebar is collapsed, so close the panel with it.
    if (!sidebar.classList.contains('open')) setSettingsOpen(false);
    document.getElementById('vis-pin').checked = view.pin;
    renderOutline();
    const target = pinnedData && state.pin && pinnedData.id === state.pin.target ? pinnedData.entry : null;
    pinned.hidden = !target || !view.pin;
    pinnedScroll.replaceChildren();
    pinnedResize.hidden = pinned.hidden;
    if (target && view.pin) pinnedScroll.append(makePinnedEntry(target, pinnedData.replies));
    renderEntries(target ? target.id : null);
    empty.textContent = needsToken ? L().needToken : L().empty;
    empty.hidden = !(needsToken || loaded) || entries.length > 0;
    // A turn stays open until the agent's final reply; show that it is not over.
    document.querySelectorAll('.pin-toggle, .reply-toggle').forEach(button => { button.disabled = turnOpen(); if (turnOpen()) button.title = L().lockedDuringTurn; });
    const spinner = document.getElementById('turn-spinner'); spinner.hidden = !(state.turn && state.turn.open); spinner.querySelector('.turn-spinner-text').textContent = L().working;
  }
  // What an entry's card depends on. A card is redrawn only when this changes.
  function entryVersion(entry) {
    return JSON.stringify([entry.body, entry.heading, entry.questionMode, entry.notes?.length || 0, entry.revisions?.length || 0, Boolean(state.pin && state.pin.target === entry.id)]);
  }
  // Brings the conversation list in line with `entries` by adding, replacing,
  // moving or removing only the cards that differ, like a keyed virtual DOM.
  // A new message therefore costs one card, not a redraw of the whole list.
  function renderEntries(pinnedId) {
    // A reply belongs to its pinned parent while that parent remains pinned:
    // it is shown only in the pinned reply list, not twice. When the parent is
    // unpinned it returns to the general list.
    const general = pinnedId ? entries.filter(entry => entry.replyTo !== pinnedId) : entries;
    const wanted = new Set(general.map(entry => entry.id));
    for (const [id, record] of rendered) {
      if (!wanted.has(id)) { record.node.remove(); rendered.delete(id); }
    }
    let cursor = entriesList.firstChild;
    for (const entry of general) {
      const version = entryVersion(entry);
      let record = rendered.get(entry.id);
      if (!record || record.version !== version) {
        const node = makeEntry(entry, false);
        if (record) {
          if (cursor === record.node) cursor = node;
          record.node.replaceWith(node);
        }
        record = { node, version };
        rendered.set(entry.id, record);
      }
      if (record.node !== cursor) entriesList.insertBefore(record.node, cursor);
      cursor = record.node.nextSibling;
    }
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
  function signature(value) { return JSON.stringify({ head: value.head, turn: value.turn?.open === true, entryCount: value.entryCount, last: value.lastEntry?.id || null, pin: value.pin,  broadcast: value.broadcast || null, outline: value.outline, done: value.outlineDone, questionMode: value.questionMode, maxResponseChars: value.maxResponseChars, maxUnseenEvents: value.maxUnseenEvents }); }
  async function fetchJson(url, options) { const response = await fetch(withToken(url), options); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(L().requestFailed + (data.error ? ' ' + data.error : '')); return data; }
  // While the agent is answering, the pinned document and Add reply must not
  // change under it, so the pin controls are locked for the whole turn.
  function turnOpen() { return Boolean(state.turn && state.turn.open); }
  function isThisComputer() { return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname); }
  async function resetConversation() {
    if (resetBusy || turnOpen() || !isThisComputer() || !window.confirm(L().resetConfirm)) return;
    resetBusy = true; render();
    try {
      const result = await fetchJson('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ confirm: true }) });
      state = result.state; setSettingsOpen(false); scheduleRefresh();
    } catch (error) {
      window.alert(error.message);
    } finally {
      resetBusy = false; render();
    }
  }
  async function setPin(target) {
    if (turnOpen()) return;
    try { const result = await fetchJson('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ target }) }); state = result.state; await syncPinned(); render(); }
    catch (error) { window.alert(error.message); }
  }
  async function setPinReply(active) {
    if (turnOpen()) return;
    try { const result = await fetchJson('/api/pin/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ active }) }); state = result.state; render(); }
    catch (error) { window.alert(error.message); }
  }
  async function saveQuestionMode() {
    if (questionBusy) return;
    questionBusy = true; const checkbox = document.getElementById('question-mode'); const mode = checkbox.checked ? 'cleaned' : 'raw';
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ questionMode: mode }) }); state = result.state; render(); }
    catch (error) { checkbox.checked = !checkbox.checked; render(); window.alert(error.message); }
    finally { questionBusy = false; }
  }
  async function saveResponseLimit() {
    if (limitBusy) return;
    const input = document.getElementById('max-response-chars'); const previous = state.maxResponseChars; const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0) { input.value = previous; return; }
    limitBusy = true;
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ maxResponseChars: value }) }); state = result.state; render(); }
    catch (error) { input.value = previous; window.alert(error.message); }
    finally { limitBusy = false; }
  }
  // Reads every page after the given entry ID.
  async function fetchEntries(after) {
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
  // Pushes can arrive while a refresh is still running; run one more afterwards
  // instead of overlapping.
  // Another device that has no token yet sees what to do instead of an empty page.
  let needsToken = false;
  let broadcastBusy = false;
  let resetBusy = false;
  let refreshing = false;
  let refreshAgain = false;
  async function scheduleRefresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      do { refreshAgain = false; await refresh(); } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  }
  // Loads the latest page of the conversation, replacing the loaded window.
  async function loadLatest() {
    const response = await fetchJson('/api/entries?last=' + PAGE_SIZE + '&full=1', { cache: 'no-store' });
    entries = response.entries;
    hasOlder = response.hasBefore === true;
    for (const record of rendered.values()) record.node.remove();
    rendered.clear();
    loaded = true;
  }
  // Loads the page of entries just before the loaded window and keeps the
  // entry the reader is looking at in place while it is added above.
  let loadingOlder = false;
  async function loadOlder() {
    if (loadingOlder || !hasOlder || !entries.length) return;
    loadingOlder = true;
    try {
      const response = await fetchJson('/api/entries?before=' + encodeURIComponent(entries[0].id) + '&limit=' + PAGE_SIZE + '&full=1', { cache: 'no-store' });
      const heightBefore = document.documentElement.scrollHeight;
      entries = response.entries.concat(entries);
      hasOlder = response.hasBefore === true;
      render();
      scrollBy(0, document.documentElement.scrollHeight - heightBefore);
    } catch {} finally {
      loadingOlder = false;
    }
  }
  // Keeps loading older pages while the list is too short to scroll, so the
  // reader can always reach older entries by scrolling up.
  async function fillViewport() {
    while (hasOlder && document.documentElement.scrollHeight <= innerHeight + 200) {
      const count = entries.length;
      await loadOlder();
      if (entries.length === count) return;
    }
  }
  // Loads the pinned reply and its thread when the pin changes, or when
  // `force` says one of them changed.
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
      const next = await fetchJson('/api/state', { cache: 'no-store' }).catch(error => { if (!accessToken || /access token/i.test(error.message)) needsToken = !isThisComputer(); render(); throw error; }); const nextSignature = signature(next); if (nextSignature === lastSignature) return;
      const viewPosition = captureView();
      // Ask the server what happened since the head this page last saw, and
      // fetch only that: new entries are appended, and entries touched by a
      // note or revision are refetched one by one. A reset, or a head the
      // server no longer knows, reloads the latest page instead.
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
          if (sync.unseen.some(event => event.t === 'entry')) entries = entries.concat(await fetchEntries(entries.at(-1).id));
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
      const limitInput = document.getElementById('max-response-chars'); if (document.activeElement !== limitInput) limitInput.value = String(next.maxResponseChars ?? 3000); lastSignature = nextSignature; render(); requestAnimationFrame(() => restoreView(viewPosition));
    } catch {}
  }
  document.getElementById('theme').addEventListener('click', () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; write(localStorage, themeKey, root.dataset.theme); updateThemeButton(); });
  systemTheme.addEventListener('change', () => { if (!read(localStorage, themeKey)) applyTheme(); });
  document.getElementById('question-mode').addEventListener('change', saveQuestionMode);
  document.getElementById('reset-button').addEventListener('click', resetConversation);
  applyFontSize(read(localStorage, fontSizeKey));
  document.getElementById('font-size').addEventListener('change', event => { write(localStorage, fontSizeKey, String(applyFontSize(event.target.value))); });
  document.getElementById('max-response-chars').addEventListener('change', saveResponseLimit);
  document.getElementById('max-unseen-events').addEventListener('change', async () => {
    const input = document.getElementById('max-unseen-events'); const previous = state.maxUnseenEvents; const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0) { input.value = previous; return; }
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ maxUnseenEvents: value }) }); state = result.state; render(); }
    catch (error) { input.value = previous; window.alert(error.message); }
  });
  document.getElementById('vis-pin').addEventListener('change', event => { view.pin = event.target.checked; saveView(); render(); });
  document.getElementById('settings-button').addEventListener('click', () => setSettingsOpen(document.getElementById('settings-overlay').hidden));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.getElementById('settings-overlay').hidden) return;
    setSettingsOpen(false); document.getElementById('settings-button').focus();
  });
  document.addEventListener('pointerdown', event => {
    // A click outside the panel (on the dimmed background) closes it.
    const overlay = document.getElementById('settings-overlay');
    if (overlay.hidden) return;
    if (document.getElementById('settings-panel').contains(event.target) || document.getElementById('settings-button').contains(event.target)) return;
    setSettingsOpen(false);
  });
  document.getElementById('broadcast-toggle').addEventListener('change', async event => {
    const on = event.target.checked;
    const status = document.getElementById('copy-status'); status.hidden = true;
    broadcastBusy = true; render();
    try {
      const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ broadcast: on }) });
      state = result.state;
    } catch (error) {
      event.target.checked = !on;
      window.alert(error.message);
    } finally {
      broadcastBusy = false; render();
    }
  });
  document.getElementById('copy-url').addEventListener('click', async () => {
    const address = state.broadcast && state.broadcast.url ? state.broadcast.url : '';
    if (!address) return;
    const status = document.getElementById('copy-status');
    let copied = false;
    // navigator.clipboard is unavailable over plain http on other devices.
    try { if (isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(address); copied = true; } } catch {}
    status.hidden = false; status.textContent = copied ? L().copied : L().copyFailed;
  });
  const sidebarResize = document.getElementById('sidebar-resize');
  let sidebarDrag = null;
  let preferredSidebarWidth = Number.parseFloat(read(localStorage, sidebarWidthKey) || '') || 0;
  function setSidebarWidth(width) {
    const minimum = Math.min(innerWidth * 0.84, 320);
    const maximum = Math.min(minimum * 2, innerWidth);
    const next = Math.min(maximum, Math.max(minimum, width));
    sidebar.style.setProperty('--sidebar-width', next + 'px');
    sidebarResize.setAttribute('aria-valuemin', String(Math.round(minimum)));
    sidebarResize.setAttribute('aria-valuemax', String(Math.round(maximum)));
    sidebarResize.setAttribute('aria-valuenow', String(Math.round(next)));
    return next;
  }
  function finishSidebarResize() {
    if (!sidebarDrag) return;
    const pointerId = sidebarDrag.pointerId;
    sidebarDrag = null;
    sidebar.classList.remove('resizing');
    if (sidebarResize.hasPointerCapture(pointerId)) sidebarResize.releasePointerCapture(pointerId);
    write(localStorage, sidebarWidthKey, String(preferredSidebarWidth));
  }
  sidebarResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || sidebarDrag) return;
    event.preventDefault();
    sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    sidebar.classList.add('resizing');
    sidebarResize.setPointerCapture(event.pointerId);
  });
  sidebarResize.addEventListener('pointermove', event => {
    if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;
    preferredSidebarWidth = setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
  });
  sidebarResize.addEventListener('pointerup', finishSidebarResize);
  sidebarResize.addEventListener('pointercancel', finishSidebarResize);
  sidebarResize.addEventListener('lostpointercapture', finishSidebarResize);
  sidebarResize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = Number.parseFloat(sidebar.style.getPropertyValue('--sidebar-width'));
    preferredSidebarWidth = setSidebarWidth(event.key === 'Home' ? 0 : event.key === 'End' ? innerWidth : width + (event.key === 'ArrowRight' ? 16 : -16));
    write(localStorage, sidebarWidthKey, String(preferredSidebarWidth));
  });
  setSidebarWidth(preferredSidebarWidth);
  addEventListener('resize', () => setSidebarWidth(preferredSidebarWidth));
  const closeSidebar = () => { finishSidebarResize(); sidebar.classList.remove('open'); backdrop.classList.remove('open'); write(localStorage, sidebarKey, 'closed'); render(); };
  const openSidebar = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); write(localStorage, sidebarKey, 'open'); render(); };
  document.getElementById('sidebar-toggle').addEventListener('click', () => { if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar(); });
  backdrop.addEventListener('click', closeSidebar);
  const pinnedMinHeight = 96;
  let pinnedDrag = null;
  function clampPinnedHeight(value) {
    const maximum = Math.max(pinnedMinHeight, Math.floor(innerHeight * 0.8));
    return Math.min(Math.max(value, pinnedMinHeight), maximum);
  }
  function setPinnedHeight(value) {
    const next = clampPinnedHeight(value);
    pinned.style.setProperty('--pinned-h', next + 'px');
    pinnedResize.setAttribute('aria-valuemin', String(pinnedMinHeight));
    pinnedResize.setAttribute('aria-valuemax', String(Math.round(Math.max(pinnedMinHeight, innerHeight * 0.8))));
    pinnedResize.setAttribute('aria-valuenow', String(Math.round(next)));
    return next;
  }
  function updatePinnedBounds() {
    const current = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
    if (Number.isFinite(current)) setPinnedHeight(current);
  }
  function finishPinnedResize(event) {
    if (!pinnedDrag || (event && event.pointerId !== pinnedDrag.pointerId)) return;
    const pointerId = pinnedDrag.pointerId;
    pinnedDrag = null;
    document.body.classList.remove('resizing-pinned');
    if (pinnedResize.hasPointerCapture(pointerId)) pinnedResize.releasePointerCapture(pointerId);
    const height = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
    if (Number.isFinite(height)) write(localStorage, pinnedHKey, String(height));
  }
  pinnedResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pinned.hidden || pinnedDrag) return;
    event.preventDefault();
    pinnedDrag = { pointerId: event.pointerId, startY: event.clientY, startH: pinned.getBoundingClientRect().height };
    document.body.classList.add('resizing-pinned');
    pinnedResize.setPointerCapture(event.pointerId);
  });
  pinnedResize.addEventListener('pointermove', event => {
    if (!pinnedDrag || pinnedDrag.pointerId !== event.pointerId) return;
    setPinnedHeight(pinnedDrag.startH + event.clientY - pinnedDrag.startY);
  });
  pinnedResize.addEventListener('pointerup', finishPinnedResize);
  pinnedResize.addEventListener('pointercancel', finishPinnedResize);
  pinnedResize.addEventListener('lostpointercapture', finishPinnedResize);
  addEventListener('resize', updatePinnedBounds);
  const savedPinnedHeight = Number.parseFloat(read(localStorage, pinnedHKey) || '');
  if (Number.isFinite(savedPinnedHeight)) setPinnedHeight(savedPinnedHeight);
  const outlineResize = document.getElementById('outline-resize'); let resizing = false; let startY = 0; let startH = 0;
  function availableOutlineHeight() {
    return Math.max(0, Math.floor(sidebar.querySelector('.sidebar-footer').getBoundingClientRect().top - outlineSection.getBoundingClientRect().top - 8));
  }
  function updateOutlineBounds() {
    if (outlineSection.hidden || !sidebar.classList.contains('open')) return;
    outlineSection.style.setProperty('--outline-available', availableOutlineHeight() + 'px');
  }
  const clampHeight = value => Math.min(Math.max(value, 96), availableOutlineHeight());
  const outlineBoundsObserver = new ResizeObserver(updateOutlineBounds);
  outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-content'));
  outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-footer'));
  outlineBoundsObserver.observe(outlineSection);
  addEventListener('resize', updateOutlineBounds);
  sidebar.addEventListener('transitionend', updateOutlineBounds);
  outlineResize.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); resizing = true; startY = event.clientY; startH = outlineSection.getBoundingClientRect().height; sidebar.classList.add('resizing-outline'); outlineResize.setPointerCapture(event.pointerId); });
  outlineResize.addEventListener('pointermove', event => { if (resizing) root.style.setProperty('--outline-h', clampHeight(startH + event.clientY - startY) + 'px'); });
  const endResize = () => { if (!resizing) return; resizing = false; sidebar.classList.remove('resizing-outline'); write(localStorage, outlineHKey, getComputedStyle(root).getPropertyValue('--outline-h').trim()); };
  outlineResize.addEventListener('pointerup', endResize); outlineResize.addEventListener('pointercancel', endResize);
  applyTheme();
  const savedHeight = Number.parseFloat(read(localStorage, outlineHKey) || ''); if (Number.isFinite(savedHeight)) root.style.setProperty('--outline-h', Math.max(96, savedHeight) + 'px');
  if (read(localStorage, sidebarKey) === 'open') { sidebar.classList.add('open'); backdrop.classList.add('open'); }
  render();
  // The first refresh loads the state and the latest page (the page has no
  // head yet, so it reloads), then the reading position is restored.
  let savedView = null;
  try { savedView = JSON.parse(sessionStorage.getItem(viewKey) || 'null'); sessionStorage.removeItem(viewKey); } catch {}
  scheduleRefresh().then(() => requestAnimationFrame(async () => { restoreView(savedView); await fillViewport(); }));
  addEventListener('scroll', () => { if (scrollY < 300) loadOlder(); }, { passive: true });
  addEventListener('pagehide', () => write(sessionStorage, viewKey, JSON.stringify(captureView())));
  // The server pushes a message on every write (Server-Sent Events), so the page
  // refreshes the moment something changes. EventSource reconnects by itself,
  // for example after broadcast is switched. The slow poll is only a safety net.
  // `state` counts pin, Add reply, settings and broadcast switches, which do
  // not move the head, so either value changing means something to show.
  let seenStateVersion = null;
  try {
    new EventSource(withToken('/api/events')).onmessage = event => {
      try {
        const pushed = JSON.parse(event.data);
        const stateChanged = seenStateVersion !== null && pushed.state !== seenStateVersion;
        seenStateVersion = pushed.state;
        if (pushed.head !== seenHead || stateChanged) scheduleRefresh();
      } catch { scheduleRefresh(); }
    };
  } catch {}
  setInterval(scheduleRefresh, 30000);
})();
