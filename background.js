// YTM Trimmer — background service worker (MV3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[YTM Trimmer] Extension installed');
});

// ── Extension command handlers ────────────────────────────────────────────────
// chrome.commands.onCommand fires in the SERVICE WORKER, not content scripts.
// Forward commands to the active YTM tab.
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ url: '*://music.youtube.com/*' }, (tabs) => {
    let tab = tabs.find(t => t.active && t.windowId === chrome.windows.WINDOW_ID_CURRENT) 
           || tabs.find(t => t.audible) 
           || tabs[0];
    if (!tab) return;

    if (command === 'set-start') {
      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_SET_START' }).catch(() => {});
    } else if (command === 'set-end') {
      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_SET_END' }).catch(() => {});
    } else if (command === 'set-interval') {
      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_SET_INTERVAL' }).catch(() => {});
    } else if (command === 'toggle-panel') {
      chrome.tabs.sendMessage(tab.id, { type: 'COMMAND_TOGGLE_PANEL' }).catch(() => {});
    }
  });
});
