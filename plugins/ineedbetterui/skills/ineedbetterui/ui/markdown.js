const ineedbetteruiMarkdown = (() => {
  'use strict';
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  }
  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    const tokens = [];
    const hold = html => { tokens.push(html); return '\u0001' + (tokens.length - 1) + '\u0002'; };
    text = text.replace(/\x60([^\x60\n]+)\x60/g, (_, code) => hold('<code>' + code + '</code>'));
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      if (!/^(?:https?:\/\/|mailto:|\/|#)/i.test(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });
    text = text.replace(/&lt;br\s*\/?&gt;/gi, () => hold('<br>'));
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
    return text.replace(/\u0001(\d+)\u0002/g, (_, index) => tokens[Number(index)]);
  }
  function cells(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map(cell => cell.trim());
  }
  function tableSeparator(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
  const CODE_LANGUAGES = { js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', json: 'json', jsonl: 'json', py: 'py', python: 'py', sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', ps1: 'ps1', powershell: 'ps1', pwsh: 'ps1', html: 'html', xml: 'html', svg: 'html', css: 'css' };
  const CODE_KEYWORDS = {
    js: new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
    json: new Set(['true', 'false', 'null']),
    py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield'.split(' ')),
    bash: new Set('case do done echo elif else esac exit export fi for function if in local return then until while'.split(' ')),
    ps1: new Set('$false $null $true begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while'.split(' ')),
    css: new Set(['!important'])
  };
  function codeLanguageName(tag) { return CODE_LANGUAGES[String(tag || '').toLowerCase()] || ''; }
  function highlightCode(source, tag) {
    const lang = codeLanguageName(tag);
    const text = String(source ?? '');
    if (!lang) return escapeHtml(text);
    try { return tokenizeCode(text, lang); } catch { return escapeHtml(text); }
  }
  // A small single-pass tokenizer. It only separates comments, strings, keywords,
  // numbers and names; every token is escaped before it is wrapped in a span.
  function tokenizeCode(source, lang) {
    const span = (kind, value) => '<span class="tok-' + kind + '">' + escapeHtml(value) + '</span>';
    const keywords = CODE_KEYWORDS[lang] || new Set();
    const quoted = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y;
    const template = /\x60(?:\\.|[^\x60\\])*\x60?/y;
    const config = {
      js: { block: /\/\*[\s\S]*?(?:\*\/|$)/y, line: /\/\/[^\n]*/y, strings: [quoted, template], word: /[A-Za-z_$][\w$]*/y, calls: true },
      json: { strings: [quoted], word: /[A-Za-z_]\w*/y, keys: true },
      py: { line: /#[^\n]*/y, strings: [quoted], word: /[A-Za-z_]\w*/y, calls: true },
      bash: { line: /#[^\n]*/y, hashAfterSpace: true, strings: [quoted], word: /[A-Za-z_][\w-]*/y, calls: true },
      ps1: { block: /<#[\s\S]*?(?:#>|$)/y, line: /#[^\n]*/y, hashAfterSpace: true, strings: [quoted], word: /\$?[A-Za-z_][\w-]*/y, calls: true, lower: true },
      css: { block: /\/\*[\s\S]*?(?:\*\/|$)/y, strings: [quoted], word: /[@!]?-{0,2}[A-Za-z_][\w-]*/y },
      html: { strings: [quoted] }
    }[lang];
    const numberRe = lang === 'css' ? /\d+(?:\.\d+)?(?:px|em|rem|vh|vw|ms|s|%)?/y : /\d+(?:\.\d+)?/y;
    const colonAhead = /\s*:/y;
    const parenAhead = /\s*\(/y;
    const at = (re, pos) => { re.lastIndex = pos; return re.exec(source); };
    let out = '', i = 0, depth = 0, inTag = false, m;
    while (i < source.length) {
      const ch = source[i];
      if (lang === 'html') {
        if (!inTag) {
          if ((m = at(/<!--[\s\S]*?(?:-->|$)/y, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
          if ((m = at(/<(\/?)([A-Za-z][\w:.-]*)/y, i))) { out += '&lt;' + m[1] + span('keyword', m[2]); i += m[0].length; inTag = true; continue; }
        } else {
          if (ch === '>') { out += '&gt;'; i += 1; inTag = false; continue; }
          if ((m = at(quoted, i))) { out += span('string', m[0]); i += m[0].length; continue; }
          if ((m = at(/[A-Za-z_:][\w:.-]*/y, i))) { out += span('function', m[0]); i += m[0].length; continue; }
        }
        out += escapeHtml(ch); i += 1; continue;
      }
      if (config.block && (m = at(config.block, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      if (config.line && (!config.hashAfterSpace || i === 0 || /\s/.test(source[i - 1])) && (m = at(config.line, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      const str = config.strings.map(re => at(re, i)).find(Boolean);
      if (str) { const end = i + str[0].length; out += span(config.keys && at(colonAhead, end) ? 'function' : 'string', str[0]); i = end; continue; }
      if ((m = at(config.word, i))) {
        const word = m[0]; const end = i + word.length; let kind = '';
        if (keywords.has(config.lower ? word.toLowerCase() : word) || (lang === 'css' && word[0] === '@')) kind = 'keyword';
        else if (lang === 'css' && depth > 0 && at(colonAhead, end)) kind = 'function';
        else if (lang === 'ps1' && /^[A-Za-z]+-[A-Za-z]+$/.test(word)) kind = 'function';
        else if (config.calls && at(parenAhead, end)) kind = 'function';
        out += kind ? span(kind, word) : escapeHtml(word); i = end; continue;
      }
      if ((m = at(numberRe, i))) { out += span('number', m[0]); i += m[0].length; continue; }
      if (ch === '{') depth += 1; else if (ch === '}') depth = Math.max(0, depth - 1);
      out += escapeHtml(ch); i += 1;
    }
    return out;
  }
  function renderMarkdown(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    const fence = String.fromCharCode(96).repeat(3);
    const tildeFence = '~~~';
    let paragraph = [];
    let list = null;
    let code = null; let codeFence = null; let codeLanguage = '';
    const flushParagraph = () => { if (paragraph.length) { output.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>'); paragraph = []; } };
    const flushList = () => { if (list) { output.push('<' + list.type + '>' + list.items.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</' + list.type + '>'); list = null; } };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (code !== null) {
        if (line.trim() === codeFence) { const source = code.join('\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); code = null; codeFence = null; codeLanguage = ''; }
        else code.push(line);
        continue;
      }
      const opening = line.trim();
      if (opening.startsWith(fence) || opening.startsWith(tildeFence)) { flushParagraph(); flushList(); code = []; codeFence = opening.startsWith(tildeFence) ? tildeFence : fence; codeLanguage = opening.slice(3).trim().split(/\s+/)[0].toLowerCase(); continue; }
      if (index + 1 < lines.length && line.includes('|') && tableSeparator(lines[index + 1])) {
        flushParagraph(); flushList();
        const head = cells(line); index += 1; const rows = [];
        while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) { index += 1; rows.push(cells(lines[index])); }
        let table = '<div class="table-scroll"><table><thead><tr>' + head.map(cell => '<th>' + inlineMarkdown(cell) + '</th>').join('') + '</tr></thead><tbody>';
        table += rows.map(row => '<tr>' + head.map((_, cellIndex) => '<td>' + inlineMarkdown(row[cellIndex] || '') + '</td>').join('') + '</tr>').join('');
        output.push(table + '</tbody></table></div>'); continue;
      }
      // Body headings start at h4: the entry's own heading is the h3 above them.
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushParagraph(); flushList();
        const level = Math.min(6, heading[1].length + 3);
        output.push('<h' + level + ' class="md-heading">' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        continue;
      }
      const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph(); flushList();
        const quoted = [quote[1]];
        while (index + 1 < lines.length) {
          const next = /^\s{0,3}>\s?(.*)$/.exec(lines[index + 1]);
          if (!next) break;
          index += 1; quoted.push(next[1]);
        }
        while (quoted.length && !quoted[quoted.length - 1].trim()) quoted.pop();
        output.push('<blockquote>' + quoted.map(inlineMarkdown).join('<br>') + '</blockquote>');
        continue;
      }
      const unordered = /^\s*-\s+(.+)$/.exec(line);
      const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph(); const type = unordered ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push((unordered || ordered)[1]); continue;
      }
      if (!line.trim()) { flushParagraph(); flushList(); continue; }
      flushList(); paragraph.push(line);
    }
    if (code !== null) { const source = code.join('\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); }
    flushParagraph(); flushList();
    return output.join('');
  }

  return { escapeHtml, highlightCode, inlineMarkdown, renderMarkdown };
})();
