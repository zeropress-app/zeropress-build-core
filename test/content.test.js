import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, DomUtils } from 'htmlparser2';
import { renderDocument, renderDocumentContent } from '@zeropress/build-core/content';

function readCode(html) {
  const tree = parseDocument(html);
  const code = DomUtils.findOne((node) => node.name === 'code', tree.children);
  assert.ok(code);
  return { node: code, text: DomUtils.textContent(code) };
}

test('the content entry renders editor code blocks with highlighting and real newlines', () => {
  const html = renderDocumentContent('<pre class="language-javascript">alert();<br>const answer = 42;<br></pre>', 'html');
  const code = readCode(html);
  assert.equal(code.text, 'alert();\nconst answer = 42;\n');
  assert.equal(code.node.attribs.class, 'language-javascript');
  assert.match(html, /hljs-keyword/);
  assert.match(html, /hljs-number/);
  assert.equal(code.node.parent.name, 'pre');
});

test('existing pre/code markup keeps identifiers and uses the code language', () => {
  const html = renderDocumentContent('<pre id="sample" class="language-css"><code id="source" class="custom lang-JS">const n = 2;<br></code></pre>', 'html');
  const code = readCode(html);
  assert.equal(code.text, 'const n = 2;\n');
  assert.deepEqual(code.node.attribs, { id: 'source', class: 'custom language-js' });
  assert.equal(code.node.parent.attribs.id, 'sample');
  assert.match(html, /hljs-keyword/);
  assert.equal(renderDocumentContent(html, 'html'), html);
});

test('escaped examples stay literal and unsafe authored elements are sanitized', () => {
  const html = renderDocumentContent('<p onclick="bad()">Before</p><pre class="language-html">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>&amp;lt;tag&amp;gt;<script>bad()</script></pre><p>After</p>', 'html');
  assert.equal(readCode(html).text, '<script>alert("x")</script>\n&lt;tag&gt;');
  const tree = parseDocument(html);
  assert.equal(DomUtils.findAll((node) => node.name === 'script', tree.children).length, 0);
  assert.match(html, /^<p>Before<\/p>/);
  assert.match(html, /<p>After<\/p>$/);
});

test('unknown languages and Mermaid remain readable code for theme enhancements', () => {
  for (const language of ['custom-example', 'mermaid', 'plaintext']) {
    const html = renderDocumentContent(`<pre class="language-${language}">a &lt; b<br>next</pre>`, 'html');
    const code = readCode(html);
    assert.equal(code.text, 'a < b\nnext');
    assert.equal(code.node.attribs.class, `language-${language}`);
    assert.equal(code.node.children.every((node) => node.type === 'text'), true);
  }
});

test('Markdown fences and embedded editor HTML share code rendering', () => {
  const fence = renderDocument('```javascript\nalert();\n```', 'markdown').html;
  const embedded = renderDocument('<pre class="language-javascript">alert();<br></pre>', 'markdown').html;
  assert.equal(readCode(fence).text, readCode(embedded).text);
  assert.match(fence, /hljs-title/);
  assert.match(embedded, /hljs-title/);
});

test('large code samples retain all text without expensive syntax highlighting', () => {
  const source = 'const answer = 42;\n'.repeat(6000);
  const html = renderDocumentContent(`<pre class="language-js">${source}</pre>`, 'html');
  const code = readCode(html);
  assert.equal(code.text, source);
  assert.equal(code.node.children.every((node) => node.type === 'text'), true);
});

test('ordinary preformatted text and plaintext documents retain their meaning', () => {
  assert.equal(renderDocumentContent('<pre>  a<br>b</pre>', 'html'), '<pre>  a<br />b</pre>');
  const html = renderDocumentContent('<pre class="language-js">alert()</pre>', 'plaintext');
  assert.match(html, /&lt;pre/);
  assert.deepEqual(renderDocument('## Heading\n\nBody', 'markdown').toc.map((item) => item.title), ['Heading']);
});
