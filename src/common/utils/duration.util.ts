/**
 * Parse a duration string (e.g., "7d", "12h", "30m", "45s") into seconds.
 * Supports: d (days), h (hours), m (minutes), s (seconds).
 * If no unit is provided, treats as seconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([dhms])?$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${duration}". Use e.g., "7d", "12h".`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60;
    case 'h':
      return value * 60 * 60;
    case 'm':
      return value * 60;
    case 's':
      return value;
    default:
      return value;
  }
}
