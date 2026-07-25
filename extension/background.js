/*
 * background.js — MV3 service worker.
 *
 * Content scripts cannot call chrome.downloads, so the content script sends us the
 * formatted Markdown and we save it. Files land in the browser's Downloads folder
 * under jobs-md/ (an extension can only write there — it has no access to arbitrary
 * paths like the repo). conflictAction:'overwrite' + a {slug}-{jobId} filename make
 * re-copying the same job idempotent instead of spawning "job (1).md", "job (2).md".
 *
 * URL.createObjectURL is unavailable in an MV3 service worker, so we hand
 * chrome.downloads a data: URL instead.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'li-cn-save-job') return; // not ours
  try {
    const dataUrl =
      'data:text/markdown;charset=utf-8,' + encodeURIComponent(msg.markdown || '');
    // Keep the path relative + sanitized; the browser roots it at the Downloads dir.
    const safe = String(msg.filename || 'job.md').replace(/[\\/]+/g, '-').replace(/^\.+/, '');
    chrome.downloads.download(
      { url: dataUrl, filename: 'jobs-md/' + safe, saveAs: false, conflictAction: 'overwrite' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId, path: 'jobs-md/' + safe });
        }
      }
    );
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true; // keep the message channel open for the async sendResponse
});
