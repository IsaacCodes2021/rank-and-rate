// The Worker's entry file. Cloudflare treats every export here as an entry point, so this file
// exports the Worker and nothing else; the app itself lives in app.ts.
import { createApp } from './app.ts';

export default createApp();
