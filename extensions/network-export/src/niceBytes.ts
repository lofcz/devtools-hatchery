const units = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] as const;

export function niceBytes(x: number): string {
  let level = 0;
  let n = Math.max(0, Math.floor(x)) || 0;
  while (n >= 1024 && level < units.length - 1) {
    n /= 1024;
    level++;
  }
  const decimals = n < 10 && level > 0 ? 1 : 0;
  return `${n.toFixed(decimals)} ${units[level]}`;
}
