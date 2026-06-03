// YTM Trimmer — popup script

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getVideoIdFromUrl(url) {
  const match = url.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

function showPopupToast(msg) {
  // Brief notification inside the popup itself
  let existing = document.getElementById('popup-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'popup-toast';
  toast.textContent = msg;
  toast.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:6px 12px;border-radius:6px;font-size:11px;z-index:1000;opacity:1;transition:opacity 0.3s';
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
}

function setLoading(el, loading) {
  el.disabled = loading;
}

// ── Render saved songs list ────────────────────────────────────────────────
let allTrimData = {};

function renderSongList(data, query = '') {
  const list = document.getElementById('song-list');
  const emptyState = document.getElementById('empty-state');
  const notFound = document.getElementById('song-not-found');
  const searchInput = document.getElementById('song-search');

  allTrimData = data;

  const entries = Object.entries(data);
  const queryLower = query.trim().toLowerCase();

  // Filter by search query
  const filtered = queryLower
    ? entries.filter(([, trim]) => {
        const title = (trim.title || '').toLowerCase();
        return title.includes(queryLower);
      })
    : entries;

  if (entries.length === 0) {
    emptyState.textContent = 'No saved trims yet. Use shortcuts or the panel on YTM to set start/end points.';
    emptyState.style.display = 'block';
    notFound.style.display = 'none';
    list.querySelectorAll('.song-item').forEach(el => el.remove());
    return;
  }

  if (filtered.length === 0) {
    emptyState.style.display = 'none';
    notFound.style.display = 'block';
    list.querySelectorAll('.song-item').forEach(el => el.remove());
    return;
  }

  emptyState.style.display = 'none';
  notFound.style.display = 'none';

  // Remove old items (keep empty state el)
  list.querySelectorAll('.song-item').forEach(el => el.remove());

  filtered.forEach(([videoId, trim]) => {
    const item = document.createElement('div');
    item.className = 'song-item';

    const info = document.createElement('div');
    info.className = 'song-info';

    const vidEl = document.createElement('div');
    vidEl.className = 'song-video-id';
    vidEl.textContent = trim.title || videoId;
    vidEl.title = videoId; // Show ID on hover

    // Migrate or extract intervals
    let intervals = trim.intervals;
    if (!Array.isArray(intervals)) {
      intervals = [{ start: trim.start ?? 0, end: trim.end ?? 0 }];
    }

    const timesEl = document.createElement('div');
    timesEl.className = 'song-times';
    if (intervals.length === 1) {
      timesEl.textContent = `${formatTime(intervals[0].start)} → ${formatTime(intervals[0].end)}`;
    } else {
      timesEl.textContent = `${intervals.length} intervals`;
      timesEl.title = intervals.map(iv => `${formatTime(iv.start)} → ${formatTime(iv.end)}`).join(' | ');
    }

    info.appendChild(vidEl);
    info.appendChild(timesEl);

    const label = document.createElement('label');
    label.className = 'toggle-switch';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.videoId = videoId;
    if (trim.enabled) cb.checked = true;

    const slider = document.createElement('span');
    slider.className = 'toggle-slider';

    label.appendChild(cb);
    label.appendChild(slider);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete trim';

    deleteBtn.addEventListener('click', () => {
      chrome.storage.sync.remove(videoId, () => {
        chrome.storage.sync.get(null, (items) => {
          renderSongList(items || {}, searchInput.value);
        });

        // Refresh current song UI if active tab is the deleted song
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (tab?.url?.includes('music.youtube.com')) {
            chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_TIME' }, (resp) => {
              if (resp) {
                updateCurrentSong(resp);
                const btnSetStart = document.getElementById('btn-set-start');
                const btnSetEnd = document.getElementById('btn-set-end');
                if (resp.savedTrim) {
                  const intervals = Array.isArray(resp.savedTrim.intervals)
                    ? resp.savedTrim.intervals
                    : [{ start: resp.savedTrim.start ?? 0, end: resp.savedTrim.end ?? 0 }];
                  btnSetStart.textContent = `Start: ${formatTime(intervals[0].start)}`;
                  btnSetEnd.textContent = `End: ${formatTime(intervals[intervals.length - 1].end)}`;
                } else {
                  btnSetStart.textContent = 'Set Start';
                  btnSetEnd.textContent = 'Set End';
                }
              }
            });
          }
        });
      });
    });

    item.appendChild(info);
    item.appendChild(label);
    item.appendChild(deleteBtn);
    list.appendChild(item);

    cb.addEventListener('change', (e) => {
      chrome.storage.sync.get(null, (items) => {
        const d = items || {};
        if (d[videoId]) {
          d[videoId].enabled = e.target.checked;
          chrome.storage.sync.set(d, () => {
            if (chrome.runtime.lastError) {
              console.warn('[YTM Trimmer] Toggle save failed:', chrome.runtime.lastError.message);
            }
          });
        }
      });
    });
  });
}

// ── Update current song section ────────────────────────────────────────────
function updateCurrentSong(info) {
  const section = document.getElementById('current-song');
  const notYtm = document.getElementById('not-ytm');

  if (!info || !info.videoId) {
    section.style.display = 'none';
    notYtm.style.display = 'block';
    return;
  }

  notYtm.style.display = 'none';
  section.style.display = 'block';

  document.getElementById('current-song-id').textContent = info.title || info.videoId;

  const timesEl = document.getElementById('current-song-times');
  if (info.savedTrim) {
    const intervals = Array.isArray(info.savedTrim.intervals)
      ? info.savedTrim.intervals
      : [{ start: info.savedTrim.start ?? 0, end: info.savedTrim.end ?? 0 }];
    if (intervals.length === 1) {
      timesEl.textContent = `${formatTime(intervals[0].start)} → ${formatTime(intervals[0].end)}`;
    } else {
      timesEl.textContent = `${intervals.length} intervals`;
      timesEl.title = intervals.map(iv => `${formatTime(iv.start)} → ${formatTime(iv.end)}`).join(' | ');
    }
  } else {
    timesEl.textContent = `Current: ${formatTime(info.currentTime)} / ${formatTime(info.duration)}`;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const btnSetStart = document.getElementById('btn-set-start');
  const btnSetInterval = document.getElementById('btn-set-interval');
  const btnSetEnd = document.getElementById('btn-set-end');

  // Load all saved trim data
  chrome.storage.sync.get(null, (items) => {
    const data = items || {};
    renderSongList(data);
  });

  // ── Search bar ────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('song-search');
  searchInput.addEventListener('input', () => {
    renderSongList(allTrimData, searchInput.value);
  });

  // Check if YTM tab is active
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const isYtm = activeTab?.url?.includes('music.youtube.com');

    if (!isYtm) {
      updateCurrentSong(null);
      btnSetStart.disabled = true;
      btnSetInterval.disabled = true;
      btnSetEnd.disabled = true;
      return;
    }

    // Get current playback state from content script
    chrome.tabs.sendMessage(activeTab.id, { type: 'GET_CURRENT_TIME' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        btnSetStart.disabled = true;
        btnSetInterval.disabled = true;
        btnSetEnd.disabled = true;
        return;
      }

      btnSetStart.disabled = false;
      btnSetInterval.disabled = false;
      btnSetEnd.disabled = false;
      updateCurrentSong(response);

      // If song has saved trim, update button labels
      if (response.savedTrim) {
        const intervals = Array.isArray(response.savedTrim.intervals)
          ? response.savedTrim.intervals
          : [{ start: response.savedTrim.start ?? 0, end: response.savedTrim.end ?? 0 }];
        btnSetStart.textContent = `Start: ${formatTime(intervals[0].start)}`;
        btnSetEnd.textContent = `End: ${formatTime(intervals[intervals.length - 1].end)}`;
      }
    });
  });

  // ── Helper to refresh popup UI after an action ────────────────────────────
  function refreshPopupAfterAction(tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_TIME' }, (info) => {
      if (chrome.runtime.lastError || !info) return;
      updateCurrentSong(info);
      if (info.savedTrim) {
        const intervals = Array.isArray(info.savedTrim.intervals)
          ? info.savedTrim.intervals
          : [{ start: info.savedTrim.start ?? 0, end: info.savedTrim.end ?? 0 }];
        btnSetStart.textContent = `Start: ${formatTime(intervals[0].start)}`;
        btnSetEnd.textContent = `End: ${formatTime(intervals[intervals.length - 1].end)}`;
      } else {
        btnSetStart.textContent = 'Set Start';
        btnSetEnd.textContent = 'Set End';
      }
    });
    chrome.storage.sync.get(null, (items) => {
      renderSongList(items || {}, searchInput.value);
    });
  }

  // ── Set Start button ─────────────────────────────────────────────────────
  btnSetStart.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.url?.includes('music.youtube.com')) return;

      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_SET_START' }, () => {
        if (chrome.runtime.lastError) {
          showPopupToast('Wait for YTM to load, then try again');
          return;
        }
        // Short delay to let content script save before we fetch
        setTimeout(() => refreshPopupAfterAction(tab), 100);
      });
    });
  });

  // ── Set Interval button ─────────────────────────────────────────────────
  btnSetInterval.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.url?.includes('music.youtube.com')) return;

      chrome.tabs.sendMessage(tab.id, { type: 'SET_INTERVAL_BOUNDARY' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          showPopupToast('Wait for YTM to load, then try again');
          return;
        }
        showPopupToast(resp.message || 'Interval set');
        setTimeout(() => refreshPopupAfterAction(tab), 100);
      });
    });
  });

  // ── Set End button ───────────────────────────────────────────────────────
  btnSetEnd.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.url?.includes('music.youtube.com')) return;

      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_SET_END' }, () => {
        if (chrome.runtime.lastError) {
          showPopupToast('Wait for YTM to load, then try again');
          return;
        }
        setTimeout(() => refreshPopupAfterAction(tab), 100);
      });
    });
  });
});
