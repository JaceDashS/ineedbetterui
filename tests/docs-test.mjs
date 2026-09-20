// Keeps references/reference.md in step with the code: every endpoint, query
// option, event type and skill file the code defines must be named in the
// document. A failure here means the code changed without the document.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResults } from './helpers/results.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = path.join(repo, 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui');
const server = fs.readFileSync(path.join(skillDir, 'ineedbetterui.mjs'), 'utf8');
const reference = fs.readFileSync(path.join(skillDir, 'references', 'reference.md'), 'utf8');

const { check, finish } = createResults();
const named = term => reference.includes('`' + term + '`') || reference.includes('`' + term + ' ') || reference.includes(' ' + term + '`');
const unique = values => [...new Set(values)];

const routes = unique([...server.matchAll(/url\.pathname === '(\/api\/[a-z/-]+)'/g)].map(match => match[1]));
if (/parts\[2\]/.test(server)) routes.push('/api/entries/:id');
for (const [, sub] of server.matchAll(/parts\[3\] === '([a-z-]+)'/g)) routes.push(`/api/entries/:id/${sub}`);
check('routes were found in the server', routes.length >= 10, routes.join(', '));
for (const route of unique(routes)) check(`endpoint ${route} is documented`, named(route));

const queries = unique([...server.matchAll(/searchParams\.get\('([a-zA-Z]+)'\)/g)].map(match => match[1]));
for (const query of queries) check(`query option ${query} is documented`, named(query));

const events = unique([...server.matchAll(/\bt: '([a-z-]+)'/g)].map(match => match[1]));
for (const type of events) check(`event type ${type} is documented`, reference.includes(`"t":"${type}"`) || named(type));

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const full = path.join(dir, item.name);
  return item.isDirectory() ? walk(full) : [path.relative(skillDir, full).split(path.sep).join('/')];
});
const files = walk(skillDir).filter(file => !/\.private\./.test(file));
for (const file of files) check(`skill file ${file} is documented`, reference.includes(file) || reference.includes(path.basename(file)));

finish();
