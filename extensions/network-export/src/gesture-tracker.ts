/**
 * Returns a JS string to be eval'd into the inspected page.
 * Sets up `window.__npp` with interaction listeners.
 */
export const INJECT_GESTURE_TRACKER = `
(function () {
  if (window.__npp) return;

  function selector(el) {
    if (!el || !el.tagName) return '';
    var tid = el.closest('[data-testid]');
    if (tid) return '[data-testid="' + tid.getAttribute('data-testid') + '"]';
    if (el.id) return '#' + el.id;
    var named = el.closest('[id]');
    if (named) return named.tagName.toLowerCase() + '#' + named.id + ' ' + el.tagName.toLowerCase();
    var role = el.closest('button, a, [role="button"], [role="link"]');
    if (role) return role.tagName.toLowerCase() + (role.className ? '.' + role.className.split(/\\s+/).slice(0, 2).join('.') : '');
    return el.tagName.toLowerCase();
  }

  function elInfo(el) {
    if (!el || !el.tagName) return null;
    var text = (el.innerText || el.textContent || '').trim().substring(0, 60);
    return {
      tag: el.tagName.toLowerCase(),
      text: text,
      id: el.id || undefined,
      className: el.className && typeof el.className === 'string' ? el.className.substring(0, 120) : undefined,
      selector: selector(el)
    };
  }

  var npp = { interactions: [], startUrl: location.href };
  window.__npp = npp;

  document.addEventListener('click', function (e) {
    npp.interactions.push({
      type: 'click',
      timestamp: Date.now(),
      element: elInfo(e.target),
      toUrl: location.href
    });
  }, true);

  document.addEventListener('submit', function (e) {
    npp.interactions.push({
      type: 'submit',
      timestamp: Date.now(),
      element: elInfo(e.target),
      toUrl: location.href
    });
  }, true);

  var origPush = history.pushState;
  var origReplace = history.replaceState;

  function onNav(from, to) {
    if (from === to) return;
    npp.interactions.push({ type: 'navigate', timestamp: Date.now(), fromUrl: from, toUrl: to });
  }

  history.pushState = function () {
    var from = location.href;
    var r = origPush.apply(this, arguments);
    onNav(from, location.href);
    return r;
  };

  history.replaceState = function () {
    var from = location.href;
    var r = origReplace.apply(this, arguments);
    onNav(from, location.href);
    return r;
  };

  window.addEventListener('popstate', function () {
    onNav(npp.interactions.length > 0
      ? npp.interactions[npp.interactions.length - 1].toUrl || location.href
      : npp.startUrl, location.href);
  });
})();
`;

export const READ_GESTURE_DATA = `JSON.stringify(window.__npp || null)`;

export const CLEANUP_GESTURE_TRACKER = `
(function () {
  delete window.__npp;
})();
`;
