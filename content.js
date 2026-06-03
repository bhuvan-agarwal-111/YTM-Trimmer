// YTM Trimmer — content script
// Runs on music.youtube.com

(function () {
  'use strict';
  console.log('[YTM Trimmer] content script loaded, url:', location.href);

  // ── State ──────────────────────────────────────────────────────────────────
  let currentVideoId = null;
  let trimData = {};        // { videoId: { intervals: [{start, end}], enabled, title } }
  let panelVisible = false;
  let lastSeekTime = -1;
  let videoListenersAttached = false;
  let toastTimeout = null;
  let currentVideoEl = null; // track current video element for cleanup
  let isVideoReady = true;
  let isProgrammaticSeek = false;
  let trimSuspendedForThisPlay = false;

  // ── Helper ────────────────────────────────────────────────────────────────
  function getSongTitle() {
    const titleEl = document.querySelector('ytmusic-player-bar .title');
    return titleEl ? titleEl.textContent.trim() : 'Unknown Song';
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  // Migrates legacy {start, end} → {intervals: [{start, end}]}
  function migrateEntry(entry) {
    if (entry && Array.isArray(entry.intervals)) return entry;
    return {
      intervals: [{ start: entry?.start ?? 0, end: entry?.end ?? 0 }],
      enabled: entry?.enabled ?? true,
      title: entry?.title ?? ''
    };
  }

  function loadTrimData() {
    chrome.storage.sync.get(null, (items) => {
      trimData = {};
      for (const [key, val] of Object.entries(items || {})) {
        trimData[key] = migrateEntry(val);
      }
    });
  }

  function saveTrimData() {
    chrome.storage.sync.set(trimData, () => {
      if (chrome.runtime.lastError) {
        console.warn('[YTM Trimmer] Storage save failed:', chrome.runtime.lastError.message);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (let [key, { newValue }] of Object.entries(changes)) {
        if (newValue) {
          trimData[key] = migrateEntry(newValue);
        } else {
          delete trimData[key];
        }
      }
      if (panelVisible) refreshPanelUI();
      updateProgressBar();
    }
  });

  // ── Video element helpers ─────────────────────────────────────────────────
  function findVideo() {
    return document.querySelector('video');
  }

  function getVideo() {
    return findVideo();
  }

  function attachVideoListeners(videoEl) {
    if (!videoEl || videoListenersAttached) return;
    currentVideoEl = videoEl;
    videoListenersAttached = true;

    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.addEventListener('loadstart', () => { 
      isVideoReady = false; 
      trimSuspendedForThisPlay = false;
    });
    videoEl.addEventListener('loadeddata', () => { isVideoReady = true; });
  }

  function onSeeked() {
    if (isProgrammaticSeek) {
      isProgrammaticSeek = false;
    } else {
      trimSuspendedForThisPlay = true;
      // Sync to trimData so the panel toggle reflects the actual state
      if (currentVideoId && trimData[currentVideoId]) {
        trimData[currentVideoId].enabled = false;
        saveTrimData();
      }
      showToast('Manual seek. Trim paused for this time');
    }
  }

  function onTimeUpdate() {
    enforceTrim();
    updateProgressBar();
  }

  function onLoadedMetadata() {
    lastSeekTime = -1;
    updateProgressBar();
  }

  function onEnded() {
    tryAdvanceQueue();
  }

  function detachVideoListeners() {
    if (currentVideoEl) {
      currentVideoEl.removeEventListener('timeupdate', onTimeUpdate);
      currentVideoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      currentVideoEl.removeEventListener('ended', onEnded);
      currentVideoEl.removeEventListener('seeked', onSeeked);
      currentVideoEl = null;
    }
    videoListenersAttached = false;
  }

  function tryAdvanceQueue() {
    const nextBtn = document.querySelector('ytmusic-player-bar .next-button, tp-yt-paper-icon-button.next-button');
    if (nextBtn) nextBtn.click();
  }

  // ── Current videoId from URL ───────────────────────────────────────────────
  function getCurrentVideoId() {
    const match = location.href.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
  }

  // ── Toast notification ───────────────────────────────────────────────────
  function showToast(msg) {
    requestAnimationFrame(() => {
      let toast = document.getElementById('ytm-trimmer-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'ytm-trimmer-toast';
        document.body.appendChild(toast);
      }

      // Inline styles as fallback (content script CSS can be unreliable for dynamic elements)
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '120px',
        right: '16px',
        background: '#252525',
        color: '#fff',
        padding: '8px 14px',
        borderRadius: '6px',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: '12px',
        zIndex: '999999',
        boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
        opacity: '1',
        transition: 'opacity 0.3s',
        pointerEvents: 'none',
        display: 'block'
      });

      if (toastTimeout) clearTimeout(toastTimeout);
      toast.textContent = msg;
      toast.classList.remove('fade-out');

      toastTimeout = setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
          toast.style.display = 'none';
        }, 350);
      }, 2000);
    });
  }

  // ── Trim helpers (called by keyboard shortcuts and popup) ─────────────────
  function setStartFromCurrentTime() {
    const video = getVideo();
    if (!video || !currentVideoId) {
      showToast('No song detected');
      return;
    }
    const t = video.currentTime;
    if (!trimData[currentVideoId]) {
      trimData[currentVideoId] = { intervals: [{ start: 0, end: 0 }], enabled: false, title: '' };
    }
    if (!trimData[currentVideoId].intervals || trimData[currentVideoId].intervals.length === 0) {
      trimData[currentVideoId].intervals = [{ start: 0, end: 0 }];
    }
    // Modify FIRST interval's start
    const first = trimData[currentVideoId].intervals[0];
    first.start = t;
    trimData[currentVideoId].title = getSongTitle();
    if (first.end === 0) {
      first.end = video.duration || 0;
    }
    saveTrimData();
    updateProgressBar();
    if (panelVisible) refreshPanelUI();
    showToast(`Start set to ${formatTime(t)}`);
  }

  function setEndFromCurrentTime() {
    const video = getVideo();
    if (!video || !currentVideoId) {
      showToast('No song detected');
      return;
    }
    const t = video.currentTime;
    if (!trimData[currentVideoId]) {
      trimData[currentVideoId] = { intervals: [{ start: 0, end: 0 }], enabled: false, title: '' };
    }
    if (!trimData[currentVideoId].intervals || trimData[currentVideoId].intervals.length === 0) {
      trimData[currentVideoId].intervals = [{ start: 0, end: 0 }];
    }
    // Modify LAST interval's end
    const intervals = trimData[currentVideoId].intervals;
    const last = intervals[intervals.length - 1];
    last.end = t;
    trimData[currentVideoId].title = getSongTitle();
    if (last.start >= t) {
      last.start = 0;
    }
    saveTrimData();
    updateProgressBar();
    if (panelVisible) refreshPanelUI();

    // Show guidance message only when all intervals have complete start+end
    const allComplete = intervals.every(iv => iv.start > 0 && iv.end > 0 && iv.start < iv.end);
    if (allComplete) {
      showToast('Enable Added Trim from the dashboard. Click Ctrl+Shift+Y or navigate to the extensions tab.');
    } else {
      showToast(`End set to ${formatTime(t)}`);
    }
  }

  function addInterval() {
    const video = getVideo();
    if (!video || !currentVideoId) return;
    if (!trimData[currentVideoId]) {
      trimData[currentVideoId] = { intervals: [{ start: 0, end: video.duration || 0 }], enabled: false, title: '' };
    } else {
      trimData[currentVideoId].intervals.push({ start: 0, end: video.duration || 0 });
    }
    saveTrimData();
    refreshPanelUI();
    updateProgressBar();
    showToast('Interval added');
  }

  function deleteInterval(index) {
    if (!currentVideoId || !trimData[currentVideoId]) return;
    if (trimData[currentVideoId].intervals.length <= 1) {
      showToast('Cannot delete the only interval');
      return;
    }
    trimData[currentVideoId].intervals.splice(index, 1);
    saveTrimData();
    refreshPanelUI();
    updateProgressBar();
    showToast('Interval deleted');
  }

  function setIntervalBoundary() {
    const video = getVideo();
    if (!video || !currentVideoId) {
      showToast('No song detected');
      return { ok: false, message: 'No song detected' };
    }
    const t = video.currentTime;
    const duration = video.duration || 0;

    // Ensure trimData exists
    if (!trimData[currentVideoId]) {
      trimData[currentVideoId] = { intervals: [{ start: 0, end: 0 }], enabled: false, title: '' };
    }
    const saved = trimData[currentVideoId];
    if (!saved.intervals || saved.intervals.length === 0) {
      saved.intervals = [{ start: 0, end: 0 }];
    }

    const lastInterval = saved.intervals[saved.intervals.length - 1];
    // Is the last interval "open"? (end not set, or at full song duration)
    const isLastOpen = (lastInterval.end === 0 || (duration > 0 && lastInterval.end >= duration - 0.5));

    let message;
    if (isLastOpen) {
      // Close the current playing section at current time
      lastInterval.end = t;
      message = `Section ends at ${formatTime(t)}`;
    } else {
      // Start a new playing section from current time
      saved.intervals.push({ start: t, end: duration });
      message = `New section from ${formatTime(t)}`;
    }

    saved.title = getSongTitle();
    saveTrimData();
    updateProgressBar();
    if (panelVisible) refreshPanelUI();
    showToast(message);
    return { ok: true, message };
  }

  // ── Trim enforcement ─────────────────────────────────────────────────────
  function enforceTrim() {
    if (!isVideoReady) return;
    const video = getVideo();
    if (!video || !currentVideoId || !trimData[currentVideoId]) {
      lastSeekTime = -1;
      return;
    }
    const saved = trimData[currentVideoId];
    // Skip if user manually paused OR if trim is disabled in storage
    if (trimSuspendedForThisPlay && !saved.enabled) {
      lastSeekTime = -1;
      return;
    }
    // Fully disabled?
    if (!saved.enabled) {
      lastSeekTime = -1;
      return;
    }

    const intervals = saved.intervals || [];
    if (intervals.length === 0) return;

    if (video.seeking) return;

    const t = video.currentTime;
    const first = intervals[0];
    const last = intervals[intervals.length - 1];

    // First enforcement for this song — seek to start of first interval
    if (lastSeekTime < 0) {
      if (first && t < first.start) {
        isProgrammaticSeek = true;
        video.currentTime = first.start;
        lastSeekTime = first.start;
        return;
      } else if (first && t >= first.start && t < first.end) {
        lastSeekTime = t;
        return;
      }
      // Otherwise fall through to let enforcement logic handle mid-song starts
      lastSeekTime = t;
    }

    // Check if we're inside any interval — if so, track it
    let activeInterval = null;
    for (const iv of intervals) {
      if (iv.start < iv.end && t >= iv.start && t < iv.end) {
        activeInterval = iv;
        break;
      }
    }

    // If we're before the first interval start, seek forward
    if (activeInterval === null && first && t < first.start) {
      isProgrammaticSeek = true;
      video.currentTime = first.start;
      lastSeekTime = first.start;
      return;
    }

    // If we're inside an interval, let it play; track time
    if (activeInterval !== null) {
      lastSeekTime = t;
      return;
    }

    // We're in a "dead zone" between intervals — skip to next interval start
    for (let i = 0; i < intervals.length - 1; i++) {
      const curr = intervals[i];
      const next = intervals[i + 1];
      if (t >= curr.end && t < next.start) {
        isProgrammaticSeek = true;
        video.currentTime = next.start;
        lastSeekTime = next.start;
        return;
      }
    }

    // We're past the last interval — stop
    if (t >= last.end - 0.1) {
      video.pause();
      if (lastSeekTime !== t) {
        tryAdvanceQueue();
      }
      lastSeekTime = t;
      return;
    }

    lastSeekTime = t;
  }

  // ── UI injection ──────────────────────────────────────────────────────────
  function createPanel() {
    const existing = document.getElementById('ytm-trimmer-panel');
    if (existing) return existing;

    const panel = document.createElement('div');
    panel.id = 'ytm-trimmer-panel';
    panel.innerHTML = `
      <div class="ytm-trimmer-header">
        <span class="ytm-trimmer-title">YTM Trimmer</span>
        <button class="ytm-trimmer-close" aria-label="Close">&times;</button>
      </div>
      <div class="ytm-trimmer-body">
        <div class="ytm-trimmer-intervals" id="ytm-trimmer-intervals"></div>
        <div class="ytm-trimmer-add-row">
          <button class="ytm-trimmer-add-btn" id="ytm-trimmer-add-interval">+ Add Interval</button>
        </div>
        <div class="ytm-trimmer-error" id="ytm-trimmer-error"></div>
        <div class="ytm-trimmer-toggle-row">
          <label class="ytm-trimmer-switch">
            <input type="checkbox" id="ytm-trimmer-enabled" />
            <span class="ytm-trimmer-slider"></span>
          </label>
          <span class="ytm-trimmer-toggle-label">Trim enabled</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    attachPanelListeners(panel);
    return panel;
  }

  function renderIntervalRows(panel) {
    const container = panel.querySelector('#ytm-trimmer-intervals');
    if (!container) return;
    container.innerHTML = '';

    const saved = trimData[currentVideoId] || { intervals: [{ start: 0, end: 0 }], enabled: true, title: '' };
    const intervals = saved.intervals || [];

    intervals.forEach((iv, i) => {
      const row = document.createElement('div');
      row.className = 'ytm-trimmer-iv-row';
      row.dataset.index = i;
      row.innerHTML = `
        <span class="ytm-trimmer-iv-label">${i + 1}</span>
        <input type="text" class="ytm-trimmer-time ytm-trimmer-iv-start" id="ytm-trimmer-start-${i}" placeholder="0:00" value="${iv.start ? formatTime(iv.start) : ''}" />
        <button class="ytm-trimmer-set-btn" data-target="start" data-index="${i}">Set</button>
        <span class="ytm-trimmer-iv-sep">→</span>
        <input type="text" class="ytm-trimmer-time ytm-trimmer-iv-end" id="ytm-trimmer-end-${i}" placeholder="0:00" value="${iv.end ? formatTime(iv.end) : ''}" />
        <button class="ytm-trimmer-set-btn" data-target="end" data-index="${i}">Set</button>
        <button class="ytm-trimmer-del-iv" data-index="${i}" title="Delete interval" ${intervals.length <= 1 ? 'disabled' : ''}>&times;</button>
      `;
      container.appendChild(row);
    });
  }

  function attachPanelListeners(panel) {
    const closeBtn = panel.querySelector('.ytm-trimmer-close');
    const addBtn = panel.querySelector('#ytm-trimmer-add-interval');
    const enabledToggle = panel.querySelector('#ytm-trimmer-enabled');
    const errorEl = panel.querySelector('#ytm-trimmer-error');

    closeBtn.addEventListener('click', () => {
      panelVisible = false;
      panel.classList.remove('visible');
    });

    addBtn.addEventListener('click', () => {
      addInterval();
    });

    // Delegate: Set buttons and interval inputs
    panel.addEventListener('click', (e) => {
      const video = getVideo();
      if (!video) return;

      if (e.target.matches('.ytm-trimmer-set-btn')) {
        const target = e.target.dataset.target; // start or end
        const row = e.target.closest('.ytm-trimmer-iv-row');
        const idx = row ? parseInt(row.dataset.index, 10) : 0;
        const time = formatTime(video.currentTime);
        if (target === 'start') {
          const input = panel.querySelector(`#ytm-trimmer-start-${idx}`);
          if (input) input.value = time;
        } else {
          const input = panel.querySelector(`#ytm-trimmer-end-${idx}`);
          if (input) input.value = time;
        }
        commitTrim();
        return;
      }

      if (e.target.matches('.ytm-trimmer-del-iv')) {
        const idx = parseInt(e.target.dataset.index, 10);
        deleteInterval(idx);
        return;
      }
    });

    panel.addEventListener('change', (e) => {
      if (e.target.matches('.ytm-trimmer-iv-start, .ytm-trimmer-iv-end')) {
        commitTrim();
      }
    });

    enabledToggle.addEventListener('change', commitTrim);

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.add('visible');
    }

    function clearError() {
      errorEl.textContent = '';
      errorEl.classList.remove('visible');
    }

    function commitTrim() {
      if (!currentVideoId) return;
      clearError();

      const saved = trimData[currentVideoId] || { intervals: [{ start: 0, end: 0 }], enabled: true, title: '' };
      const intervals = saved.intervals || [];

      // Collect values from all interval rows
      let hasError = false;
      panel.querySelectorAll('.ytm-trimmer-iv-row').forEach((row, i) => {
        const startInput = row.querySelector(`#ytm-trimmer-start-${i}`);
        const endInput = row.querySelector(`#ytm-trimmer-end-${i}`);
        if (!startInput || !endInput) return;

        const start = parseTime(startInput.value);
        const end = parseTime(endInput.value);

        if (startInput.value.trim() && start === null) {
          startInput.classList.add('ytm-trimmer-invalid');
          showError(`Invalid start time in interval ${i + 1}`);
          hasError = true;
          return;
        }
        if (endInput.value.trim() && end === null) {
          endInput.classList.add('ytm-trimmer-invalid');
          showError(`Invalid end time in interval ${i + 1}`);
          hasError = true;
          return;
        }

        startInput.classList.remove('ytm-trimmer-invalid');
        endInput.classList.remove('ytm-trimmer-invalid');

        if (start !== null && end !== null && start >= end && !(start === 0 && end === 0)) {
          showError(`End must be after start in interval ${i + 1}`);
          hasError = true;
          return;
        }

        if (intervals[i]) {
          intervals[i].start = start ?? 0;
          intervals[i].end = end ?? 0;
        }
      });

      if (hasError) return;

      // Ensure trimData[currentVideoId] and its intervals array exist
      if (!trimData[currentVideoId]) {
        trimData[currentVideoId] = { intervals: [], enabled: true, title: '' };
      }
      if (!Array.isArray(trimData[currentVideoId].intervals)) {
        trimData[currentVideoId].intervals = [];
      }

      // Ensure intervals array is large enough for all rows
      panel.querySelectorAll('.ytm-trimmer-iv-row').forEach((row, i) => {
        while (trimData[currentVideoId].intervals.length <= i) {
          trimData[currentVideoId].intervals.push({ start: 0, end: 0 });
        }
        const startInput = row.querySelector(`#ytm-trimmer-start-${i}`);
        const endInput = row.querySelector(`#ytm-trimmer-end-${i}`);
        if (!startInput || !endInput) return;

        const start = parseTime(startInput.value);
        const end = parseTime(endInput.value);

        trimData[currentVideoId].intervals[i].start = start ?? 0;
        trimData[currentVideoId].intervals[i].end = end ?? 0;
      });

      trimData[currentVideoId].enabled = enabledToggle.checked;
      trimData[currentVideoId].title = getSongTitle();
      saveTrimData();
      updateProgressBar();
    }
  }

  // ── Progress bar trim indicators (one per interval) ────────────────────
  let progressBarIndicators = null; // { start, end, el }

  function createProgressBarIndicators() {
    if (progressBarIndicators) return;
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return;

    progressBarIndicators = [];

    if (window.getComputedStyle(playerBar).position === 'static') {
      playerBar.style.position = 'relative';
    }

    // Create 5 indicator slots (supports up to 5 intervals)
    for (let i = 0; i < 5; i++) {
      const el = document.createElement('div');
      el.className = 'ytm-trimmer-progress-indicator';
      Object.assign(el.style, {
        position: 'absolute',
        top: '0',
        height: '5px',
        background: 'rgba(76, 175, 80, 0.45)',
        zIndex: '9999',
        pointerEvents: 'none',
        display: 'none',
        borderRadius: '2px'
      });
      playerBar.appendChild(el);
      progressBarIndicators.push({ el });
    }
  }

  function updateProgressBar() {
    if (!progressBarIndicators) createProgressBarIndicators();
    const video = getVideo();

    // Hide all first
    if (progressBarIndicators) {
      progressBarIndicators.forEach(({ el }) => { el.style.display = 'none'; });
    }

    if (!video || !currentVideoId || !trimData[currentVideoId]) return;

    const saved = trimData[currentVideoId];
    const intervals = saved.intervals || [];
    if (!video.duration || intervals.length === 0) return;

    intervals.forEach((iv, i) => {
      if (i >= 5) return;
      if (iv.start >= iv.end) return;

      const { el } = progressBarIndicators[i];
      const startPct = (iv.start / video.duration) * 100;
      const endPct = (iv.end / video.duration) * 100;
      el.style.display = 'block';
      el.style.left = `${startPct}%`;
      el.style.width = `${Math.max(0, endPct - startPct)}%`;
    });
  }

  // ── Time formatting / parsing ─────────────────────────────────────────────
  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function parseTime(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    if (!str) return null;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.some(p => p < 0)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  // ── Panel visibility toggle ────────────────────────────────────────────────
  function togglePanel() {
    panelVisible = !panelVisible;
    let panel = document.getElementById('ytm-trimmer-panel');
    if (!panel) {
      panel = createPanel();
    }
    if (panel) {
      panel.classList.toggle('visible', panelVisible);
      if (panelVisible) refreshPanelUI();
    }
  }

  function refreshPanelUI() {
    if (!currentVideoId) return;
    const panel = document.getElementById('ytm-trimmer-panel');
    if (!panel) return;

    const saved = trimData[currentVideoId] || { intervals: [{ start: 0, end: 0 }], enabled: true, title: '' };
    const enabledToggle = panel.querySelector('#ytm-trimmer-enabled');
    const errorEl = panel.querySelector('#ytm-trimmer-error');

    renderIntervalRows(panel);
    enabledToggle.checked = saved.enabled;
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.remove('visible');
    }
  }

  // ── Navigation detection ──────────────────────────────────────────────────
  let lastUrl = location.href;

  function onUrlChange() {
    const newVideoId = getCurrentVideoId();
    if (newVideoId !== currentVideoId) {
      currentVideoId = newVideoId;
      lastSeekTime = -1;
      trimSuspendedForThisPlay = false;
      detachVideoListeners();
      
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const video = getVideo();
        if (video) {
          attachVideoListeners(video);
          clearInterval(poll);
        } else if (attempts > 40) {
          clearInterval(poll);
        }
      }, 250);

      if (panelVisible) refreshPanelUI();
      updateProgressBar();
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    loadTrimData();
    currentVideoId = getCurrentVideoId(); // Initialize immediately from URL

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onUrlChange();
      }
    }, 500);

    const videoPoll = setInterval(() => {
      const video = getVideo();
      if (video) {
        attachVideoListeners(video);
        if (currentVideoId) {
          clearInterval(videoPoll);
        }
      }
    }, 300);

    // Poll for player bar to create progress indicators (player bar loads later than video)
    const playerBarPoll = setInterval(() => {
      const playerBar = document.querySelector('ytmusic-player-bar');
      if (playerBar) {
        createProgressBarIndicators();
        clearInterval(playerBarPoll);
      }
    }, 300);

    // ── Messages from popup ───────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'GET_CURRENT_TIME') {
        const video = getVideo();
        sendResponse({
          currentTime: video?.currentTime ?? 0,
          duration: video?.duration ?? 0,
          videoId: currentVideoId,
          title: getSongTitle(),
          savedTrim: trimData[currentVideoId] ?? null
        });
        return false;
      }
      if (msg.type === 'SAVE_TRIM') {
        const { start, end, enabled, title } = msg;
        if (currentVideoId) {
          if (!trimData[currentVideoId]) {
            trimData[currentVideoId] = { intervals: [{ start: 0, end: 0 }], enabled: false, title: '' };
          }
          if (!trimData[currentVideoId].intervals) {
            trimData[currentVideoId].intervals = [{ start: 0, end: 0 }];
          }
          // Update last interval (backward-compatible with popup buttons)
          const intervals = trimData[currentVideoId].intervals;
          const last = intervals[intervals.length - 1];
          last.start = start;
          last.end = end;
          trimData[currentVideoId].enabled = enabled ?? true;
          if (title) trimData[currentVideoId].title = title;
          saveTrimData();
          updateProgressBar();
          if (panelVisible) refreshPanelUI();
        }
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'SET_INTERVAL_BOUNDARY') {
        const result = setIntervalBoundary();
        sendResponse(result);
        return false;
      }
      if (msg.type === 'GET_TRIM_DATA') {
        chrome.runtime.sendMessage({
          type: 'TRIM_DATA_RESPONSE',
          data: trimData,
          videoId: currentVideoId
        });
      }
      if (msg.type === 'SET_TRIM_PANEL_VISIBLE') {
        panelVisible = msg.visible;
        const panel = document.getElementById('ytm-trimmer-panel');
        if (panel) panel.classList.toggle('visible', panelVisible);
        if (panelVisible) refreshPanelUI();
      }
      // Commands forwarded from background service worker (MV3 commands fire in service worker)
      if (msg.type === 'COMMAND_SET_START') setStartFromCurrentTime();
      if (msg.type === 'COMMAND_SET_END') setEndFromCurrentTime();
      if (msg.type === 'COMMAND_SET_INTERVAL') setIntervalBoundary();
      if (msg.type === 'COMMAND_TOGGLE_PANEL') togglePanel();
    });

    // ── Fallback keydown shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === 'S') { e.preventDefault(); setStartFromCurrentTime(); }
      else if (e.key === 'E') { e.preventDefault(); setEndFromCurrentTime(); }
      else if (e.key === 'D') { e.preventDefault(); setIntervalBoundary(); }
      else if (e.key === 'Y') { e.preventDefault(); togglePanel(); }
    });
  }

  boot();
})();
