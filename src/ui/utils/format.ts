/** Format an ISO timestamp for display, falling back to the raw string on invalid dates. */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  return isNaN(date.getTime()) ? iso : date.toLocaleString()
}
