// Classic (non-module) content script. Chrome cannot load ES modules directly
// from manifest "content_scripts", so this tiny shim dynamically imports the
// real entry point. All files under src/ are listed in web_accessible_resources.
(async () => {
  try {
    const url = chrome.runtime.getURL('src/frameworks/content/ContentScriptController.js');
    const { bootstrap } = await import(url);
    bootstrap();
  } catch (error) {
    console.error('[Recent Google Reviews] failed to start', error);
  }
})();
