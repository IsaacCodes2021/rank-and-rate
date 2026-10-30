// Looks through the files git tracks for things that must never be committed (D058):
// private keys, tokens and passwords written into code. Run by CI and before any push.
//   node scripts/secret-scan.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Rule = { name: string; pattern: RegExp };

const RULES: Rule[] = [
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Cloudflare API token variable', pattern: /CLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{30,}/ },
  { name: 'secret written into code', pattern: /\b(?:secret|token|password|passwd|api[_-]?key|pin[_-]?salt|admin[_-]?code)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
];

export type Finding = { file: string; line: number; rule: string };

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    if (lineText.includes('secret-scan: allow')) return;
    for (const rule of RULES) {
      if (rule.pattern.test(lineText)) out.push({ file, line: i + 1, rule: rule.name });
    }
  });
  return out;
}

export function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return raw.split('\0').filter(Boolean);
}

// The scan's own test file holds fake keys on purpose, to prove the rules fire.
const SKIP = /(^|\/)(package-lock\.json|worker-configuration\.d\.ts|secret-scan\.test\.ts)$/;

export function scanTracked(): Finding[] {
  const findings: Finding[] = [];
  for (const file of trackedFiles()) {
    if (SKIP.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // deleted in the working tree, or not readable as text
    }
    findings.push(...scanText(file, text));
  }
  return findings;
}

if (import.meta.filename === process.argv[1]) {
  const findings = scanTracked();
  if (findings.length === 0) {
    console.log('Secret scan: nothing found');
  } else {
    for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}`);
    console.error(`Secret scan: ${findings.length} finding(s). Remove them, or move the value into a Cloudflare secret.`);
    process.exit(1);
  }
}
