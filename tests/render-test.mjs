import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiClient } from './helpers/api-client.mjs';
import { createResults } from './helpers/results.mjs';
import { startServer, stopServer } from './helpers/server.mjs';

const { check, finish } = createResults();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-verify-'));
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const server = startServer(projectDir);
await server.ready;
const base = server.url();
const apiClient = createApiClient();
const call = (method, route, body, headers) => apiClient.request(base, method, route, body, headers);

try {
  const html = await (await fetch(base + '/')).text();
  const clientSource = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  try { new Function(clientSource); check('client script compiles', true); }
  catch (error) { check('client script compiles', false, error.message); }
  check('code block background rule wins over .entry pre', html.includes('.entry pre.code-block{background:var(--code-bg)'));

  const pureSource = html.slice(html.indexOf('function escapeHtml('), html.indexOf('function bodyHtml('));
  const { highlightCode, renderMarkdown } = new Function(`${pureSource}; return { highlightCode, renderMarkdown };`)();
  const tok = (kind, text) => `<span class="tok-${kind}">${text}</span>`;
  const cases = [
    ['js line comment', 'js', 'const a = 1; // note', [tok('keyword', 'const'), tok('comment', '// note'), tok('number', '1')]],
    ['js hash is not a comment', 'js', 'this.#priv', [], ['tok-comment']],
    ['ts alias', 'ts', 'let a', [tok('keyword', 'let')]],
    ['json key', 'json', '{"key": 12}', [tok('function', '&quot;key&quot;'), tok('number', '12')]],
    ['bash hash rules', 'bash', 'echo "a # b" ${#arr} # real', [tok('string', '&quot;a # b&quot;'), tok('comment', '# real')], ['tok-comment">#arr']],
    ['html', 'svg', '<div class="x"><!-- c --></div>', ['&lt;' + tok('keyword', 'div'), tok('function', 'class'), tok('comment', '&lt;!-- c --&gt;')]],
    ['css', 'css', '.a { color: red !important; }', [tok('function', 'color'), tok('keyword', '!important')]],
    ['unknown language plain', 'foo', '<script>alert(1)</script>', ['&lt;script&gt;alert(1)&lt;/script&gt;'], ['<span']],
  ];
  for (const [name, lang, code, includes, excludes = []] of cases) {
    const result = highlightCode(code, lang);
    check(`highlight: ${name}`, includes.every(part => result.includes(part)) && !excludes.some(part => result.includes(part)), result);
  }
  const xss = renderMarkdown('\u0060\u0060\u0060html\n<img src=x onerror=alert(1)>\n**bold**\n\u0060\u0060\u0060');
  check('markdown: html block stays inert', !xss.includes('<img') && !xss.includes('<strong>'), xss);

  const md = renderMarkdown('# Title\n## Sub\n\n> quoted line\n> second\n\nplain *italic* and _also_ with line<br>break');
  check('markdown: headings render below the entry heading level', md.includes('<h4 class="md-heading">Title</h4>') && md.includes('<h5 class="md-heading">Sub</h5>'), md);
  check('markdown: blockquote joins its lines', md.includes('<blockquote>quoted line<br>second</blockquote>'), md);
  check('markdown: explicit br tag becomes a line break', /line<br>break/.test(md), md);
  check('markdown: italic with * and _', md.includes('<em>italic</em>') && md.includes('<em>also</em>'), md);
  const inertTags = renderMarkdown('<b>x</b> and <img src=x onerror=alert(1)>');
  check('markdown: other html stays escaped', !inertTags.includes('<b>') && !inertTags.includes('<img'), inertTags);

  // A question opens the turn and the reply to it closes it, so each pair is one turn.
  const turn = async body => { await call('POST', '/api/entries', { kind: 'question', rawBody: body, cleanedBody: body }); return call('POST', '/api/entries', { kind: 'report', body }); };
  const report = await turn('노이즈의 추정값을 계산합니다.');
  await call('POST', '/api/pin', { target: report.data.entry.id });
  check('notes: refused even on the pinned reply (replies are not edited in place)', (await call('POST', `/api/entries/${report.data.entry.id}/notes`, { anchor: '추정값', text: '설명' })).status === 400);

  for (let index = 0; index < 620; index += 1) await turn(`bulk ${index}`);
  const state = (await call('GET', '/api/state')).data;
  const fetchSource = html.slice(html.indexOf('async function fetchEntries('), html.indexOf('async function refresh('));
  const fetchJson = async (url, options) => { const response = await fetch(base + url, options); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(data.error); return data; };
  const fetchEntries = new Function('fetchJson', `${fetchSource}; return fetchEntries;`)(fetchJson);
  const all = await fetchEntries(null);
  check('paging: full fetch returns every entry past 1000', all.length === state.entryCount && all.at(-1).id === state.lastEntry.id, `${all.length} / ${state.entryCount}`);
  check('paging: delta fetch returns every later entry', (await fetchEntries(all[4].id)).length === state.entryCount - 5);
} finally {
  await stopServer(server, 400);
}
fs.rmSync(tmp, { recursive: true, force: true });

finish();
