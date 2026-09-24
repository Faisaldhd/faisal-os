/**
 * Byte counts as the rest of the OS prints them. System Monitor already shows storage in the
 * same latin units ("8 GB"), so the messages that quote a limit stay consistent with it.
 */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}
