// How numbers and times are written on the screens. The formatters are made once: a page writes
// hundreds of numbers, and building a new formatter for each would use up the Worker's CPU limit.
const TIME_ZONE = 'America/Los_Angeles';

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const TENTHS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const LOCAL_HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TIME_ZONE });

export const clock = (ms: number) => TIME.format(ms);
export const clockOf = (iso: string) => clock(Date.parse(iso));
export const count = (n: number) => WHOLE.format(Math.round(n));
export const oneDecimal = (n: number) => TENTHS.format(Math.round(n * 10) / 10);
export const shortDay = (date: string) => SHORT_DAY.format(Date.parse(`${date}T12:00:00Z`));
export const longDay = (date: string) => LONG_DAY.format(Date.parse(`${date}T12:00:00Z`));

// The building's offset from UTC in hours on a date, -7 or -8. Whole hours keep quarter hours on the quarter hour.
const offsets = new Map<string, number>();
export function pacificOffsetHours(date: string): number {
  let offset = offsets.get(date);
  if (offset === undefined) {
    offset = Number(LOCAL_HOUR.format(Date.parse(`${date}T12:00:00Z`))) - 12;
    if (offsets.size > 500) offsets.clear();
    offsets.set(date, offset);
  }
  return offset;
}
