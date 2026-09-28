// M0-4: content sanitizer POC (dev-plan §19).
// Allowlist cleanup of chapter XHTML before it ever reaches the reader
// iframe or Admin preview. Same rules must apply to both (前台與後台同等).
// Run: node poc/sanitize-poc.mjs
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';

const window = new JSDOM('').window;
const purify = DOMPurify(window);

// ponytail: minimal allowlist for the POC; production list per §19 review.
// Block absolute http(s)/data URLs entirely — remote resources must not
// auto-load (§19); internal refs (#fn, relative asset paths) pass.
const ALLOWED_TAGS = ['p', 'h1', 'h2', 'h3', 'em', 'strong', 'br', 'a', 'img', 'blockquote', 'aside'];
const ALLOWED_ATTR = ['href', 'src', 'id', 'class'];
const ALLOWED_URI_REGEXP = /^(?!(?:https?|data|javascript|vbscript|file):)/i;

const dirty = `<body>
<h1 id="ch1">第1章</h1>
<script>alert('xss')</script>
<p onclick="steal()">正文<em>強調</em>段落</p>
<p><a href="javascript:evil()">外部連結</a></p>
<p><a href="#fn1" id="ref1">註腳引用</a></p>
<img src="https://evil.example/x.png" onerror="alert(1)">
<iframe src="https://evil.example"></iframe>
<blockquote>引用文字</blockquote>
</body>`;

const clean = purify.sanitize(dirty, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP });
console.log('clean:\n' + clean);

// hostile content gone
assert.ok(!clean.includes('script'), 'script survived');
assert.ok(!clean.includes('onclick'), 'event handler survived');
assert.ok(!clean.includes('onerror'), 'event handler survived');
assert.ok(!clean.includes('iframe'), 'iframe survived');
assert.ok(!clean.includes('javascript:'), 'javascript: URL survived');
assert.ok(!clean.includes('evil.example'), 'external resource survived');

// content, anchors and footnotes preserved
assert.ok(clean.includes('第1章'), 'heading lost');
assert.ok(clean.includes('正文'), 'body text lost');
assert.ok(clean.includes('href="#fn1"'), 'internal footnote link lost');
assert.ok(clean.includes('id="ref1"'), 'anchor id lost');
assert.ok(clean.includes('引用文字'), 'blockquote lost');

console.log('\nsanitizer POC checks passed');
