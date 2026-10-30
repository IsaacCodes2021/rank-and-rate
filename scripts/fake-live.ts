// Writes the SQL for fake running sorts, for: npm run dev:fake-live
// That script only ever applies it to the local database (--local). See db/fake-live.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fakeLiveSql } from '../db/fake-live.ts';

const now = new Date();
const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
mkdirSync('.local', { recursive: true });
writeFileSync('.local/fake-live.sql', fakeLiveSql(now.getTime(), today));
console.log(`Wrote .local/fake-live.sql for ${today}`);
