/**
 * StratOptimizer - Background Service Worker
 *
 * Responsibilities:
 *   1. Re-inject content script into already-open TradingView tabs on install/update
 *   2. Relay notifications
 *   3. Tab lifecycle management
 */

// On install/update, inject content script into any existing TradingView tabs
// (content_scripts in manifest only apply to *new* navigations)
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    const tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content.js'],
        });
      } catch (e) {
        console.warn('Could not inject into tab', tab.id, e.message);
      }
    }
    console.log(`StratOptimizer ${details.reason}d — injected into ${tabs.length} tab(s)`);
  }
});

// Message relay from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OPTIMIZATION_COMPLETE':
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'StratOptimizer',
        message: message.data?.message || 'Optimization complete!',
      });
      sendResponse({ success: true });
      break;

    case 'OPTIMIZATION_ERROR':
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'StratOptimizer - Error',
        message: message.data?.message || 'An error occurred.',
      });
      sendResponse({ success: true });
      break;

    case 'ENSURE_CONTENT_SCRIPT': {
      // Popup asks us to make sure the content script is loaded in a tab
      const tabId = message.tabId;
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          // Not loaded — inject it
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['src/content.js'],
          }).then(() => sendResponse({ injected: true }))
            .catch(e => sendResponse({ error: e.message }));
        } else {
          sendResponse({ injected: false, alreadyLoaded: true });
        }
      });
      return true; // async
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});
