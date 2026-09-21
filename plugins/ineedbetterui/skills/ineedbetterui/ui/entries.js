const ineedbetteruiEntries = (() => {
  'use strict';

  const agentColors = ['#245ac7', '#0f8f6b', '#b0602a', '#8a4fc0', '#1f7fa8', '#a8456b', '#5d7a1f', '#3f5bb5'];
  const agentDarkColors = ['#94b7ff', '#5fc79d', '#e0a06a', '#c9a6f5', '#77c6e8', '#f093b2', '#b2cc6a', '#9fb3f2'];

  function create(options) {
    const { document, root, entriesList, markdown, labels, language, getState, getEntries, setPin, setPinReply, makeQrFigure } = options;
    const { escapeHtml, inlineMarkdown, renderMarkdown } = markdown;
    const rendered = new Map();
    let agentView = { show: false };

    function agentColor(name) {
      let hash = 0;
      for (const character of name) hash = (hash * 31 + character.codePointAt(0)) % 100000;
      const index = hash % agentColors.length;
      return (root.dataset.theme === 'dark' ? agentDarkColors : agentColors)[index];
    }

    function bodyHtml(entry) {
      let html = renderMarkdown(entry.body || '');
      const notes = Array.isArray(entry.notes) ? entry.notes : [];
      if (!notes.length) return html;
      const pending = [];
      notes.forEach(note => {
        const content = '<aside class="note" aria-label="' + escapeHtml(labels().note) + ': ' + escapeHtml(note.anchor || '') + '"><strong>' + escapeHtml(note.title || labels().note) + '</strong>' + renderMarkdown(note.text || '') + '</aside>';
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

    function pinButtonIcon(active) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'pin-symbol'); icon.setAttribute('width', '18'); icon.setAttribute('height', '18'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', active ? 'currentColor' : 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true');
      const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathNode.setAttribute('d', 'M16 3 21 8 17 9 14 12 14 16 8 10 12 10 15 7 Z M11 13 4 20'); icon.append(pathNode);
      return icon;
    }

    function pinToggleButton(entryId, active) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'pin-toggle'; button.dataset.active = String(active);
      const label = active ? labels().unpin : labels().pin;
      button.setAttribute('aria-label', label); button.setAttribute('title', label); button.setAttribute('aria-pressed', String(active));
      button.append(pinButtonIcon(active));
      button.addEventListener('click', () => setPin(active ? null : entryId));
      return button;
    }

    function addReplyButton(targetId) {
      const state = getState();
      const active = Boolean(state.pin && state.pin.target === targetId && state.pin.replyActive);
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reply-toggle'; button.dataset.active = String(active); button.textContent = labels().addReply; button.setAttribute('aria-label', active ? labels().addReplyActive : labels().addReply); button.setAttribute('title', active ? labels().addReplyActive : labels().addReply); button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => setPinReply(!active));
      return button;
    }

    function makeChange(entry) {
      const change = document.createElement('div'); change.className = 'doc-change';
      [['removed', entry.patch.old], ['added', entry.patch.new]].forEach(([kind, text]) => {
        if (!text) return;
        const block = document.createElement('div'); block.className = 'doc-change-' + kind; block.innerHTML = renderMarkdown(text); change.append(block);
      });
      return change;
    }

    function makeEntry(entry, isPinned, entryOptions = {}) {
      const state = getState();
      const article = document.createElement('article');
      article.className = 'entry'; article.dataset.kind = entry.kind; article.dataset.entryId = entry.id;
      article.setAttribute('aria-label', labels().kind[entry.kind] || entry.kind);
      if (entryOptions.reply) article.classList.add('reply-entry');
      if (entry.replyTo) article.dataset.replyTo = entry.replyTo;
      if (entry.outlineNo) article.dataset.outlineNo = entry.outlineNo;
      const meta = document.createElement('div'); meta.className = 'entry-meta';
      const time = document.createElement('time'); time.dateTime = entry.time; time.textContent = formatTime(entry.time); meta.append(time);
      if (entry.agent && entryOptions.showAgent) {
        const who = document.createElement('span');
        who.className = 'agent-label'; who.textContent = entry.agent;
        who.style.color = agentColor(entry.agent);
        who.style.borderColor = agentColor(entry.agent);
        who.title = labels().writtenBy + ' ' + entry.agent;
        meta.append(who);
      }
      if (entry.outlineNo) {
        const item = (state.outline || []).find(row => row.no === entry.outlineNo);
        const step = document.createElement('span'); step.className = 'step-label';
        step.textContent = entry.outlineNo + (item ? ' ' + item.title : '');
        step.title = labels().outlineStep; meta.append(step);
      }
      if (isPinned || (entryOptions.showPin !== false && entry.kind !== 'question')) {
        const actions = document.createElement('div'); actions.className = 'entry-actions';
        if (isPinned) actions.append(addReplyButton(entry.id));
        actions.append(pinToggleButton(entry.id, isPinned || Boolean(state.pin && state.pin.target === entry.id)));
        meta.append(actions);
      }
      article.append(meta);
      // Turns the agent lost before this one: the transcript says so rather
      // than letting the conversation look continuous.
      if (Array.isArray(entry.missedTurns) && entry.missedTurns.length) {
        const gap = document.createElement('p');
        gap.className = 'turn-gap';
        const list = entry.missedTurns;
        const range = list.length === 1 ? String(list[0]) : list[0] + '-' + list[list.length - 1];
        gap.textContent = (list.length === 1 ? labels().missedTurn : labels().missedTurns).replace('{turns}', range);
        article.append(gap);
      }
      if (entry.heading) { const heading = document.createElement('h3'); heading.innerHTML = inlineMarkdown(entry.heading); article.append(heading); }
      if (entry.patch && !isPinned) article.append(makeChange(entry));
      else { const body = document.createElement('div'); body.innerHTML = bodyHtml(entry); article.append(body); }
      const qrFigure = makeQrFigure(entry.qr, entry.broadcastUrl);
      if (qrFigure) { article.classList.add('broadcast-entry'); article.append(qrFigure); }
      return article;
    }

    function makePinnedEntry(entry, replies) {
      const article = makeEntry(entry, true);
      if (replies.length) {
        const list = document.createElement('div'); list.className = 'reply-list'; list.setAttribute('aria-label', labels().replies);
        replies.forEach(reply => list.append(makeEntry(reply, false, { reply: true, showPin: false })));
        article.append(list);
      }
      return article;
    }

    function readAgents() {
      const writers = new Set();
      for (const entry of getEntries()) if (entry.agent) writers.add(entry.agent);
      agentView = { show: writers.size > 1 };
    }

    function entryVersion(entry) {
      const state = getState();
      const who = agentView.show && entry.agent ? entry.agent : '';
      const step = entry.outlineNo ? entry.outlineNo + ' ' + ((state.outline || []).find(row => row.no === entry.outlineNo)?.title || '') : '';
      return JSON.stringify([entry.body, entry.heading, entry.questionMode, entry.notes?.length || 0, entry.revisions?.length || 0, Boolean(state.pin && state.pin.target === entry.id), step, who, root.dataset.theme]);
    }

    function render(pinnedId) {
      readAgents();
      const entries = getEntries();
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
          const node = makeEntry(entry, false, { showAgent: agentView.show });
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

    function clear() {
      for (const record of rendered.values()) record.node.remove();
      rendered.clear();
    }

    return { clear, makePinnedEntry, render };
  }

  return { create };
})();
