import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlText } from '../src/render/html-text.js';

test('HTML text preserves inline words and separates block content', () => {
  assert.equal(
    extractHtmlText('<p>hel<strong>lo</strong>, <em>world</em>!</p><p>Next<br>line.</p>'
      + '<table><tr><td>First</td><td>Second</td></tr></table>'),
    'hello, world! Next line. First Second',
  );
});

test('HTML text skips non-visible subtrees and accepts whitespace in closing tags', () => {
  assert.equal(
    extractHtmlText('<!DOCTYPE html><!-- hidden --><SCRIPT>script text</SCRIPT >'
      + '<style>style text</style\t><template><p>template text</p></template>'
      + '<noscript><p>fallback text</p></noscript><p>Visible text</p>'
      + '<script>unclosed script text'),
    'Visible text',
  );
});

test('HTML text parses quoted attributes without treating their contents as text', () => {
  assert.equal(extractHtmlText('<p title="1 > 0">2 &lt; 3 <strong>and 4</strong></p>'), '2 < 3 and 4');
});

test('HTML text decodes entities once and preserves encoded markup as literal text', () => {
  assert.equal(
    extractHtmlText('<p>&copy; &#x1f600; &#128512; &nbsp; &amp;lt;b&amp;gt;'
      + ' &lt;script&gt;sample&lt;/script&gt; &#x110000; &unknown;</p>'),
    '© 😀 😀 &lt;b&gt; <script>sample</script> � &unknown;',
  );
});

test('summary text omits a matching leading H1 through wrappers and normalized title text', () => {
  assert.equal(
    extractHtmlText('<!-- hidden --><div><h1>Cafe\u0301 <em>&amp; News</em></h1><p>Body.</p></div>', {
      omitLeadingHeading: 'Café  & News',
    }),
    'Body.',
  );
});

test('summary text preserves unmatched, non-leading, and subsequent H1 content', () => {
  assert.equal(extractHtmlText('<h1>Other title</h1><p>Body.</p>', { omitLeadingHeading: 'Title' }), 'Other title Body.');
  assert.equal(extractHtmlText('<p>Introduction.</p><h1>Title</h1>', { omitLeadingHeading: 'Title' }), 'Introduction. Title');
  assert.equal(extractHtmlText('<h1>Title</h1><h1>Title</h1><p>Body.</p>', { omitLeadingHeading: 'Title' }), 'Title Body.');
});

test('HTML text handles deeply nested tags and long literal angle-bracket sequences', () => {
  assert.equal(extractHtmlText('<span>'.repeat(20_000) + 'Text' + '</span>'.repeat(20_000)), 'Text');
  const text = '<'.repeat(20_000);
  assert.equal(extractHtmlText(text), text);
});
