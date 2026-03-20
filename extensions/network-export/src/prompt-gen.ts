import type { Interaction, NetworkEntry, Recording } from "./entry";

// ---------------------------------------------------------------------------
// Lens type
// ---------------------------------------------------------------------------

export type Lens = "performance" | "route" | "action";

export function pickDefaultLens(
  recording: Recording | null,
): Lens {
  if (!recording) return "performance";
  const hasNavigation = recording.interactions.some(
    (i) => i.type === "navigate",
  );
  const hasClicks = recording.interactions.some(
    (i) => i.type === "click" || i.type === "submit",
  );
  if (hasClicks) return "action";
  if (hasNavigation) return "route";
  return "performance";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const UNITS = ["bytes", "KiB", "MiB", "GiB"] as const;
function fmtBytes(x: number): string {
  let n = Math.max(0, x);
  let lvl = 0;
  while (n >= 1024 && lvl < UNITS.length - 1) {
    n /= 1024;
    lvl++;
  }
  const dec = n < 10 && lvl > 0 ? 1 : 0;
  return `${n.toFixed(dec)} ${UNITS[lvl]}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function categorize(e: NetworkEntry): string {
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

type Observation = { emoji: string; text: string };

function detectObservations(entries: NetworkEntry[]): Observation[] {
  const obs: Observation[] = [];

  const largeBundles = entries.filter((e) => e.transferSize > 500 * 1024);
  for (const e of largeBundles) {
    obs.push({
      emoji: "⚠️",
      text: `Large bundle: \`${e.name.split("?")[0]}\` (${fmtBytes(e.transferSize)})`,
    });
  }

  const urlCounts = new Map<string, number>();
  for (const e of entries) {
    const key = e.url.split("?")[0];
    urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1);
  }
  for (const [url, count] of urlCounts) {
    if (count >= 2) {
      const name = url.split("/").pop() || url;
      obs.push({
        emoji: "🔁",
        text: `Duplicate request: \`${name}\` called ${count} times`,
      });
    }
  }

  const cached = entries.filter(
    (e) => e.transferSize === 0 && e.statusCode >= 200 && e.statusCode < 400,
  );
  if (cached.length > 0) {
    obs.push({
      emoji: "💾",
      text: `${cached.length} request${cached.length > 1 ? "s" : ""} served from cache (0 bytes transferred)`,
    });
  }

  const errors = entries.filter((e) => e.statusCode >= 400);
  for (const e of errors) {
    obs.push({
      emoji: "❌",
      text: `HTTP ${e.statusCode}: \`${e.name.split("?")[0]}\``,
    });
  }

  const apiDomains = new Map<string, NetworkEntry[]>();
  for (const e of entries) {
    if (categorize(e) === "Data") {
      const list = apiDomains.get(e.domain) ?? [];
      list.push(e);
      apiDomains.set(e.domain, list);
    }
  }
  for (const [domain, reqs] of apiDomains) {
    if (reqs.length < 3) continue;
    const sorted = [...reqs].sort((a, b) => a.timestamp - b.timestamp);
    let sequential = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
      const prevDur = sorted[i - 1].duration;
      if (gap > prevDur * 0.8 && gap < prevDur * 1.5) sequential++;
    }
    if (sequential >= 2) {
      obs.push({
        emoji: "🔗",
        text: `${sequential + 1} sequential API calls to \`${domain}\` — could potentially be parallelized`,
      });
    }
  }

  return obs;
}

function buildBreakdown(entries: NetworkEntry[]): string {
  const byType = new Map<string, { size: number; count: number }>();
  for (const e of entries) {
    const type = categorize(e);
    const s = byType.get(type) ?? { size: 0, count: 0 };
    s.size += e.transferSize;
    s.count++;
    byType.set(type, s);
  }

  const totalSize = entries.reduce((s, e) => s + e.transferSize, 0);
  const sorted = [...byType.entries()].sort((a, b) => b[1].size - a[1].size);

  const lines = sorted.map(([type, stat]) => {
    const pct =
      totalSize > 0 ? ((stat.size / totalSize) * 100).toFixed(1) : "0";
    return `- **${type}**: ${fmtBytes(stat.size)} (${pct}%) — ${stat.count} file${stat.count > 1 ? "s" : ""}`;
  });

  return lines.join("\n");
}

function buildRequestTable(
  entries: NetworkEntry[],
  offsetMs?: number,
): string {
  const sorted = [...entries].sort(
    (a, b) => b.transferSize - a.transferSize,
  );
  const limited = sorted.slice(0, 30);

  const rows = limited.map((e, i) => {
    const num = String(i + 1);
    const offset =
      offsetMs != null
        ? `+${Math.round(e.timestamp - offsetMs)}ms`
        : new Date(e.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
    const name = e.name.split("?")[0];
    const truncName = name.length > 40 ? `…${name.slice(-38)}` : name;
    const size = fmtBytes(e.transferSize);
    const time = fmtDuration(e.duration);
    const status = String(e.statusCode);
    return `| ${num} | ${offset} | ${truncName} | ${size} | ${time} | ${status} |`;
  });

  const header = "| # | Time | URL | Size | Duration | Status |";
  const sep = "|---|------|-----|------|----------|--------|";
  const table = [header, sep, ...rows].join("\n");

  if (sorted.length > 30) {
    return `${table}\n\n*… and ${sorted.length - 30} more requests*`;
  }
  return table;
}

function describeInteraction(i: Interaction): string {
  if (i.type === "navigate") {
    return `Navigated from \`${i.fromUrl ?? "?"}\` to \`${i.toUrl ?? "?"}\``;
  }
  const el = i.element;
  if (!el) return `${i.type === "submit" ? "Submitted form" : "Clicked"} (unknown element)`;
  const parts: string[] = [];
  if (el.text) parts.push(`"${el.text}"`);
  if (el.id) parts.push(`#${el.id}`);
  const selStr = el.selector ? ` (\`${el.selector}\`)` : "";
  const what = parts.length > 0 ? parts.join(" ") : `<${el.tag}>`;
  return `${i.type === "submit" ? "Submitted" : "Clicked"} ${what}${selStr}`;
}

// ---------------------------------------------------------------------------
// Lens generators
// ---------------------------------------------------------------------------

export function generatePerformancePrompt(
  entries: NetworkEntry[],
  pageUrl?: string,
): string {
  const active = entries.filter(
    (e) => !e.pending && e.transferSize > 0,
  );
  const totalSize = active.reduce((s, e) => s + e.transferSize, 0);
  const totalDur =
    active.length > 0
      ? Math.max(...active.map((e) => e.timestamp + e.duration)) -
        Math.min(...active.map((e) => e.timestamp))
      : 0;

  const lines: string[] = [];
  lines.push("## Performance Audit\n");
  lines.push("I captured the following network activity from my web app and need help optimizing it.\n");

  lines.push("### Page Context");
  if (pageUrl) lines.push(`- **URL**: ${pageUrl}`);
  lines.push(
    `- **Total**: ${active.length} request${active.length !== 1 ? "s" : ""}, ${fmtBytes(totalSize)} transferred, ${fmtDuration(totalDur)} wall time`,
  );
  lines.push("");

  lines.push("### Network Activity\n");
  lines.push(buildRequestTable(active));
  lines.push("");

  lines.push("### Breakdown by Type\n");
  lines.push(buildBreakdown(active));
  lines.push("");

  const obs = detectObservations(active);
  if (obs.length > 0) {
    lines.push("### Auto-detected Observations\n");
    for (const o of obs) lines.push(`- ${o.emoji} ${o.text}`);
    lines.push("");
  }

  lines.push("### Questions for AI\n");
  lines.push(
    "- Which resources are the best candidates for size reduction (code splitting, tree shaking, compression)?",
  );
  lines.push("- Are there any unnecessary or redundant requests?");
  lines.push(
    "- What caching strategy improvements would reduce repeat transfer sizes?",
  );
  lines.push(
    "- Are there requests that could be deferred, lazy-loaded, or parallelized?",
  );

  return lines.join("\n");
}

export function generateRoutePrompt(
  entries: NetworkEntry[],
  recording: Recording | null,
  pageUrl?: string,
): string {
  const active = entries.filter((e) => !e.pending);
  const totalSize = active.reduce((s, e) => s + e.transferSize, 0);

  const lines: string[] = [];
  lines.push("## Route Analysis\n");
  lines.push(
    "I captured network activity during a route transition and need help understanding the data loading behavior.\n",
  );

  lines.push("### Navigation");
  const fromUrl = recording?.startUrl ?? pageUrl ?? "(unknown)";
  const toUrl = recording?.endUrl ?? pageUrl ?? "(same page)";
  lines.push(`- **From**: ${fromUrl}`);
  lines.push(`- **To**: ${toUrl}`);

  if (recording?.interactions.length) {
    const nav = recording.interactions.find((i) => i.type === "navigate");
    const click = recording.interactions.find(
      (i) => i.type === "click" || i.type === "submit",
    );
    const trigger = click ?? nav;
    if (trigger) {
      lines.push(`- **Trigger**: ${describeInteraction(trigger)}`);
    }
  }
  lines.push("");

  const apiCalls = active.filter(
    (e) =>
      categorize(e) === "Data" ||
      e.contentType.includes("json") ||
      e.contentType.includes("xml"),
  );
  const staticAssets = active.filter(
    (e) =>
      categorize(e) !== "Data" &&
      !e.contentType.includes("json") &&
      !e.contentType.includes("xml"),
  );

  if (apiCalls.length > 0) {
    lines.push(
      `### API / Data Requests (${apiCalls.length} calls, ${fmtBytes(apiCalls.reduce((s, e) => s + e.transferSize, 0))})\n`,
    );
    lines.push(
      buildRequestTable(apiCalls, recording?.startTime),
    );
    lines.push("");
  }

  if (staticAssets.length > 0) {
    lines.push(
      `### Static Assets (${staticAssets.length} files, ${fmtBytes(staticAssets.reduce((s, e) => s + e.transferSize, 0))})\n`,
    );
    lines.push(buildBreakdown(staticAssets));
    lines.push("");
  }

  lines.push(
    `### Total Data Loaded for Route: **${fmtBytes(totalSize)}**\n`,
  );

  const obs = detectObservations(active);
  if (obs.length > 0) {
    lines.push("### Observations\n");
    for (const o of obs) lines.push(`- ${o.emoji} ${o.text}`);
    lines.push("");
  }

  lines.push("### Questions for AI\n");
  lines.push(
    "- What data is being fetched on this route, and is all of it needed immediately?",
  );
  lines.push(
    "- Could any of these API calls be combined, cached, or deferred?",
  );
  lines.push(
    "- Are there JS chunks being loaded that could be pre-fetched or lazy-loaded?",
  );

  return lines.join("\n");
}

export function generateActionPrompt(
  entries: NetworkEntry[],
  recording: Recording | null,
  pageUrl?: string,
): string {
  const active = entries.filter((e) => !e.pending);

  const lines: string[] = [];
  lines.push("## Action Trace\n");
  lines.push(
    "I recorded a user interaction on my web app and captured all resulting network activity. Help me analyze the request cascade.\n",
  );

  lines.push("### Context");
  lines.push(`- **Page**: ${recording?.startUrl ?? pageUrl ?? "(unknown)"}`);
  if (recording) {
    const elapsed = recording.endTime - recording.startTime;
    lines.push(`- **Recording duration**: ${fmtDuration(elapsed)}`);
  }
  lines.push("");

  if (recording?.interactions.length) {
    lines.push("### User Interactions (timeline)\n");
    for (const inter of recording.interactions) {
      const offset = `+${Math.round(inter.timestamp - recording.startTime)}ms`;
      lines.push(`- **${offset}**: ${describeInteraction(inter)}`);
    }
    lines.push("");
  }

  const baseTs = recording?.startTime ?? (active.length > 0 ? Math.min(...active.map((e) => e.timestamp)) : Date.now());
  lines.push(
    `### Request Cascade (${active.length} requests, ${fmtBytes(active.reduce((s, e) => s + e.transferSize, 0))})\n`,
  );
  lines.push(buildRequestTable(active, baseTs));
  lines.push("");

  if (active.length > 1) {
    const sorted = [...active].sort((a, b) => a.timestamp - b.timestamp);
    let parallelGroups = 0;
    let sequentialChains = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const gap = sorted[i].timestamp - prev.timestamp;
      if (gap < 10) parallelGroups++;
      else if (gap > prev.duration * 0.5) sequentialChains++;
    }
    lines.push("### Request Pattern\n");
    if (parallelGroups > 0)
      lines.push(
        `- ${parallelGroups + 1} requests appear to fire in parallel`,
      );
    if (sequentialChains > 0)
      lines.push(
        `- ${sequentialChains} sequential request chain${sequentialChains > 1 ? "s" : ""} detected (each waits for the previous)`,
      );
    lines.push("");
  }

  const obs = detectObservations(active);
  if (obs.length > 0) {
    lines.push("### Observations\n");
    for (const o of obs) lines.push(`- ${o.emoji} ${o.text}`);
    lines.push("");
  }

  lines.push("### Questions for AI\n");
  lines.push(
    "- Is the request cascade optimal, or are there unnecessary sequential dependencies?",
  );
  lines.push(
    "- Are there redundant or duplicate requests that should be deduped?",
  );
  lines.push(
    "- What is causing the most latency, and how can it be reduced?",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export function generatePrompt(
  lens: Lens,
  entries: NetworkEntry[],
  recording: Recording | null,
  pageUrl?: string,
): string {
  switch (lens) {
    case "performance":
      return generatePerformancePrompt(entries, pageUrl);
    case "route":
      return generateRoutePrompt(entries, recording, pageUrl);
    case "action":
      return generateActionPrompt(entries, recording, pageUrl);
  }
}
