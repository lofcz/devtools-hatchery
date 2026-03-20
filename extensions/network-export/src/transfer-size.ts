/**
 * Extract the transfer size from a HAR entry returned by onRequestFinished.
 *
 * Chrome's DevTools API doesn't directly expose the "Size" column value,
 * so we try several HAR / Chrome-specific properties in priority order:
 *
 * 1. Chrome's non-standard `_transferSize` (entry or response level)
 * 2. HAR `response.bodySize + response.headersSize` (compressed body)
 * 3. HAR `response.content.size` minus compression savings
 * 4. HAR `response.content.size` alone (uncompressed, last resort)
 */
export function getTransferSize(
  request: chrome.devtools.network.Request,
): number {
  const entry = request as Record<string, unknown>;
  const res = request.response;

  // Chrome-specific: most accurate transfer size (headers + compressed body)
  const entryTransfer = entry._transferSize;
  if (typeof entryTransfer === "number" && entryTransfer > 0)
    return entryTransfer;

  const resAny = res as Record<string, unknown> | undefined;
  const resTransfer = resAny?._transferSize;
  if (typeof resTransfer === "number" && resTransfer > 0) return resTransfer;

  // Standard HAR: bodySize is the *encoded* (compressed) body length
  const bodySize = res?.bodySize ?? -1;
  const headersSize = res?.headersSize ?? -1;
  if (bodySize >= 0 && headersSize >= 0) return bodySize + headersSize;
  if (bodySize >= 0) return bodySize;

  // Fallback: content.size adjusted for compression
  const contentSize = res?.content?.size ?? 0;
  const compression = (res?.content as Record<string, unknown>)
    ?.compression as number | undefined;
  if (contentSize > 0 && typeof compression === "number" && compression > 0) {
    return contentSize - compression;
  }

  if (contentSize > 0) return contentSize;

  return 0;
}
