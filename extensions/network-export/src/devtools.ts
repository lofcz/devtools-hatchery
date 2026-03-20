import type { AddEntryMessage, NetworkEntry } from "./entry";
import { getTransferSize } from "./transfer-size";

chrome.devtools.panels.create("Network++", "", "panel.html", () => {});

function parseUrl(raw: string): { name: string; domain: string } {
  try {
    const u = new URL(raw);
    const segments = u.pathname.split("/").filter(Boolean);
    let name =
      segments.length > 0 ? segments[segments.length - 1] : u.pathname;
    if (u.search) name += u.search;
    return { name, domain: u.hostname };
  } catch {
    return { name: raw, domain: "" };
  }
}

chrome.devtools.network.onRequestFinished.addListener((request) => {
  try {
    const status = request.response?.status;
    if (status === undefined || status === 404) return;

    const tabId = chrome.devtools.inspectedWindow.tabId;
    const url = request.request.url;
    const transferSize = getTransferSize(request);
    const { name, domain } = parseUrl(url);

    const contentType =
      request.response?.content?.mimeType?.split(";")[0]?.trim() ?? "";

    const duration = request.time ?? 0;

    let timestamp = Date.now();
    if (request.startedDateTime) {
      const parsed = new Date(request.startedDateTime).getTime();
      if (!Number.isNaN(parsed)) timestamp = parsed;
    }

    const entry: NetworkEntry = {
      url,
      name,
      domain,
      transferSize,
      statusCode: status,
      timestamp,
      contentType,
      duration,
    };

    chrome.runtime.sendMessage({
      type: "addEntry",
      payload: { tabId, entry },
    } satisfies AddEntryMessage);
  } catch {
    // Extension context invalidated after reload
  }
});
