const ineedbetteruiSettings = (() => {
  'use strict';

  function create({ document, storage, fontSizeKey, fontSizes, labels, read, write, applyFontSize, fetchJson, getState, setState, render, showError }) {
    let busy = false;
    const dirty = new Set();

    function updateDraftUi() {
      const questionMode = document.getElementById('question-mode');
      document.getElementById('question-mode-hint').textContent = questionMode.checked ? labels().questionHintCleaned : labels().questionHintRaw;
      const broadcastToggle = document.getElementById('broadcast-toggle');
      document.getElementById('broadcast-hint').textContent = busy
        ? labels().applying
        : (broadcastToggle.checked ? labels().broadcastHintOn : labels().broadcastHintOff);
      document.getElementById('settings-apply').disabled = busy || dirty.size === 0;
      document.getElementById('settings-save').disabled = busy;
      document.getElementById('settings-cancel').disabled = busy;
      document.querySelectorAll('#settings-panel input, #settings-panel select').forEach(control => { control.disabled = busy; });
    }

    function syncForm(force = false) {
      const state = getState();
      const set = (key, update) => { if (force || !dirty.has(key)) update(); };
      set('questionMode', () => { document.getElementById('question-mode').checked = state.questionMode !== 'raw'; });
      set('fontSize', () => {
        const saved = Number(read(storage, fontSizeKey));
        document.getElementById('font-size').value = String(fontSizes[saved] ? saved : 15);
      });
      set('maxResponseChars', () => { document.getElementById('max-response-chars').value = String(state.maxResponseChars ?? 3000); });
      set('maxUnseenEvents', () => { document.getElementById('max-unseen-events').value = String(state.maxUnseenEvents ?? 20); });
      set('broadcast', () => { document.getElementById('broadcast-toggle').checked = Boolean(state.broadcast && state.broadcast.enabled); });
      updateDraftUi();
    }

    function setOpen(open) {
      if (!open || document.getElementById('settings-overlay').hidden) {
        dirty.clear();
        syncForm(true);
      }
      document.getElementById('settings-overlay').hidden = !open;
      document.getElementById('settings-button').setAttribute('aria-expanded', String(open));
    }

    function cancel() {
      if (busy) return;
      setOpen(false);
      document.getElementById('settings-button').focus();
    }

    function markDirty(key) {
      dirty.add(key);
      updateDraftUi();
    }

    function readNumber(id) {
      const input = document.getElementById(id);
      const value = Number(input.value);
      const valid = input.value.trim() !== '' && Number.isInteger(value) && value >= 0;
      input.setCustomValidity(valid ? '' : 'Enter a whole number of 0 or more.');
      if (!valid) { input.reportValidity(); input.focus(); return null; }
      return value;
    }

    async function apply(closeAfter) {
      if (busy) return;
      if (dirty.size === 0) {
        if (closeAfter) cancel();
        return;
      }
      const maxResponseChars = readNumber('max-response-chars');
      if (maxResponseChars === null) return;
      const maxUnseenEvents = readNumber('max-unseen-events');
      if (maxUnseenEvents === null) return;
      const fontSize = Number(document.getElementById('font-size').value);
      const patch = {};
      if (dirty.has('questionMode')) patch.questionMode = document.getElementById('question-mode').checked ? 'cleaned' : 'raw';
      if (dirty.has('maxResponseChars')) patch.maxResponseChars = maxResponseChars;
      if (dirty.has('maxUnseenEvents')) patch.maxUnseenEvents = maxUnseenEvents;
      if (dirty.has('broadcast')) patch.broadcast = document.getElementById('broadcast-toggle').checked;
      busy = true; render();
      try {
        if (Object.keys(patch).length) {
          const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-Agent': 'user' }, body: JSON.stringify(patch) });
          setState(result.state);
        }
        if (dirty.has('fontSize')) write(storage, fontSizeKey, String(applyFontSize(fontSize)));
        dirty.clear();
        syncForm(true);
        if (closeAfter) setOpen(false);
      } catch (error) {
        showError(error.message);
      } finally {
        busy = false; render();
      }
    }

    return { get busy() { return busy; }, syncForm, setOpen, cancel, markDirty, apply };
  }

  return { create };
})();
