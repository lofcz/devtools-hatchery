import type {
  AddEntryMessage,
  GetEntriesResponse,
  GetPausedResponse,
  GetPendingResponse,
  IsRecordingResponse,
  NetworkEntry,
  PanelMessage,
} from "./entry";
import { pendingTrackUrlFilter } from "./pending-web-request";

// ---------------------------------------------------------------------------
// Completed entries (persisted in session storage)
// ---------------------------------------------------------------------------

function storageKey(tabId: number): string {
  return `networkExport:${tabId}`;
}

function pauseKey(tabId: number): string {
  return `networkExportPaused:${tabId}`;
}

async function readBuffer(tabId: number): Promise<NetworkEntry[]> {
  const key = storageKey(tabId);
  const data = await chrome.storage.session.get(key);
  const raw = data[key];
  return Array.isArray(raw) ? (raw as NetworkEntry[]) : [];
}

async function writeBuffer(
  tabId: number,
  entries: NetworkEntry[],
): Promise<void> {
  await chrome.storage.session.set({ [storageKey(tabId)]: entries });
}

async function isPaused(tabId: number): Promise<boolean> {
  const key = pauseKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] === true;
}

// ---------------------------------------------------------------------------
// Pending requests (in-memory, transient)
// ---------------------------------------------------------------------------

const MAX_PENDING_PER_TAB = 500;
const pendingByTab = new Map<number, Map<string, NetworkEntry>>();

function parseUrl(raw: string): { name: string; domain: string } {
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    let name = segs.length > 0 ? segs[segs.length - 1] : u.pathname;
    if (u.search) name += u.search;
    return { name, domain: u.hostname };
  } catch {
    return { name: raw, domain: "" };
  }
}

function removePending(tabId: number, requestId: string) {
  const tab = pendingByTab.get(tabId);
  if (tab) tab.delete(requestId);
}

const pendingUrlFilter = pendingTrackUrlFilter();

function onBeforeRequest(details: {
  tabId: number;
  timeStamp: number;
  url: string;
  requestId: string;
}) {
  if (details.tabId < 0) return;

  let tab = pendingByTab.get(details.tabId);
  if (!tab) {
    tab = new Map();
    pendingByTab.set(details.tabId, tab);
  }

  if (tab.size >= MAX_PENDING_PER_TAB) return;

  const { name, domain } = parseUrl(details.url);
  tab.set(details.requestId, {
    url: details.url,
    name,
    domain,
    transferSize: 0,
    statusCode: 0,
    timestamp: details.timeStamp,
    contentType: "",
    duration: 0,
    pending: true,
  });
}

function onCompleted(d: { tabId: number; requestId: string }) {
  removePending(d.tabId, d.requestId);
}

function onErrorOccurred(d: { tabId: number; requestId: string }) {
  removePending(d.tabId, d.requestId);
}

let webRequestListenersAttached = false;

function attachWebRequestListeners() {
  if (webRequestListenersAttached) return;
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    pendingUrlFilter,
  );
  chrome.webRequest.onCompleted.addListener(onCompleted, pendingUrlFilter);
  chrome.webRequest.onErrorOccurred.addListener(
    onErrorOccurred,
    pendingUrlFilter,
  );
  webRequestListenersAttached = true;
}

function detachWebRequestListeners() {
  if (!webRequestListenersAttached) return;
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  chrome.webRequest.onCompleted.removeListener(onCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
  webRequestListenersAttached = false;
}

async function syncWebRequestListenersFromPermissions(): Promise<void> {
  const filter = pendingTrackUrlFilter();
  const ok = await chrome.permissions.contains({
    origins: filter.urls as string[],
  });
  if (ok) attachWebRequestListeners();
  else detachWebRequestListeners();
}

chrome.permissions.onAdded.addListener(() => {
  void syncWebRequestListenersFromPermissions();
});
chrome.permissions.onRemoved.addListener(() => {
  void syncWebRequestListenersFromPermissions();
});

void syncWebRequestListenersFromPermissions();

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingByTab.delete(tabId);
  recordingByTab.delete(tabId);
});

// ---------------------------------------------------------------------------
// Recording state (in-memory per tab)
// ---------------------------------------------------------------------------

const recordingByTab = new Map<number, { startTime: number }>();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: AddEntryMessage | PanelMessage, _sender, sendResponse) => {
    if (message?.type === "addEntry") {
      void (async () => {
        const { tabId, entry } = message.payload;
        if (await isPaused(tabId)) return;
        const buf = await readBuffer(tabId);
        buf.push(entry);
        await writeBuffer(tabId, buf);
      })();
      return;
    }

    if (message?.type === "clear") {
      void (async () => {
        await writeBuffer(message.payload.tabId, []);
        pendingByTab.delete(message.payload.tabId);
        sendResponse({});
      })();
      return true;
    }

    if (message?.type === "getEntries") {
      void (async () => {
        const entries = await readBuffer(message.payload.tabId);
        sendResponse({ entries } satisfies GetEntriesResponse);
      })();
      return true;
    }

    if (message?.type === "getPending") {
      const tab = pendingByTab.get(message.payload.tabId);
      const entries = tab ? [...tab.values()] : [];
      sendResponse({ entries } satisfies GetPendingResponse);
      return true;
    }

    if (message?.type === "setPaused") {
      void (async () => {
        const key = pauseKey(message.payload.tabId);
        await chrome.storage.session.set({ [key]: message.payload.paused });
        sendResponse({});
      })();
      return true;
    }

    if (message?.type === "getPaused") {
      void (async () => {
        const paused = await isPaused(message.payload.tabId);
        sendResponse({ paused } satisfies GetPausedResponse);
      })();
      return true;
    }

    if (message?.type === "startRecording") {
      void (async () => {
        const { tabId } = message.payload;
        await writeBuffer(tabId, []);
        pendingByTab.delete(tabId);
        recordingByTab.set(tabId, { startTime: Date.now() });
        sendResponse({});
      })();
      return true;
    }

    if (message?.type === "stopRecording") {
      recordingByTab.delete(message.payload.tabId);
      sendResponse({});
      return true;
    }

    if (message?.type === "isRecording") {
      const rec = recordingByTab.get(message.payload.tabId);
      sendResponse({
        recording: !!rec,
        startTime: rec?.startTime,
      } satisfies IsRecordingResponse);
      return true;
    }

    return;
  },
);
