const ineedbetteruiLayout = (() => {
  'use strict';

  const outlineColumnDefaults = [0.12, 0.42, 0.22, 0.24];
  const outlineColumnMinimums = [40, 96, 60, 60];

  function create({ document, window, storage, keys, labels, read, write, render }) {
    const root = document.documentElement;
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('backdrop');
    const sidebarResize = document.getElementById('sidebar-resize');
    const outlineSection = document.getElementById('outline-section');
    const outlineResize = document.getElementById('outline-resize');
    const pinned = document.getElementById('pinned');
    const pinnedScroll = document.getElementById('pinned-scroll');
    const pinnedResize = document.getElementById('pinned-resize');
    let columns = outlineColumnDefaults.slice();
    try {
      const saved = JSON.parse(read(storage, keys.outlineColumns) || 'null');
      if (Array.isArray(saved) && saved.length === outlineColumnDefaults.length && saved.every(value => Number.isFinite(value) && value > 0)) {
        const total = saved.reduce((sum, value) => sum + value, 0);
        if (total > 0) columns = saved.map(value => value / total);
      }
    } catch {}

    function addOutlineColumnHandle(cell, table, colgroup, index) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'outline-column-handle';
      handle.setAttribute('aria-label', labels().resizeColumns);
      handle.setAttribute('title', labels().resizeColumns);
      handle.setAttribute('aria-orientation', 'vertical');
      let drag = null;
      const finish = event => {
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        const currentWidths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
        const total = currentWidths.reduce((sum, width) => sum + width, 0);
        if (total > 0 && currentWidths.every(width => width > 0)) {
          columns = currentWidths.map(width => width / total);
          write(storage, keys.outlineColumns, JSON.stringify(columns));
        }
        drag = null;
        document.body.classList.remove('resizing-outline-columns');
      };
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const widths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
        const pairTotal = widths[index] + widths[index + 1];
        if (pairTotal < outlineColumnMinimums[index] + outlineColumnMinimums[index + 1]) return;
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

    let sidebarDrag = null;
    let preferredSidebarWidth = Number.parseFloat(read(storage, keys.sidebarWidth) || '') || 0;
    function setSidebarWidth(width) {
      const minimum = Math.min(window.innerWidth * 0.84, 320);
      const maximum = Math.min(minimum * 2, window.innerWidth);
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
      write(storage, keys.sidebarWidth, String(preferredSidebarWidth));
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
      preferredSidebarWidth = setSidebarWidth(event.key === 'Home' ? 0 : event.key === 'End' ? window.innerWidth : width + (event.key === 'ArrowRight' ? 16 : -16));
      write(storage, keys.sidebarWidth, String(preferredSidebarWidth));
    });
    setSidebarWidth(preferredSidebarWidth);
    window.addEventListener('resize', () => setSidebarWidth(preferredSidebarWidth));
    const closeSidebar = () => { finishSidebarResize(); sidebar.classList.remove('open'); backdrop.classList.remove('open'); write(storage, keys.sidebar, 'closed'); render(); };
    const openSidebar = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); write(storage, keys.sidebar, 'open'); render(); };
    document.getElementById('sidebar-toggle').addEventListener('click', () => { if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar(); });
    backdrop.addEventListener('click', closeSidebar);

    const pinnedMinHeight = 96;
    const pinnedChromeHeight = () => pinned.getBoundingClientRect().height - pinnedScroll.getBoundingClientRect().height;
    let pinnedDrag = null;
    function pinnedContentHeight() {
      const content = pinnedScroll.firstElementChild;
      return content ? content.getBoundingClientRect().height : 0;
    }
    function pinnedMaxHeight() {
      const whole = pinnedContentHeight() + pinnedChromeHeight();
      return Math.max(pinnedMinHeight, Math.min(Math.floor(window.innerHeight * 0.5), Math.ceil(whole)));
    }
    let pinnedAtMax = true;
    let preferredPinnedHeight = null;
    let pinnedShown = null;
    function setPinnedHeight(value, track) {
      const maximum = pinnedMaxHeight();
      const next = Math.min(Math.max(value, pinnedMinHeight), maximum);
      if (track) {
        pinnedAtMax = next >= maximum - 0.5;
        preferredPinnedHeight = next;
      }
      pinned.style.setProperty('--pinned-h', next + 'px');
      pinnedResize.setAttribute('aria-valuemin', String(pinnedMinHeight));
      pinnedResize.setAttribute('aria-valuemax', String(maximum));
      pinnedResize.setAttribute('aria-valuenow', String(Math.round(next)));
      return next;
    }
    function updatePinnedBounds() {
      const current = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
      if (Number.isFinite(current)) setPinnedHeight(current);
    }
    function applyPinnedHeight() {
      if (pinned.hidden) return;
      if (pinnedAtMax) { setPinnedHeight(pinnedMaxHeight()); return; }
      const current = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
      const preferred = Number.isFinite(preferredPinnedHeight) ? preferredPinnedHeight : current;
      setPinnedHeight(Number.isFinite(preferred) ? preferred : pinnedMaxHeight());
    }
    function syncPinned(shown) {
      if (shown === pinnedShown) return;
      pinnedShown = shown;
      if (shown) window.requestAnimationFrame(applyPinnedHeight);
    }
    function finishPinnedResize(event) {
      if (!pinnedDrag || (event && event.pointerId !== pinnedDrag.pointerId)) return;
      const { pointerId } = pinnedDrag;
      pinnedDrag = null;
      document.body.classList.remove('resizing-pinned');
      if (pinnedResize.hasPointerCapture(pointerId)) pinnedResize.releasePointerCapture(pointerId);
      const height = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
      if (Number.isFinite(height)) write(storage, keys.pinnedHeight, String(height));
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
      setPinnedHeight(pinnedDrag.startH + event.clientY - pinnedDrag.startY, true);
    });
    pinnedResize.addEventListener('pointerup', finishPinnedResize);
    pinnedResize.addEventListener('pointercancel', finishPinnedResize);
    pinnedResize.addEventListener('lostpointercapture', finishPinnedResize);
    pinnedResize.addEventListener('keydown', event => {
      const step = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0;
      if (!step) return;
      event.preventDefault();
      write(storage, keys.pinnedHeight, String(setPinnedHeight(pinned.getBoundingClientRect().height + step, true)));
    });
    window.addEventListener('resize', updatePinnedBounds);
    const savedPinnedHeight = Number.parseFloat(read(storage, keys.pinnedHeight) || '');
    // The pinned content is rendered later. Keep the saved value unbounded until
    // syncPinned() can clamp it against the actual message height.
    if (Number.isFinite(savedPinnedHeight)) {
      pinnedAtMax = false;
      preferredPinnedHeight = savedPinnedHeight;
      pinned.style.setProperty('--pinned-h', savedPinnedHeight + 'px');
    }

    function availableOutlineHeight() {
      return Math.max(0, Math.floor(sidebar.querySelector('.sidebar-footer').getBoundingClientRect().top - outlineSection.getBoundingClientRect().top - 8));
    }
    function updateOutlineBounds() {
      if (outlineSection.hidden || !sidebar.classList.contains('open')) return;
      outlineSection.style.setProperty('--outline-available', availableOutlineHeight() + 'px');
    }
    const clampOutlineHeight = value => Math.min(Math.max(value, 96), availableOutlineHeight());
    let outlineDrag = null;
    const outlineBoundsObserver = new ResizeObserver(updateOutlineBounds);
    outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-content'));
    outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-footer'));
    outlineBoundsObserver.observe(outlineSection);
    window.addEventListener('resize', updateOutlineBounds);
    sidebar.addEventListener('transitionend', updateOutlineBounds);
    outlineResize.addEventListener('pointerdown', event => {
      if (event.button !== 0 || outlineDrag) return;
      event.preventDefault();
      outlineDrag = { pointerId: event.pointerId, startY: event.clientY, startH: outlineSection.getBoundingClientRect().height };
      sidebar.classList.add('resizing-outline');
      outlineResize.setPointerCapture(event.pointerId);
    });
    outlineResize.addEventListener('pointermove', event => {
      if (!outlineDrag || outlineDrag.pointerId !== event.pointerId) return;
      root.style.setProperty('--outline-h', clampOutlineHeight(outlineDrag.startH + event.clientY - outlineDrag.startY) + 'px');
    });
    const finishOutlineResize = event => {
      if (!outlineDrag || (event && event.pointerId !== outlineDrag.pointerId)) return;
      outlineDrag = null;
      sidebar.classList.remove('resizing-outline');
      write(storage, keys.outlineHeight, getComputedStyle(root).getPropertyValue('--outline-h').trim());
    };
    outlineResize.addEventListener('pointerup', finishOutlineResize);
    outlineResize.addEventListener('pointercancel', finishOutlineResize);

    const savedOutlineHeight = Number.parseFloat(read(storage, keys.outlineHeight) || '');
    if (Number.isFinite(savedOutlineHeight)) root.style.setProperty('--outline-h', Math.max(96, savedOutlineHeight) + 'px');
    if (read(storage, keys.sidebar) === 'open') { sidebar.classList.add('open'); backdrop.classList.add('open'); }

    return {
      get columns() { return columns; },
      addOutlineColumnHandle,
      syncPinned
    };
  }

  return { create };
})();
