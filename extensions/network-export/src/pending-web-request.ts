/**
 * Optional host access for in-flight (pending) rows via chrome.webRequest.
 * Completed requests use chrome.devtools.network only and need no host permission.
 * Excludes file:// — use DevTools as usual on local files without pending indicators.
 */
export const PENDING_TRACK_ORIGINS = ["http://*/*", "https://*/*"] as const;

export function pendingTrackUrlFilter(): chrome.webRequest.RequestFilter {
  return { urls: [...PENDING_TRACK_ORIGINS] };
}
