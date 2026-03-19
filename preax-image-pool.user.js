// ==UserScript==
// @name         Preax Image Pool
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Two image pools for drag-and-drop paste into Lexical editor on preax.ru/review
// @author       user
// @match        https://preax.ru/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* global MutationObserver, ClipboardEvent, DataTransfer, InputEvent, ClipboardItem */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const pools = [[], []]; // pools[0] = "Баги", pools[1] = "Рекомендации"
  const POOL_KEYWORDS = ['баги', 'рекомендации'];

  // Index of pool in capture mode via header click (yellow border, -1 = none)
  let selectedPoolIdx = -1;
  // Index of pool waiting for next Ctrl+V via 📋 button (-1 = none)
  let clipPendingIdx = -1;
  // Parallel to pools — stores base64 data URLs for localStorage persistence
  const poolDataUrls = [[], []];
  // Tracks last seen editor element and active keyword index for auto-paste
  let lastEditorEl = null;
  let lastActiveIdx = -1;
  // Timer for delayed auto-paste (cancelled/rescheduled on each navigation)
  let autoPasteTimer = null;

  // ─── CSS ─────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #pip-wrapper {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      z-index: 2147483647;
      transition: transform 0.3s ease;
    }

    #pip-wrapper.pip-collapsed {
      transform: translateY(-50%) translateX(calc(100% - 22px));
    }

    #pip-toggle {
      width: 22px;
      height: 64px;
      flex-shrink: 0;
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid #555;
      border-right: none;
      border-radius: 8px 0 0 8px;
      color: #aaa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s, color 0.15s;
    }

    #pip-toggle:hover {
      background: rgba(60, 60, 60, 0.98);
      color: #fff;
    }

    #pip-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 16px;
      padding: 0 12px 0 0;
    }

    .pip-panel {
      width: 20vw;
      height: 20vh;
      min-width: 400px;
      min-height: 130px;
      background: rgba(20, 20, 20, 0.92);
      border: 2px dashed #555;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #eee;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }

    /* Active = h1 matches this pool's keyword AND editor is present */
    .pip-panel.pip-active {
      border-color: #4caf50;
      border-style: solid;
      box-shadow: 0 4px 20px rgba(76,175,80,0.35);
    }

    /* Editor found but h1 matches the OTHER pool's keyword */
    .pip-panel.pip-editor-found {
      border-color: #888;
      border-style: solid;
    }

    .pip-panel.pip-drag-over {
      border-color: #2196f3;
      background: rgba(33, 150, 243, 0.15);
    }

    /* Selected for Ctrl+V → add image to pool */
    .pip-panel.pip-selected {
      border-color: #ffc107;
      border-style: solid;
      box-shadow: 0 4px 20px rgba(255, 193, 7, 0.3);
    }
    .pip-panel.pip-selected .pip-title { color: #ffc107; }

    .pip-header {
      padding: 5px 8px;
      background: rgba(255,255,255,0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      gap: 4px;
      cursor: pointer;
    }

    .pip-title {
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0.4px;
      color: #ccc;
      user-select: none;
    }

    .pip-count {
      font-size: 13px;
      color: #888;
      margin-left: 4px;
    }

    .pip-btn {
      border: none;
      border-radius: 5px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.4;
      transition: opacity 0.1s;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    .pip-btn:hover { opacity: 0.8; }
    .pip-btn:active { opacity: 0.6; }

    .pip-btn-paste {
      background: #4caf50;
      color: #fff;
    }
    .pip-btn-paste:disabled {
      background: #444;
      color: #777;
      cursor: not-allowed;
    }

    .pip-btn-clip {
      background: #1565c0;
      color: #fff;
    }

    .pip-btn-clear {
      background: #c62828;
      color: #fff;
    }

    .pip-dropzone {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px;
      align-content: flex-start;
      cursor: pointer;
    }

    .pip-placeholder {
      width: 100%;
      text-align: center;
      color: #666;
      padding-top: 14px;
      pointer-events: none;
      user-select: none;
      font-size: 13px;
      line-height: 1.5;
    }

    .pip-thumb-wrap {
      position: relative;
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }

    .pip-thumb {
      width: 44px;
      height: 44px;
      object-fit: cover;
      border-radius: 5px;
      border: 1px solid #333;
      display: block;
      cursor: pointer;
    }

    .pip-thumb-del {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #c62828;
      color: #fff;
      cursor: pointer;
      border: none;
      padding: 0;
      opacity: 0;
      transition: opacity 0.12s;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .pip-thumb-wrap:hover .pip-thumb-del {
      opacity: 1;
    }

    .pip-status {
      font-size: 13px;
      color: #aaa;
      padding: 2px 8px 4px;
      flex-shrink: 0;
      min-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #pip-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.9);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 2147483646;
    }

    #pip-modal.pip-modal-open {
      display: flex;
    }

    #pip-modal-img {
      max-width: 90vw;
      max-height: 90vh;
      object-fit: contain;
    }

    #pip-modal-close {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }

    #pip-modal-close:hover {
      background: rgba(255, 255, 255, 0.35);
    }

    .pip-modal-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.15);
      border: none;
      color: #fff;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      z-index: 1;
    }

    .pip-modal-arrow:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    .pip-modal-arrow.pip-modal-arrow-show {
      display: flex;
    }

    #pip-modal-prev {
      left: 30px;
    }

    #pip-modal-next {
      right: 30px;
    }

    #pip-modal-thumbnails {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      gap: 6px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 8px;
      max-width: 90vw;
      overflow-x: auto;
    }

    #pip-modal-thumbnails.pip-modal-thumbnails-show {
      display: flex;
    }

    .pip-modal-thumb-wrap {
      position: relative;
      width: 50px;
      height: 50px;
      flex-shrink: 0;
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.15s;
    }

    .pip-modal-thumb-wrap:hover,
    .pip-modal-thumb-wrap.pip-modal-thumb-active {
      opacity: 1;
    }

    .pip-modal-thumb {
      width: 50px;
      height: 50px;
      object-fit: cover;
      border-radius: 4px;
      border: 2px solid transparent;
      display: block;
    }

    .pip-modal-thumb-wrap.pip-modal-thumb-active .pip-modal-thumb {
      border-color: #fff;
    }

    .pip-modal-thumb-del {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #c62828;
      color: #fff;
      cursor: pointer;
      border: none;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.12s;
    }

    .pip-modal-thumb-wrap:hover .pip-modal-thumb-del {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);

  // ─── Icons (24×24 filled SVG paths) ──────────────────────────────────────────
  function icon(path, size) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="${path}"/></svg>`;
  }
  const IC_CLIP  = 'M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z';
  const IC_TRASH = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
  const IC_CLOSE = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
  const IC_RIGHT = 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z';
  const IC_LEFT  = 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z';

  // ─── Build UI ─────────────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.id = 'pip-wrapper';

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'pip-toggle';
  toggleBtn.innerHTML = icon(IC_RIGHT, 14);
  toggleBtn.title = 'Скрыть / показать панели';
  toggleBtn.addEventListener('click', toggleCollapsed);
  wrapper.appendChild(toggleBtn);

  const container = document.createElement('div');
  container.id = 'pip-container';

  const panels = [0, 1].map((idx) => buildPanel(idx));
  panels.forEach((p) => container.appendChild(p.el));
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  // ─── Modal ────────────────────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'pip-modal';
  modal.innerHTML = `
    <button id="pip-modal-close">${icon(IC_CLOSE, 24)}</button>
    <button id="pip-modal-prev" class="pip-modal-arrow">${icon(IC_LEFT, 24)}</button>
    <button id="pip-modal-next" class="pip-modal-arrow">${icon(IC_RIGHT, 24)}</button>
    <img id="pip-modal-img" alt="">
    <div id="pip-modal-thumbnails"></div>
  `;
  document.body.appendChild(modal);

  const modalImg = modal.querySelector('#pip-modal-img');
  const modalClose = modal.querySelector('#pip-modal-close');
  const modalPrev = modal.querySelector('#pip-modal-prev');
  const modalNext = modal.querySelector('#pip-modal-next');
  const modalThumbnails = modal.querySelector('#pip-modal-thumbnails');

  // State for modal navigation
  let modalCurrentIdx = -1;
  let modalCurrentPoolIdx = -1;

  function updateModalArrows() {
    const pool = pools[modalCurrentPoolIdx];
    const hasPrev = pool && pool.length > 1;
    modalPrev.classList.toggle('pip-modal-arrow-show', hasPrev);
    modalNext.classList.toggle('pip-modal-arrow-show', hasPrev);
  }

  function renderModalThumbnails() {
    if (modalCurrentPoolIdx === -1) return;

    const pool = pools[modalCurrentPoolIdx];
    const dataUrls = poolDataUrls[modalCurrentPoolIdx];

    modalThumbnails.innerHTML = '';

    if (pool.length <= 1) {
      modalThumbnails.classList.remove('pip-modal-thumbnails-show');
      return;
    }

    pool.forEach((file, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'pip-modal-thumb-wrap' + (idx === modalCurrentIdx ? ' pip-modal-thumb-active' : '');

      const img = document.createElement('img');
      img.className = 'pip-modal-thumb';
      img.src = dataUrls[idx];
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        modalCurrentIdx = idx;
        modalImg.src = dataUrls[idx];
        renderModalThumbnails();
      });

      const del = document.createElement('button');
      del.className = 'pip-modal-thumb-del';
      del.innerHTML = icon(IC_CLOSE, 9);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapEl = getWrapByDataUrl(dataUrls[idx]);
        removeFromPool(modalCurrentPoolIdx, wrapEl);
        // After removal, adjust index or close modal
        if (poolDataUrls[modalCurrentPoolIdx].length === 0) {
          closeModal();
          return;
        }
        // Adjust index: if deleted last item, go to new last; otherwise stay at same index
        if (idx >= poolDataUrls[modalCurrentPoolIdx].length) {
          modalCurrentIdx = poolDataUrls[modalCurrentPoolIdx].length - 1;
        } else {
          modalCurrentIdx = idx;
        }
        modalImg.src = poolDataUrls[modalCurrentPoolIdx][modalCurrentIdx];
        renderModalThumbnails();
      });

      wrap.appendChild(img);
      wrap.appendChild(del);
      modalThumbnails.appendChild(wrap);
    });

    modalThumbnails.classList.add('pip-modal-thumbnails-show');
  }

  function getWrapByDataUrl(dataUrl) {
    // Find the wrap element in the dropzone by matching img src
    for (let idx = 0; idx < pools.length; idx++) {
      const dataUrls = poolDataUrls[idx];
      const foundIdx = dataUrls.indexOf(dataUrl);
      if (foundIdx !== -1) {
        const dropzone = document.getElementById(`pip-dropzone-${idx}`);
        const wraps = Array.from(dropzone.querySelectorAll('.pip-thumb-wrap'));
        if (wraps[foundIdx]) return wraps[foundIdx];
      }
    }
    return null;
  }

  function openModal(src, poolIdx = -1, imgIdx = -1) {
    modalImg.src = src;
    modal.classList.add('pip-modal-open');
    modalCurrentIdx = imgIdx;
    modalCurrentPoolIdx = poolIdx;
    wrapper.style.display = 'none'; // Hide pools when modal is open
    updateModalArrows();
    renderModalThumbnails();
  }

  function closeModal() {
    modal.classList.remove('pip-modal-open');
    modalImg.src = '';
    modalCurrentIdx = -1;
    modalCurrentPoolIdx = -1;
    wrapper.style.display = ''; // Show pools again
    modalThumbnails.classList.remove('pip-modal-thumbnails-show');
  }

  function navigateModal(direction) {
    if (modalCurrentPoolIdx === -1 || modalCurrentIdx === -1) return;
    const pool = pools[modalCurrentPoolIdx];
    if (!pool || pool.length < 2) return;

    let newIdx = modalCurrentIdx + direction;
    if (newIdx < 0) newIdx = pool.length - 1;
    if (newIdx >= pool.length) newIdx = 0;

    modalCurrentIdx = newIdx;
    modalImg.src = poolDataUrls[modalCurrentPoolIdx][newIdx];
    updateModalArrows();
    renderModalThumbnails();
  }

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  modalPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateModal(-1);
  });
  modalNext.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateModal(1);
  });
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('pip-modal-open')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'ArrowLeft') navigateModal(-1);
    if (e.key === 'ArrowRight') navigateModal(1);
  });

  // ─── URL visibility guard ─────────────────────────────────────────────────────
  function isReviewPage() {
    return window.location.href.includes('preax.ru/review');
  }

  function syncVisibility() {
    wrapper.style.display = isReviewPage() ? '' : 'none';
  }

  // Intercept SPA history mutations
  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      const result = orig.apply(this, args);
      syncVisibility();
      return result;
    };
  });
  window.addEventListener('popstate', syncVisibility);

  syncVisibility(); // initial check

  // Restore collapsed state
  if (localStorage.getItem('pip-collapsed') === '1') {
    wrapper.classList.add('pip-collapsed');
    toggleBtn.innerHTML = icon(IC_LEFT, 14);
  }

  function toggleCollapsed() {
    const collapsed = wrapper.classList.toggle('pip-collapsed');
    toggleBtn.innerHTML = icon(collapsed ? IC_LEFT : IC_RIGHT, 14);
    localStorage.setItem('pip-collapsed', collapsed ? '1' : '0');
  }

  function buildPanel(idx) {
    const keyword = POOL_KEYWORDS[idx];
    const label = keyword.charAt(0).toUpperCase() + keyword.slice(1);

    const el = document.createElement('div');
    el.className = 'pip-panel';
    el.dataset.pool = idx;

    const header = document.createElement('div');
    header.className = 'pip-header';

    const titleWrap = document.createElement('span');
    titleWrap.style.cssText = 'display:flex;align-items:center;flex:1;min-width:0';
    titleWrap.innerHTML = `<span class="pip-title">${label}</span><span class="pip-count" id="pip-count-${idx}">0 фото</span>`;

    const btnClip = document.createElement('button');
    btnClip.className = 'pip-btn pip-btn-clip';
    btnClip.innerHTML = icon(IC_CLIP, 15);
    btnClip.title = 'Вставить из буфера / активировать Ctrl+V захват';
    btnClip.addEventListener('click', () => readClipboardToPool(idx));

    const btnPaste = document.createElement('button');
    btnPaste.className = 'pip-btn pip-btn-paste';
    btnPaste.innerHTML = 'Вставить';
    btnPaste.disabled = true;
    btnPaste.id = `pip-paste-${idx}`;
    btnPaste.addEventListener('click', () => pastePool(idx));

    const btnClear = document.createElement('button');
    btnClear.className = 'pip-btn pip-btn-clear';
    btnClear.innerHTML = icon(IC_TRASH, 15);
    btnClear.title = 'Очистить пул';
    btnClear.addEventListener('click', () => clearPool(idx));

    // Click on header area (not on a button) → toggle capture mode
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectPool(idx);
    });

    header.appendChild(titleWrap);
    header.appendChild(btnClip);
    header.appendChild(btnPaste);
    header.appendChild(btnClear);

    const dropzone = document.createElement('div');
    dropzone.className = 'pip-dropzone';
    dropzone.id = `pip-dropzone-${idx}`;
    dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или нажмите для выбора</div>`;

    dropzone.addEventListener('click', () => pickFiles(idx));
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('pip-drag-over');
    });
    dropzone.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('pip-drag-over');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('pip-drag-over');
      Array.from(e.dataTransfer.files)
        .filter((f) => f.type.startsWith('image/'))
        .forEach((f) => addToPool(idx, f));
    });

    const status = document.createElement('div');
    status.className = 'pip-status';
    status.id = `pip-status-${idx}`;

    el.appendChild(header);
    el.appendChild(dropzone);
    el.appendChild(status);

    return { el, dropzone, btnPaste, status };
  }

  // ─── File handling ────────────────────────────────────────────────────────────
  async function readClipboardToPool(idx) {
    try {
      const perm = await navigator.permissions.query({ name: 'clipboard-read' });
      if (perm.state !== 'granted') {
        clipPendingIdx = idx;
        setStatus(idx, '← нажмите Ctrl+V');
        return;
      }
    } catch {
      // Permissions API unavailable — try reading directly
    }

    try {
      const items = await navigator.clipboard.read();
      let added = 0;
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const file = new File([blob], `clip-${Date.now()}-${added}.${ext}`, { type });
            addToPool(idx, file);
            added++;
          }
        }
      }
      if (added === 0) {
        setStatus(idx, '⚠ В буфере нет изображения');
      } else {
        navigator.clipboard.writeText('').catch(() => {});
      }
    } catch {
      clipPendingIdx = idx;
      setStatus(idx, '← нажмите Ctrl+V');
    }
  }

  function pickFiles(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => Array.from(input.files).forEach((f) => addToPool(idx, f));
    input.click();
  }

  // ─── localStorage persistence ─────────────────────────────────────────────────
  function savePool(idx) {
    try {
      const data = poolDataUrls[idx].map((dataUrl, i) => ({
        dataUrl,
        name: pools[idx][i]?.name || `image-${i}.png`,
        type: pools[idx][i]?.type || 'image/png',
      }));
      localStorage.setItem(`pip-pool-${idx}`, JSON.stringify(data));
    } catch {
      setStatus(idx, '⚠ localStorage переполнен');
    }
  }

  function dataUrlToFile(dataUrl, name, type) {
    const [, base64] = dataUrl.split(',');
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new File([arr], name, { type });
  }

  function loadAllPools() {
    [0, 1].forEach((idx) => {
      try {
        const stored = localStorage.getItem(`pip-pool-${idx}`);
        if (!stored) return;
        const items = JSON.parse(stored);
        items.forEach(({ dataUrl, name, type }) => {
          addToPool(idx, dataUrlToFile(dataUrl, name, type), dataUrl);
        });
      } catch {
        localStorage.removeItem(`pip-pool-${idx}`);
      }
    });
  }

  // ─── File handling ─────────────────────────────────────────────────────────────
  function addToPool(idx, file, existingDataUrl = null) {
    pools[idx].push(file);

    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    const placeholder = dropzone.querySelector('.pip-placeholder');
    if (placeholder) placeholder.remove();

    const wrap = document.createElement('div');
    wrap.className = 'pip-thumb-wrap';

    const del = document.createElement('button');
    del.className = 'pip-thumb-del';
    del.innerHTML = icon(IC_CLOSE, 9);
    del.title = 'Удалить';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const wraps = Array.from(dropzone.querySelectorAll('.pip-thumb-wrap'));
      const idxInPool = wraps.indexOf(wrap);
      const deletedDataUrl = poolDataUrls[idx][idxInPool];
      const currentModalSrc = modalImg.src;
      removeFromPool(idx, wrap);
      // Close modal if deleted image is currently displayed
      if (deletedDataUrl === currentModalSrc) {
        closeModal();
      }
      // Refresh modal thumbnails if modal is open
      if (modal.classList.contains('pip-modal-open') && modalCurrentPoolIdx === idx) {
        renderModalThumbnails();
      }
    });

    const renderThumb = (dataUrl, idx) => {
      poolDataUrls[idx].push(dataUrl);
      savePool(idx);
      const img = document.createElement('img');
      img.className = 'pip-thumb';
      img.src = dataUrl;
      wrap.appendChild(img);
      wrap.appendChild(del);
      dropzone.appendChild(wrap);

      wrap.addEventListener('click', (e) => {
        if (e.target === del) return;
        e.stopPropagation();
        const wraps = Array.from(dropzone.querySelectorAll('.pip-thumb-wrap'));
        const imgIdx = wraps.indexOf(wrap);
        openModal(dataUrl, idx, imgIdx);
      });
    };

    if (existingDataUrl) {
      renderThumb(existingDataUrl, idx);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => renderThumb(e.target.result, idx);
      reader.readAsDataURL(file);
    }

    updateCount(idx);
  }

  function removeFromPool(idx, wrapEl) {
    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    const wraps = Array.from(dropzone.querySelectorAll('.pip-thumb-wrap'));
    const pos = wraps.indexOf(wrapEl);
    if (pos !== -1) {
      pools[idx].splice(pos, 1);
      poolDataUrls[idx].splice(pos, 1);
    }
    wrapEl.remove();
    if (pools[idx].length === 0) {
      dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или нажмите для выбора</div>`;
    }
    updateCount(idx);
    savePool(idx);
  }

  function clearPool(idx) {
    pools[idx] = [];
    poolDataUrls[idx] = [];
    localStorage.removeItem(`pip-pool-${idx}`);
    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или нажмите для выбора</div>`;
    updateCount(idx);
    setStatus(idx, '');
    // Close modal if clearing the pool currently displayed
    if (modalCurrentPoolIdx === idx) {
      closeModal();
    }
  }

  function updateCount(idx) {
    const n = pools[idx].length;
    document.getElementById(`pip-count-${idx}`).textContent = `${n} фото`;
    document.getElementById(`pip-paste-${idx}`).disabled = n === 0;
  }

  function setStatus(idx, text) {
    document.getElementById(`pip-status-${idx}`).textContent = text;
  }

  // ─── H1 + Editor detection ────────────────────────────────────────────────────
  const EDITOR_SELECTOR = 'div[data-lexical-editor="true"][contenteditable="true"]';

  function getEditor() {
    return document.querySelector(EDITOR_SELECTOR);
  }

  function getActivePoolIndex() {
    // Check ALL h1 elements — the page may have navigation h1s before the step header
    for (const h1 of document.querySelectorAll('h1')) {
      const text = h1.textContent.toLowerCase();
      const idx = POOL_KEYWORDS.findIndex((kw) => text.includes(kw));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function updatePanelStates() {
    const editor = getEditor();
    const activeIdx = getActivePoolIndex();

    // Update borders:
    //   pip-active       → this pool's keyword matches h1 (green)
    //   pip-editor-found → editor present, other pool matches (grey)
    //   (no class)       → "Плюсы работы" or no editor (default dashed)
    panels.forEach(({ el }, idx) => {
      el.classList.remove('pip-active', 'pip-editor-found');
      if (editor && activeIdx !== -1) {
        el.classList.add(idx === activeIdx ? 'pip-active' : 'pip-editor-found');
      }
    });

    // Auto-paste triggers when:
    //   • h1 keyword changes (stepChanged): navigated to Баги/Рекомендации from another step
    //   • editor DOM element is replaced (editorReplaced): SPA recreated the editor on same step
    const stepChanged = editor !== null && activeIdx !== -1 && activeIdx !== lastActiveIdx;
    const editorReplaced = editor !== null && activeIdx !== -1 && editor !== lastEditorEl;

    if (stepChanged || editorReplaced) {
      lastEditorEl = editor;
      lastActiveIdx = activeIdx;
      if (pools[activeIdx].length > 0) {
        scheduleAutoPaste(activeIdx);
      }
    }

    // Reset tracking whenever we leave an active keyword page.
    // This ensures auto-paste fires again when the user returns to Баги/Рекомендации.
    if (!editor || activeIdx === -1) {
      lastEditorEl = null;
      lastActiveIdx = -1;
    }
  }

  // Откладывает автовставку на 2.5 с после обнаружения редактора.
  // Если за это время страница сменится — вставка отменяется.
  // При повторном срабатывании таймер сбрасывается и отсчёт начинается заново.
  function scheduleAutoPaste(activeIdx) {
    if (autoPasteTimer !== null) clearTimeout(autoPasteTimer);
    setStatus(activeIdx, '⏳ Вставка через 1 с…');
    autoPasteTimer = setTimeout(async () => {
      autoPasteTimer = null;
      const currentEditor = getEditor();
      const currentIdx = getActivePoolIndex();
      // Проверяем, что страница не изменилась за время ожидания
      if (currentEditor === null || currentIdx !== activeIdx) {
        setStatus(activeIdx, '');
        return;
      }
      if (pools[activeIdx].length === 0) return;
      await pastePool(activeIdx);
    }, 1000);
  }

  // MutationObserver: watch for structural changes (editor appearing/disappearing).
  // No characterData — Lexical fires thousands of text-node mutations while editing.
  let rafScheduled = false;
  function scheduleUpdate() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      updatePanelStates();
    });
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, { childList: true, subtree: true });

  // Poll every 400 ms to catch h1 text changes driven by React state
  // (React updates text nodes in-place — no structural mutation is fired).
  setInterval(updatePanelStates, 400);
  updatePanelStates();
  loadAllPools();

  // ─── Pool selection + Ctrl+V → add to pool ───────────────────────────────────
  function selectPool(idx) {
    selectedPoolIdx = idx;
    panels.forEach(({ el }, i) => el.classList.toggle('pip-selected', i === idx));
  }

  function deselectPool() {
    selectedPoolIdx = -1;
    panels.forEach(({ el }) => el.classList.remove('pip-selected'));
  }

  // Click outside panels → exit capture mode
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) deselectPool();
  }, true);

  // Ctrl+V → add image to pool (header capture mode OR 📋 button pending)
  document.addEventListener('paste', (e) => {
    const targetIdx = selectedPoolIdx !== -1 ? selectedPoolIdx : clipPendingIdx;
    if (targetIdx === -1) return;
    // Don't intercept when a page input/editor has focus
    const active = document.activeElement;
    if (
      active &&
      !container.contains(active) &&
      (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    let added = 0;
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { addToPool(targetIdx, file); added++; }
      }
    }
    clipPendingIdx = -1;
    if (added === 0) {
      setStatus(targetIdx, '⚠ В буфере нет изображения');
    } else {
      setStatus(targetIdx, '');
      navigator.clipboard.writeText('').catch(() => {});
    }
  }, true);

  // ─── Paste pool into editor ───────────────────────────────────────────────────
  async function pastePool(idx) {
    const editor = getEditor();
    if (!editor) { setStatus(idx, '⚠ Поле ввода не найдено'); return; }

    const files = pools[idx];
    if (files.length === 0) { setStatus(idx, '⚠ Пул пуст'); return; }

    for (let i = 0; i < files.length; i++) {
      setStatus(idx, `Вставка ${i + 1} / ${files.length}…`);
      const ok = await pasteFile(idx, files[i]);
      if (!ok) { setStatus(idx, `⚠ Ошибка на фото ${i + 1}`); return; }
      await delay(800);
    }

    setStatus(idx, `✓ Вставлено ${files.length} фото`);
  }

  async function pasteFile(idx, file) {
    const editor = getEditor();
    if (!editor) return false;

    // Strategy 1: write to real clipboard → execCommand('paste')
    let clipOk = false;
    const writePromise = navigator.clipboard
      .write([new ClipboardItem({ [file.type]: file })])
      .then(() => { clipOk = true; })
      .catch(() => {});

    editor.click();
    editor.focus();
    await delay(120);
    await writePromise;

    if (clipOk) {
      const pasted = document.execCommand('paste'); // deprecated but still works in Chromium
      if (pasted) return true;
    }

    // Strategy 2: synthetic ClipboardEvent with DataTransfer
    const dt = new DataTransfer();
    dt.items.add(file);
    if (dt.items.length === 0) { setStatus(idx, '⚠ DataTransfer не поддерживается'); return false; }

    editor.click();
    editor.focus();
    await delay(50);
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));

    // Strategy 3: beforeinput insertFromPaste — triggers Lexical's clipboard read
    if (clipOk) {
      await delay(50);
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste' }));
    }

    return true;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
