// Check local links in the operator-facing cloud documents, without credentials.
import fs from 'node:fs';
import path from 'node:path';
for (const file of ['README.md', 'docs/azure-migration-plan.md', 'docs/azure-migration.md']) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:\/\//i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) throw new Error(`Broken link in ${file}: ${target}`);
  }
}
console.log('Cloud documentation links resolve');
