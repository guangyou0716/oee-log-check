const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parses an ISO 8601 date-time. Returns epoch ms and whether the text carried a zone (Z or offset). */
export function parseTimestamp(text: string): { ms: number; zoned: boolean } | undefined {
  const m = TIMESTAMP.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const [, y, mo, d, h, mi, s = '0', frac = '', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, Math.floor(Number(`0.${frac || '0'}`) * 1000));
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2));
    if (offH > 23 || offM > 59) {
      return undefined;
    }
    ms -= sign * (offH * 60 + offM) * 60_000;
  }
  return { ms, zoned: zone !== undefined };
}

/** "45 s", "12 min", "3 h 5 min", "2 h 0 min 30 s". */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds * 1000) / 1000;
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = Math.round((total % 60) * 1000) / 1000;
  return h ? `${h} h ${m} min${sec ? ` ${sec} s` : ''}` : `${m} min${sec ? ` ${sec} s` : ''}`;
}
