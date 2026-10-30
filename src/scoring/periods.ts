// The date ranges behind the period filters (D072). Dates are YYYY-MM-DD in the building's time
// zone, and a week starts on Monday. A null end means no limit that way.
export const PERIODS = [
  { key: 'this-week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'all-time', label: 'All time' },
] as const;

export type PeriodKey = (typeof PERIODS)[number]['key'];
export type DateRange = { from: string | null; to: string | null };

const toDate = (s: string) => new Date(`${s}T12:00:00Z`);
const toText = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, days: number) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toText(d);
};

export const isPeriodKey = (s: string): s is PeriodKey => PERIODS.some((p) => p.key === s);

export function periodRange(key: PeriodKey, today: string): DateRange {
  const sinceMonday = (toDate(today).getUTCDay() + 6) % 7;
  const monday = addDays(today, -sinceMonday);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  switch (key) {
    case 'this-week':
      return { from: monday, to: today };
    case 'last-week':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this-month':
      return { from: firstOfMonth, to: today };
    case 'last-month': {
      const lastOfPrevious = addDays(firstOfMonth, -1);
      return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious };
    }
    case 'all-time':
      return { from: null, to: null };
  }
}

export const inRange = (date: string, range: DateRange) => (range.from === null || date >= range.from) && (range.to === null || date <= range.to);
