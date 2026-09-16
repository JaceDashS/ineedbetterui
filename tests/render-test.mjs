import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui', 'ineedbetterui.mjs');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-verify-'));
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir);
const server = spawn(process.execPath, [script, '--no-broadcast'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
const base = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('server did not start: ' + buffer)), 10000);
  const onData = chunk => {
    buffer += chunk;
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\//.exec(buffer);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('exit', code => reject(new Error(`server exited ${code}: ${buffer}`)));
});

const call = async (method, url, body) => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

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

  const report = await call('POST', '/api/entries', { kind: 'report', body: '노이즈의 추정값을 계산합니다.' });
  const question = await call('POST', '/api/entries', { kind: 'question', rawBody: '원문', cleanedBody: '정리' });
  const reportId = report.data.entry.id;
  check('notes: rejected when target is not pinned', (await call('POST', `/api/entries/${reportId}/notes`, { anchor: '추정값', text: '설명' })).status === 400);
  check('notes: rejected for question', (await call('POST', `/api/entries/${question.data.entry.id}/notes`, { text: '설명' })).status === 400);
  await call('POST', '/api/pin', { target: reportId });
  const anchored = await call('POST', `/api/entries/${reportId}/notes`, { anchor: '추정값', text: '설명' });
  check('notes: pinned target accepted, anchorFound true', anchored.status === 201 && anchored.data.anchorFound === true);
  const noAnchor = await call('POST', `/api/entries/${reportId}/notes`, { text: '앵커 없음' });
  check('notes: empty anchor gives anchorFound false', noAnchor.status === 201 && noAnchor.data.anchorFound === false);

  for (let index = 0; index < 1205; index += 1) await call('POST', '/api/entries', { kind: 'report', body: `bulk ${index}` });
  const state = (await call('GET', '/api/state')).data;
  const fetchSource = html.slice(html.indexOf('async function fetchEntries('), html.indexOf('async function refresh('));
  const fetchJson = async (url, options) => { const response = await fetch(base + url, options); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(data.error); return data; };
  const fetchEntries = new Function('fetchJson', `${fetchSource}; return fetchEntries;`)(fetchJson);
  const all = await fetchEntries(null);
  check('paging: full fetch returns every entry past 1000', all.length === state.entryCount && all.at(-1).id === state.lastEntry.id, `${all.length} / ${state.entryCount}`);
  check('paging: delta fetch returns every later entry', (await fetchEntries(all[4].id)).length === state.entryCount - 5);
} finally {
  server.kill();
}
await new Promise(resolve => setTimeout(resolve, 400));
fs.rmSync(tmp, { recursive: true, force: true });

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`);
const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
