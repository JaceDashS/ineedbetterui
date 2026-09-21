// Keeps references/reference.md in step with the code: every endpoint, query
// option, event type and skill file the code defines must be named in the
// document. A failure here means the code changed without the document.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResults } from './helpers/results.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = path.join(repo, 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui');
const serverFiles = [
  'ineedbetterui.mjs',
  ...fs.readdirSync(path.join(skillDir, 'lib'), { recursive: true })
    .filter(file => file.endsWith('.mjs'))
    .map(file => path.join('lib', file))
];
const server = serverFiles.map(file => fs.readFileSync(path.join(skillDir, file), 'utf8')).join('\n');
const cli = fs.readFileSync(path.join(repo, 'bin', 'ineedbetterui.mjs'), 'utf8');
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

// The command is the agent's whole interface to the server, so a subcommand or
// a flag the code accepts and the document never mentions is a missing page.
const commands = unique([...cli.matchAll(/command === '([a-z]+)'/g)].map(match => match[1]))
  .filter(name => !['start', 'help', 'postinstall'].includes(name));
check('commands were found in the command line', commands.length >= 5, commands.join(', '));
for (const name of commands) check(`command ${name} is documented`, reference.includes(`ineedbetterui ${name}`));

const flags = unique([
  ...[...cli.matchAll(/flags\.([a-zA-Z]+)/g)].map(match => match[1]),
  ...[...cli.matchAll(/readContent\(flags, '([a-zA-Z]+)', '([a-zA-Z]+)'\)/g)].flatMap(match => [match[1], match[2]])
]);
check('flags were found in the command line', flags.length >= 8, flags.join(', '));
for (const flag of flags) check(`flag --${flag} is documented`, named(`--${flag}`));

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const full = path.join(dir, item.name);
  return item.isDirectory() ? walk(full) : [path.relative(skillDir, full).split(path.sep).join('/')];
});
const files = walk(skillDir).filter(file => !/\.private\./.test(file));
for (const file of files) check(`skill file ${file} is documented`, reference.includes(file) || reference.includes(path.basename(file)));

finish();
