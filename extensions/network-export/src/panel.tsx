import type React from "react";
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type {
  FilterRule,
  GetEntriesResponse,
  GetPausedResponse,
  GetPendingResponse,
  Interaction,
  IsRecordingResponse,
  NetworkEntry,
  PanelMessage,
  Recording,
} from "./entry";
import {
  INJECT_GESTURE_TRACKER,
  READ_GESTURE_DATA,
  CLEANUP_GESTURE_TRACKER,
} from "./gesture-tracker";
import {
  type Lens,
  pickDefaultLens,
  generatePrompt,
} from "./prompt-gen";
import { PENDING_TRACK_ORIGINS } from "./pending-web-request";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme() {
  const dark =
    typeof chrome !== "undefined" &&
    chrome.devtools?.panels?.themeName === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

// ---------------------------------------------------------------------------
// Chrome messaging
// ---------------------------------------------------------------------------

function getTabId(): number {
  return chrome.devtools.inspectedWindow.tabId;
}

function sendMessage<T>(msg: PanelMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response: T) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(response);
      });
    } catch {
      reject(new Error("Extension context invalidated"));
    }
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

function niceBytes(x: number): string {
  let level = 0;
  let n = Math.max(0, Math.floor(x)) || 0;
  while (n >= 1024 && level < UNITS.length - 1) {
    n /= 1024;
    level++;
  }
  const decimals = n < 10 && level > 0 ? 1 : 0;
  return `${n.toFixed(decimals)} ${UNITS[level]}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function totalBytes(entries: NetworkEntry[]): number {
  return entries.reduce((sum, e) => sum + e.transferSize, 0);
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

function patternToRegex(pattern: string): RegExp | null {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(escaped, "i");
  } catch {
    return null;
  }
}

function matchesAnyFilter(url: string, filters: FilterRule[]): boolean {
  for (const f of filters) {
    if (!f.enabled) continue;
    const re = patternToRegex(f.pattern);
    if (re?.test(url)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useEntries(paused: boolean) {
  const [entries, setEntries] = useState<NetworkEntry[]>([]);
  const lastRef = useRef<NetworkEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const tabId = getTabId();
      const [completedRes, pendingRes] = await Promise.all([
        sendMessage<GetEntriesResponse>({
          type: "getEntries",
          payload: { tabId },
        }),
        sendMessage<GetPendingResponse>({
          type: "getPending",
          payload: { tabId },
        }),
      ]);
      const all = [...completedRes.entries, ...pendingRes.entries];
      lastRef.current = all;
      if (!paused) setEntries(all);
    } catch {
      /* background unavailable */
    }
  }, [paused]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 1200);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!paused) setEntries(lastRef.current);
  }, [paused]);

  const clear = useCallback(async () => {
    await sendMessage<void>({
      type: "clear",
      payload: { tabId: getTabId() },
    });
    setEntries([]);
    lastRef.current = [];
  }, []);

  return { entries, clear };
}

function useInFlightHostPermission() {
  const [granted, setGranted] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    chrome.permissions.contains(
      { origins: [...PENDING_TRACK_ORIGINS] },
      (ok) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn("[Network++] permissions.contains:", err.message);
          setGranted(false);
          return;
        }
        setGranted(!!ok);
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    const onAdded = chrome.permissions
      .onAdded as chrome.events.Event<(p: chrome.permissions.Permissions) => void>;
    const onRemoved = chrome.permissions
      .onRemoved as chrome.events.Event<(p: chrome.permissions.Permissions) => void>;
    onAdded.addListener(onChange);
    onRemoved.addListener(onChange);
    return () => {
      onAdded.removeListener(onChange);
      onRemoved.removeListener(onChange);
    };
  }, [refresh]);

  const request = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        chrome.permissions.request(
          { origins: [...PENDING_TRACK_ORIGINS] },
          (ok) => {
            if (chrome.runtime.lastError) {
              console.warn(
                "[Network++] permissions.request:",
                chrome.runtime.lastError.message,
              );
            }
            resolve(!!ok);
          },
        );
      }),
    [],
  );

  return { granted, request, refresh };
}

function PendingInFlightBanner({
  granted,
  onEnable,
}: {
  granted: boolean | null;
  onEnable: () => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(false);
  // Show until we know permission is granted (not: `granted !== false` — null !== false is true in JS and hid the banner on first paint).
  if (dismissed || granted === true) return null;

  const checking = granted === null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 border-b border-amber-500/40 bg-amber-500/10 text-[11px] text-[var(--color-text)] shrink-0">
      <span className="text-amber-700 dark:text-amber-300 font-medium">
        In-flight rows
      </span>
      <span className="text-[var(--color-text-dim)] max-w-[min(100%,42rem)]">
        {checking ? (
          <>Checking optional permission…</>
        ) : (
          <>
            Click <strong className="text-[var(--color-text)]">Allow</strong>{" "}
            here (then Chrome&apos;s prompt) to enable{" "}
            <code className="text-[var(--color-text)]">http(s)://*/*</code> for
            pending rows. Finished requests work without this.{" "}
            <code className="text-[var(--color-text)]">file://</code> is
            unchanged.
          </>
        )}
      </span>
      <div className="flex items-center gap-1.5 ml-auto">
        <button
          type="button"
          disabled={checking}
          title={
            checking
              ? "Checking permission status…"
              : "Opens Chrome’s permission prompt for http(s) on any site"
          }
          onClick={() => void onEnable()}
          className="h-6 px-2.5 rounded bg-[var(--color-accent)] text-white font-medium hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="h-6 px-2 rounded border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function usePaused() {
  const [paused, setPausedState] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { paused: p } = await sendMessage<GetPausedResponse>({
          type: "getPaused",
          payload: { tabId: getTabId() },
        });
        setPausedState(p);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const toggle = useCallback(async () => {
    const next = !paused;
    setPausedState(next);
    await sendMessage<void>({
      type: "setPaused",
      payload: { tabId: getTabId(), paused: next },
    });
  }, [paused]);

  return { paused, toggle };
}

const FILTERS_KEY = "networkExportFilters";

function useFilters() {
  const [filters, setFilters] = useState<FilterRule[]>([]);

  useEffect(() => {
    chrome.storage.local.get(FILTERS_KEY, (data) => {
      const raw = data[FILTERS_KEY];
      if (!Array.isArray(raw) || raw.length === 0) return;

      const normalized: FilterRule[] = raw.map((item: unknown) => {
        const x = item as Partial<FilterRule>;
        return {
          id: typeof x.id === "string" && x.id.length > 0 ? x.id : crypto.randomUUID(),
          pattern: typeof x.pattern === "string" ? x.pattern : "",
          enabled: x.enabled !== false,
        };
      });

      setFilters(normalized);

      const changed = raw.some((item: unknown, i: number) => {
        const x = item as Partial<FilterRule>;
        return x.id !== normalized[i]?.id;
      });
      if (changed) {
        chrome.storage.local.set({ [FILTERS_KEY]: normalized });
      }
    });
  }, []);

  const persist = useCallback((next: FilterRule[]) => {
    setFilters(next);
    chrome.storage.local.set({ [FILTERS_KEY]: next });
  }, []);

  const add = useCallback(
    (pattern: string) => {
      const trimmed = pattern.trim();
      if (!trimmed) return;
      persist([
        ...filters,
        { id: crypto.randomUUID(), pattern: trimmed, enabled: true },
      ]);
    },
    [filters, persist],
  );

  const remove = useCallback(
    (id: string) => persist(filters.filter((f) => f.id !== id)),
    [filters, persist],
  );

  const toggle = useCallback(
    (id: string) =>
      persist(
        filters.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f)),
      ),
    [filters, persist],
  );

  return { filters, add, remove, toggle };
}

// ---------------------------------------------------------------------------
// Recording hook
// ---------------------------------------------------------------------------

function useRecording(clearBuffer: () => Promise<void>) {
  const [recording, setRecording] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastRecording, setLastRecording] = useState<Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await sendMessage<IsRecordingResponse>({
          type: "isRecording",
          payload: { tabId: getTabId() },
        });
        if (res.recording && res.startTime) {
          setRecording(true);
          setStartTime(res.startTime);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    if (recording && startTime != null) {
      const tick = () => setElapsed(Date.now() - startTime);
      tick();
      timerRef.current = setInterval(tick, 100);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
    setElapsed(0);
  }, [recording, startTime]);

  const evalInPage = useCallback(
    (expr: string): Promise<unknown> =>
      new Promise((resolve) => {
        try {
          chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
            if (err) resolve(null);
            else resolve(result);
          });
        } catch {
          resolve(null);
        }
      }),
    [],
  );

  const start = useCallback(async () => {
    await clearBuffer();
    const now = Date.now();
    setStartTime(now);
    setRecording(true);
    setLastRecording(null);
    await sendMessage<void>({
      type: "startRecording",
      payload: { tabId: getTabId() },
    });
    await evalInPage(INJECT_GESTURE_TRACKER);
  }, [clearBuffer, evalInPage]);

  const stop = useCallback(async (): Promise<Recording | null> => {
    setRecording(false);
    const endTime = Date.now();

    await sendMessage<void>({
      type: "stopRecording",
      payload: { tabId: getTabId() },
    });

    const raw = (await evalInPage(READ_GESTURE_DATA)) as string | null;
    await evalInPage(CLEANUP_GESTURE_TRACKER);

    let interactions: Interaction[] = [];
    let startUrl = "";
    let endUrl = "";

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          interactions?: Interaction[];
          startUrl?: string;
        };
        interactions = parsed.interactions ?? [];
        startUrl = parsed.startUrl ?? "";
        endUrl =
          interactions.length > 0
            ? (interactions[interactions.length - 1].toUrl ?? startUrl)
            : startUrl;
      } catch {
        /* malformed json */
      }
    }

    const rec: Recording = {
      startTime: startTime ?? endTime,
      endTime,
      startUrl,
      endUrl,
      interactions,
    };

    setLastRecording(rec);
    return rec;
  }, [evalInPage, startTime]);

  const toggle = useCallback(async () => {
    if (recording) return stop();
    await start();
    return null;
  }, [recording, start, stop]);

  return { recording, elapsed, lastRecording, toggle };
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

type SortKey = "timestamp" | "name" | "domain" | "transferSize";
type SortDir = "asc" | "desc";

type DisplayEntry = NetworkEntry & { filtered: boolean };

function sortEntries(
  entries: DisplayEntry[],
  key: SortKey,
  dir: SortDir,
): DisplayEntry[] {
  const sorted = [...entries];
  const mul = dir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    // Pending always at bottom
    if (a.pending && !b.pending) return 1;
    if (!a.pending && b.pending) return -1;
    const av = a[key];
    const bv = b[key];
    if (typeof av === "string" && typeof bv === "string")
      return mul * av.localeCompare(bv);
    return mul * ((av as number) - (bv as number));
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

function ToolbarButton({
  children,
  onClick,
  title,
  active,
  badge,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`
        relative flex items-center justify-center w-7 h-7 rounded
        transition-colors cursor-pointer
        ${active ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"}
      `}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-[var(--color-accent)] text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
          {badge}
        </span>
      )}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`
        relative inline-flex h-[14px] w-[26px] items-center rounded-full transition-colors shrink-0 cursor-pointer
        ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}
      `}
    >
      <span
        className={`
          inline-block h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-transform
          ${checked ? "translate-x-[14px]" : "translate-x-[2px]"}
        `}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------

const IconClear = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
  </svg>
);

const IconCopy = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const IconPause = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="3" width="4" height="18" rx="1" />
    <rect x="15" y="3" width="4" height="18" rx="1" />
  </svg>
);

const IconPlay = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,3 19,12 5,21" />
  </svg>
);

const IconFilter = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46" />
  </svg>
);

const IconRecord = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="12" r="8" />
  </svg>
);

const IconStop = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

const IconSparkle = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5Z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function Toolbar({
  count,
  total,
  paused,
  filterCount,
  filtersOpen,
  isRecording,
  recordElapsed,
  onClear,
  onCopy,
  onTogglePause,
  onToggleFilters,
  onToggleRecord,
  onGeneratePrompt,
}: {
  count: number;
  total: number;
  paused: boolean;
  filterCount: number;
  filtersOpen: boolean;
  isRecording: boolean;
  recordElapsed: number;
  onClear: () => void;
  onCopy: () => void;
  onTogglePause: () => void;
  onToggleFilters: () => void;
  onToggleRecord: () => void;
  onGeneratePrompt: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
      <ToolbarButton onClick={onClear} title="Clear buffer">
        <IconClear />
      </ToolbarButton>

      <ToolbarButton onClick={onCopy} title="Copy to clipboard">
        <IconCopy />
      </ToolbarButton>

      <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

      <ToolbarButton
        onClick={onTogglePause}
        active={paused}
        title={paused ? "Resume capture" : "Pause capture"}
      >
        {paused ? <IconPlay /> : <IconPause />}
      </ToolbarButton>

      <ToolbarButton
        onClick={onToggleFilters}
        active={filtersOpen}
        title="Toggle filters"
        badge={filterCount}
      >
        <IconFilter />
      </ToolbarButton>

      <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

      <ToolbarButton
        onClick={onToggleRecord}
        active={isRecording}
        title={isRecording ? "Stop recording" : "Start recording"}
      >
        {isRecording ? (
          <span className="text-[var(--color-record)]">
            <IconStop />
          </span>
        ) : (
          <span className="text-[var(--color-record)]">
            <IconRecord />
          </span>
        )}
      </ToolbarButton>

      <ToolbarButton
        onClick={onGeneratePrompt}
        title="Generate AI prompt"
      >
        <IconSparkle />
      </ToolbarButton>

      <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--color-text-dim)]">
        {isRecording && (
          <span className="flex items-center gap-1.5 text-[var(--color-record)] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-current rec-dot" />
            Recording {fmtElapsed(recordElapsed)}
          </span>
        )}
        {paused && !isRecording && (
          <span className="flex items-center gap-1 text-amber-500 dark:text-amber-400 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            Paused
          </span>
        )}
        <span>
          {count} request{count !== 1 ? "s" : ""}
        </span>
        <span className="font-medium text-[var(--color-text)]">
          {niceBytes(total)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter Bar
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  onAdd,
  onRemove,
  onToggle,
}: {
  filters: FilterRule[];
  onAdd: (pattern: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const val = inputRef.current?.value;
    if (val?.trim()) {
      onAdd(val.trim());
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] px-2.5 py-2 shrink-0">
      <div className="flex gap-1.5 mb-1.5">
        <input
          ref={inputRef}
          type="text"
          placeholder="Filter pattern  (e.g. https://eu.i.posthog.com/*)"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="flex-1 h-6 px-2 text-[11px] rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent)] transition-colors"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="h-6 px-2.5 text-[11px] rounded bg-[var(--color-accent)] text-white font-medium hover:opacity-90 transition-opacity cursor-pointer"
        >
          Add
        </button>
      </div>

      {filters.length === 0 && (
        <p className="text-[10px] text-[var(--color-text-dim)] m-0">
          No filters yet. Use <code className="text-[10px]">*</code> as
          wildcard.
        </p>
      )}

      {filters.length > 0 && (
        <div className="flex flex-col gap-1 max-h-28 overflow-auto">
          {filters.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-2 group text-[11px] ${!f.enabled ? "opacity-50" : ""}`}
            >
              <Toggle checked={f.enabled} onChange={() => onToggle(f.id)} />
              <span
                className={`flex-1 truncate font-mono text-[10px] ${f.enabled ? "text-[var(--color-text)]" : "text-[var(--color-text-dim)] line-through"}`}
                title={f.pattern}
              >
                {f.pattern}
              </span>
              <button
                type="button"
                onClick={() => onRemove(f.id)}
                className="opacity-0 group-hover:opacity-100 text-[var(--color-danger)] hover:text-[var(--color-danger)] transition-opacity cursor-pointer text-sm leading-none"
                title="Remove filter"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request Table — column resize
// ---------------------------------------------------------------------------

type ColKey = "timestamp" | "name" | "domain" | "transferSize";

const COL_MIN = 40;

function useColumnWidths(initial: Record<ColKey, number | null>) {
  const [widths, setWidths] = useState(initial);
  const dragRef = useRef<{
    col: ColKey;
    startX: number;
    startW: number;
  } | null>(null);

  const startResize = useCallback(
    (col: ColKey) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const th = (e.target as HTMLElement).closest("th");
      const startW = widths[col] ?? th?.offsetWidth ?? 120;
      dragRef.current = { col, startX: e.clientX, startW };

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientX - dragRef.current.startX;
        const next = Math.max(COL_MIN, dragRef.current.startW + delta);
        setWidths((prev) => ({ ...prev, [dragRef.current!.col]: next }));
      };

      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [widths],
  );

  return { widths, startResize };
}

// ---------------------------------------------------------------------------
// Request Table — components
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  sortKey: key,
  currentSort,
  currentDir,
  onSort,
  onResizeStart,
  width,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  width: number | null;
}) {
  const active = currentSort === key;
  return (
    <th
      onClick={() => onSort(key)}
      style={width != null ? { width } : undefined}
      className="px-2 py-1 text-left text-[10px] uppercase tracking-wider font-semibold cursor-pointer select-none
        text-[var(--color-text-dim)] hover:text-[var(--color-text)] transition-colors
        border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] relative"
    >
      <span className="flex items-center gap-1">
        {label}
        {active && (
          <span className="text-[var(--color-accent)] text-[9px]">
            {currentDir === "asc" ? "▲" : "▼"}
          </span>
        )}
      </span>
      <div
        onMouseDown={onResizeStart}
        className="absolute top-0 -right-px bottom-0 w-[5px] cursor-col-resize z-20
          before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-[var(--color-border)]
          hover:before:w-[3px] hover:before:-translate-x-1/2 hover:before:bg-[var(--color-accent)]
          before:transition-all"
      />
    </th>
  );
}

function PendingDot() {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0"
      title="In-flight"
    />
  );
}

/** Stable unique key per row (URL + timing can repeat across requests). */
function requestRowKey(entry: NetworkEntry, sortIndex: number): string {
  const phase = entry.pending ? "P" : "C";
  return `${phase}|${sortIndex}|${entry.timestamp}|${entry.transferSize}|${entry.statusCode}|${entry.duration}|${entry.url}`;
}

function RequestTable({
  entries,
  sortKey,
  sortDir,
  onSort,
}: {
  entries: DisplayEntry[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const { widths, startResize } = useColumnWidths({
    timestamp: 72,
    name: null,
    domain: 140,
    transferSize: 100,
  });

  const maxSize = useMemo(
    () => Math.max(1, ...entries.map((e) => e.transferSize)),
    [entries],
  );

  const sorted = useMemo(
    () => sortEntries(entries, sortKey, sortDir),
    [entries, sortKey, sortDir],
  );

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-dim)] text-[11px]">
        No requests captured yet
      </div>
    );
  }

  const hp = { currentSort: sortKey, currentDir: sortDir, onSort };

  return (
    <div className="h-full overflow-auto">
      <table
        className="w-full border-collapse text-[11px]"
        style={{ tableLayout: "fixed" }}
      >
        <thead className="sticky top-0 z-10">
          <tr>
            <SortHeader label="Time" sortKey="timestamp" {...hp} width={widths.timestamp} onResizeStart={startResize("timestamp")} />
            <SortHeader label="Name" sortKey="name" {...hp} width={widths.name} onResizeStart={startResize("name")} />
            <SortHeader label="Source" sortKey="domain" {...hp} width={widths.domain} onResizeStart={startResize("domain")} />
            <SortHeader label="Size" sortKey="transferSize" {...hp} width={widths.transferSize} onResizeStart={startResize("transferSize")} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry, i) => {
            const pct = entry.pending
              ? 0
              : (entry.transferSize / maxSize) * 100;
            const dimmed = entry.filtered || entry.pending;

            return (
              <tr
                key={requestRowKey(entry, i)}
                className={`
                  border-b border-[var(--color-border)]/50 transition-colors group
                  ${entry.filtered ? "opacity-35" : entry.pending ? "opacity-60" : "hover:bg-[var(--color-surface-hover)]"}
                `}
                title={entry.url}
              >
                <td className="px-2 py-[3px] text-[var(--color-text-dim)] tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">
                  {formatTime(entry.timestamp)}
                </td>
                <td className="px-2 py-[3px] overflow-hidden text-ellipsis whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    {entry.pending && <PendingDot />}
                    <span
                      className={`truncate ${dimmed ? "text-[var(--color-text-dim)]" : "text-[var(--color-text)]"}`}
                    >
                      {entry.name}
                    </span>
                    {entry.filtered && (
                      <span className="text-[9px] text-[var(--color-text-dim)] shrink-0">
                        filtered
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-[3px] text-[var(--color-text-dim)] overflow-hidden text-ellipsis whitespace-nowrap">
                  {entry.domain}
                </td>
                <td className="px-2 py-[3px] whitespace-nowrap relative overflow-hidden">
                  {!entry.pending && pct > 0 && (
                    <div
                      className="absolute inset-y-0 left-0 bg-[var(--color-bar)] transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                  <span className="relative tabular-nums font-medium">
                    {entry.pending ? (
                      <span className="text-[var(--color-text-dim)] italic">
                        pending
                      </span>
                    ) : (
                      niceBytes(entry.transferSize)
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart palette + SVG helpers
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  "oklch(0.65 0.2 250)",
  "oklch(0.7 0.2 150)",
  "oklch(0.7 0.2 30)",
  "oklch(0.65 0.2 330)",
  "oklch(0.6 0.2 280)",
  "oklch(0.75 0.15 80)",
  "oklch(0.65 0.15 200)",
  "oklch(0.65 0.2 0)",
  "oklch(0.55 0.12 230)",
  "oklch(0.7 0.15 110)",
];

function describeArc(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  if (endAngle - startAngle >= Math.PI * 2 - 0.001)
    endAngle = startAngle + Math.PI * 2 - 0.001;

  const osx = cx + outerR * Math.cos(startAngle);
  const osy = cy + outerR * Math.sin(startAngle);
  const oex = cx + outerR * Math.cos(endAngle);
  const oey = cy + outerR * Math.sin(endAngle);
  const isx = cx + innerR * Math.cos(endAngle);
  const isy = cy + innerR * Math.sin(endAngle);
  const iex = cx + innerR * Math.cos(startAngle);
  const iey = cy + innerR * Math.sin(startAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;

  return `M${osx} ${osy}A${outerR} ${outerR} 0 ${large} 1 ${oex} ${oey}L${isx} ${isy}A${innerR} ${innerR} 0 ${large} 0 ${iex} ${iey}Z`;
}

// ---------------------------------------------------------------------------
// Animated chart values
// ---------------------------------------------------------------------------

type ChartSlice = { id: string; label: string; value: number; count: number };

function useAnimatedSlices(target: ChartSlice[], ms = 350): ChartSlice[] {
  const currentRef = useRef(new Map<string, number>());
  const targetRef = useRef(target);
  targetRef.current = target;

  const [animated, setAnimated] = useState(target);
  const rafRef = useRef(0);

  const key = useMemo(
    () =>
      target
        .map((s) => `${s.id}:${Math.round(s.value)}`)
        .join("|"),
    [target],
  );

  useEffect(() => {
    const from = new Map(currentRef.current);
    const t0 = performance.now();

    cancelAnimationFrame(rafRef.current);

    function frame(now: number) {
      const p = Math.min(1, (now - t0) / ms);
      const ease = 1 - (1 - p) ** 3;

      const next: ChartSlice[] = [];
      const cur = new Map<string, number>();

      for (const s of targetRef.current) {
        const fv = from.get(s.id) ?? 0;
        const v = fv + (s.value - fv) * ease;
        cur.set(s.id, v);
        next.push({ ...s, value: v });
      }

      currentRef.current = cur;
      setAnimated(next);

      if (p < 1) rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [key, ms]);

  return animated;
}

// ---------------------------------------------------------------------------
// Donut chart + legend
// ---------------------------------------------------------------------------

function DonutChart({
  data,
  size = 150,
  hovered,
  onHover,
}: {
  data: ChartSlice[];
  size?: number;
  hovered: number;
  onHover: (i: number) => void;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 2;
  const innerR = outerR * 0.56;
  let cumAngle = -Math.PI / 2;

  const segments = data.map((d, i) => {
    const angle = (d.value / total) * Math.PI * 2;
    const start = cumAngle;
    cumAngle += angle;
    return {
      path: describeArc(cx, cy, outerR, innerR, start, cumAngle),
      color: CHART_COLORS[i % CHART_COLORS.length],
    };
  });

  const hoveredSlice = hovered >= 0 ? data[hovered] : null;
  const centerLine1 = hoveredSlice
    ? `${((hoveredSlice.value / total) * 100).toFixed(1)}%`
    : niceBytes(total);
  const centerLine2 = hoveredSlice ? niceBytes(hoveredSlice.value) : "";

  return (
    <svg
      width={size}
      height={size}
      className="mx-auto shrink-0"
      viewBox={`0 0 ${size} ${size}`}
    >
      {segments.map((seg, i) => (
        <path
          key={i}
          d={seg.path}
          fill={seg.color}
          stroke="var(--color-surface)"
          strokeWidth="1.5"
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(-1)}
          className="cursor-pointer"
          style={{
            opacity: hovered === -1 || hovered === i ? 1 : 0.3,
            transition: "opacity 0.15s, transform 0.15s",
            transformOrigin: `${cx}px ${cy}px`,
            transform: hovered === i ? "scale(1.05)" : "scale(1)",
          }}
        />
      ))}
      <text
        x={cx}
        y={centerLine2 ? cy - 6 : cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--color-text)"
        fontSize="12"
        fontWeight="600"
      >
        {centerLine1}
      </text>
      {centerLine2 && (
        <text
          x={cx}
          y={cy + 8}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--color-text-dim)"
          fontSize="10"
        >
          {centerLine2}
        </text>
      )}
    </svg>
  );
}

function ChartLegend({
  data,
  total,
  hovered,
  onHover,
}: {
  data: ChartSlice[];
  total: number;
  hovered: number;
  onHover: (i: number) => void;
}) {
  return (
    <div className="flex flex-col gap-px overflow-auto">
      {data.map((d, i) => {
        const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : "0";
        return (
          <div
            key={d.id}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(-1)}
            className={`flex items-center gap-1.5 px-1.5 py-[3px] rounded text-[10px] cursor-default transition-opacity ${
              hovered >= 0 && hovered !== i ? "opacity-35" : ""
            }`}
          >
            <span
              className="w-2 h-2 rounded-sm shrink-0"
              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
            />
            <span
              className="truncate text-[var(--color-text)] flex-1"
              title={d.label}
            >
              {d.label}
            </span>
            <span className="tabular-nums text-[var(--color-text-dim)] shrink-0">
              {pct}%
            </span>
            <span className="tabular-nums text-[var(--color-text-dim)] shrink-0 w-12 text-right">
              {niceBytes(d.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

type DomainStat = { domain: string; total: number; count: number };

function aggregateByDomain(entries: DisplayEntry[]): DomainStat[] {
  const map = new Map<string, DomainStat>();
  for (const e of entries) {
    if (e.pending || e.filtered) continue;
    const key = e.domain || "(unknown)";
    const stat = map.get(key) ?? { domain: key, total: 0, count: 0 };
    stat.total += e.transferSize;
    stat.count++;
    map.set(key, stat);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function categorizeEntry(e: DisplayEntry): string {
  const ct = e.contentType.toLowerCase();
  const n = e.name.toLowerCase();
  if (
    ct.includes("javascript") ||
    ct.includes("ecmascript") ||
    /\.(js|jsx|ts|tsx|mjs)(\?|$)/.test(n)
  )
    return "JavaScript";
  if (ct.includes("css") || /\.css(\?|$)/.test(n)) return "CSS";
  if (
    ct.startsWith("image/") ||
    /\.(png|jpe?g|gif|svg|webp|ico|avif)(\?|$)/.test(n)
  )
    return "Images";
  if (ct.includes("font") || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(n))
    return "Fonts";
  if (ct.includes("json") || ct.includes("xml")) return "Data";
  if (ct.includes("html")) return "HTML";
  return "Other";
}

function aggregateTopFiles(
  entries: DisplayEntry[],
  limit: number,
): ChartSlice[] {
  const seen = new Set<string>();
  return entries
    .filter((e) => !e.pending && !e.filtered && e.transferSize > 0)
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, limit)
    .map((e) => {
      let id = `file:${e.url}`;
      if (seen.has(id)) id += `:${e.timestamp}`;
      seen.add(id);
      return {
        id,
        label: e.name.split("?")[0] || e.url,
        value: e.transferSize,
        count: 1,
      };
    });
}

function aggregateByType(entries: DisplayEntry[]): ChartSlice[] {
  const map = new Map<string, ChartSlice>();
  for (const e of entries) {
    if (e.pending || e.filtered || e.transferSize <= 0) continue;
    const type = categorizeEntry(e);
    const s =
      map.get(type) ??
      ({ id: `type:${type}`, label: type, value: 0, count: 0 } satisfies ChartSlice);
    s.value += e.transferSize;
    s.count++;
    map.set(type, s);
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Right panel — shared primitives
// ---------------------------------------------------------------------------

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold cursor-pointer transition-colors border-b-2
        ${
          active
            ? "text-[var(--color-accent)] border-[var(--color-accent)]"
            : "text-[var(--color-text-dim)] border-transparent hover:text-[var(--color-text)]"
        }
      `}
    >
      {label}
    </button>
  );
}

function PerspectiveButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        px-2 py-0.5 text-[10px] rounded-full cursor-pointer transition-colors
        ${
          active
            ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] font-semibold"
            : "text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
        }
      `}
    >
      {label}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center text-[var(--color-text-dim)] text-[11px] h-full">
      Waiting for data...
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: By Resource (donut chart with perspective switcher)
// ---------------------------------------------------------------------------

type Perspective = "topFiles" | "byType";

function ResourceImpact({ entries }: { entries: DisplayEntry[] }) {
  const [perspective, setPerspective] = useState<Perspective>("topFiles");
  const [hovered, setHovered] = useState(-1);

  const targetData = useMemo(
    () =>
      perspective === "topFiles"
        ? aggregateTopFiles(entries, 10)
        : aggregateByType(entries),
    [entries, perspective],
  );

  const data = useAnimatedSlices(targetData);
  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);

  if (targetData.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex gap-1 px-2.5 pt-2 pb-1 shrink-0">
        <PerspectiveButton
          label="Top Files"
          active={perspective === "topFiles"}
          onClick={() => {
            setPerspective("topFiles");
            setHovered(-1);
          }}
        />
        <PerspectiveButton
          label="By Type"
          active={perspective === "byType"}
          onClick={() => {
            setPerspective("byType");
            setHovered(-1);
          }}
        />
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2 flex flex-col gap-2 items-center">
        <DonutChart
          data={data}
          hovered={hovered}
          onHover={setHovered}
        />
        <ChartLegend
          data={data}
          total={total}
          hovered={hovered}
          onHover={setHovered}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: By Domain (bar chart with percentages)
// ---------------------------------------------------------------------------

function DomainImpact({ entries }: { entries: DisplayEntry[] }) {
  const stats = useMemo(
    () => aggregateByDomain(entries).slice(0, 14),
    [entries],
  );
  const grandTotal = useMemo(
    () => stats.reduce((s, d) => s + d.total, 0),
    [stats],
  );
  const maxTotal = stats.length > 0 ? stats[0].total : 1;

  if (stats.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col gap-1.5 overflow-auto p-2.5 h-full">
      {stats.map((stat) => {
        const barPct = (stat.total / maxTotal) * 100;
        const share =
          grandTotal > 0
            ? ((stat.total / grandTotal) * 100).toFixed(1)
            : "0";
        return (
          <div key={stat.domain} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2 min-w-0">
              <span
                className="text-[11px] truncate text-[var(--color-text)]"
                title={stat.domain}
              >
                {stat.domain}
              </span>
              <span className="text-[10px] text-[var(--color-text-dim)] tabular-nums shrink-0">
                {share}%{" "}
                <span className="text-[var(--color-text-dim)]/60">·</span>{" "}
                {niceBytes(stat.total)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-[var(--color-border)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-500 ease-out"
                style={{ width: `${barPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Impact Panel (tabbed right panel)
// ---------------------------------------------------------------------------

type ImpactTab = "resource" | "domain";

function ImpactAttribution() {
  return (
    <footer className="shrink-0 px-2.5 py-2 border-t border-[var(--color-border)]/50 bg-[var(--color-surface)]/80">
      <a
        href="https://github.com/lofcz"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[9px] leading-tight text-[var(--color-text-dim)]/55 hover:text-[var(--color-text-dim)] underline-offset-2 hover:underline transition-colors"
      >
        Matěj &quot;lofcz&quot; Štágl
      </a>
    </footer>
  );
}

function ImpactPanel({ entries }: { entries: DisplayEntry[] }) {
  const [tab, setTab] = useState<ImpactTab>("resource");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
        <TabButton
          label="By Resource"
          active={tab === "resource"}
          onClick={() => setTab("resource")}
        />
        <TabButton
          label="By Domain"
          active={tab === "domain"}
          onClick={() => setTab("domain")}
        />
      </div>
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "resource" ? (
            <ResourceImpact entries={entries} />
          ) : (
            <DomainImpact entries={entries} />
          )}
        </div>
        <ImpactAttribution />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt Modal
// ---------------------------------------------------------------------------

const LENS_LABELS: Record<Lens, string> = {
  performance: "Performance",
  route: "Route Analysis",
  action: "Action Trace",
};

function markdownToHtml(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");

  html = html.replace(
    /\|(.+)\|\n\|[-| ]+\|\n((?:\|.+\|\n?)*)/g,
    (_match, headerRow: string, bodyRows: string) => {
      const headers = headerRow
        .split("|")
        .map((h: string) => h.trim())
        .filter(Boolean);
      const thCells = headers.map((h: string) => `<th>${h}</th>`).join("");

      const rows = bodyRows
        .trim()
        .split("\n")
        .map((row: string) => {
          const cells = row
            .split("|")
            .map((c: string) => c.trim())
            .filter(Boolean);
          return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join("")}</tr>`;
        })
        .join("");

      return `<table><thead><tr>${thCells}</tr></thead><tbody>${rows}</tbody></table>`;
    },
  );

  html = html.replace(
    /^- (.+)$/gm,
    "<li>$1</li>",
  );
  html = html.replace(
    /(<li>.*<\/li>\n?)+/g,
    (block) => `<ul>${block}</ul>`,
  );

  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  html = html.replace(/\n{2,}/g, "<br/><br/>");

  return html;
}

function PromptModal({
  entries,
  recording,
  onClose,
}: {
  entries: NetworkEntry[];
  recording: Recording | null;
  onClose: () => void;
}) {
  const defaultLens = useMemo(
    () => pickDefaultLens(recording),
    [recording],
  );
  const [lens, setLens] = useState<Lens>(defaultLens);
  const [copied, setCopied] = useState(false);

  const pageUrl = useMemo(() => {
    if (recording?.startUrl) return recording.startUrl;
    return undefined;
  }, [recording]);

  const prompt = useMemo(
    () => generatePrompt(lens, entries, recording, pageUrl),
    [lens, entries, recording, pageUrl],
  );

  const previewHtml = useMemo(() => markdownToHtml(prompt), [prompt]);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [prompt]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="prompt-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="prompt-card">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          <h2 className="text-[13px] font-semibold text-[var(--color-text)] m-0">
            Generate AI Prompt
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] transition-colors cursor-pointer text-sm"
          >
            ×
          </button>
        </div>

        {/* Lens selector */}
        <div className="flex border-b border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          {(["performance", "route", "action"] as Lens[]).map((l) => (
            <TabButton
              key={l}
              label={LENS_LABELS[l]}
              active={lens === l}
              onClick={() => { setLens(l); setCopied(false); }}
            />
          ))}
        </div>

        {/* Preview */}
        <div className="flex-1 overflow-auto px-4 py-3 min-h-0">
          <div
            className="prompt-preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          <span className="text-[10px] text-[var(--color-text-dim)]">
            {entries.filter((e) => !e.pending).length} requests captured
            {recording
              ? ` · ${recording.interactions.length} interaction${recording.interactions.length !== 1 ? "s" : ""} recorded`
              : ""}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md
              border transition-colors cursor-pointer
              ${copied
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                : "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/8 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/15 hover:border-[var(--color-accent)]/60"}`}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <IconCopy />
            )}
            {copied ? "Copied!" : "Copy Prompt"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { paused, toggle: togglePause } = usePaused();
  const { entries, clear } = useEntries(paused);
  const {
    filters,
    add: addFilter,
    remove: removeFilter,
    toggle: toggleFilter,
  } = useFilters();
  const {
    recording: isRecording,
    elapsed: recordElapsed,
    lastRecording,
    toggle: toggleRecord,
  } = useRecording(clear);

  const [sortKey, setSortKey] = useState<SortKey>("transferSize");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const { granted: inFlightHostsGranted, request: requestInFlightHosts } =
    useInFlightHostPermission();

  const displayEntries: DisplayEntry[] = useMemo(
    () =>
      entries.map((e) => ({
        ...e,
        filtered: matchesAnyFilter(e.url, filters),
      })),
    [entries, filters],
  );

  const activeEntries = useMemo(
    () => displayEntries.filter((e) => !e.filtered && !e.pending),
    [displayEntries],
  );

  const activeFilterCount = useMemo(
    () => filters.filter((f) => f.enabled).length,
    [filters],
  );

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir(key === "transferSize" ? "desc" : "asc");
      }
    },
    [sortKey],
  );

  const handleCopy = useCallback(async () => {
    const lines = activeEntries
      .sort((a, b) => b.transferSize - a.transferSize)
      .map((e) => `${e.url} size: ${niceBytes(e.transferSize)}`)
      .join("\n");
    if (!lines) return;
    await copyToClipboard(lines);
  }, [activeEntries]);

  const handleToggleRecord = useCallback(async () => {
    const rec = await toggleRecord();
    if (rec) {
      setPromptOpen(true);
    }
  }, [toggleRecord]);

  const handleGeneratePrompt = useCallback(() => {
    setPromptOpen(true);
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <PendingInFlightBanner
        granted={inFlightHostsGranted}
        onEnable={async () => {
          await requestInFlightHosts();
        }}
      />
      <Toolbar
        count={activeEntries.length}
        total={totalBytes(activeEntries)}
        paused={paused}
        filterCount={activeFilterCount}
        filtersOpen={filtersOpen}
        isRecording={isRecording}
        recordElapsed={recordElapsed}
        onClear={clear}
        onCopy={handleCopy}
        onTogglePause={togglePause}
        onToggleFilters={() => setFiltersOpen((o) => !o)}
        onToggleRecord={handleToggleRecord}
        onGeneratePrompt={handleGeneratePrompt}
      />

      {filtersOpen && (
        <FilterBar
          filters={filters}
          onAdd={addFilter}
          onRemove={removeFilter}
          onToggle={toggleFilter}
        />
      )}

      <PanelGroup direction="horizontal" className="flex-1 min-h-0" id="ne-root">
        <Panel id="ne-requests" defaultSize={70} minSize={30}>
          <RequestTable
            entries={displayEntries}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          />
        </Panel>

        <PanelResizeHandle id="ne-split" />

        <Panel id="ne-impact" defaultSize={30} minSize={15}>
          <ImpactPanel entries={displayEntries} />
        </Panel>
      </PanelGroup>

      {promptOpen && (
        <PromptModal
          entries={activeEntries}
          recording={lastRecording}
          onClose={() => setPromptOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

applyTheme();
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
