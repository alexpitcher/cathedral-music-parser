#!/usr/bin/env node
import assert from 'node:assert';

// Inline copy of asciiSanitize logic for simple unit test
function asciiSanitize(text) {
  if (!text) return '';
  let t = String(text).normalize('NFKC')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/•/g, '-')
    .replace(/\u00AD/g, '');
  t = t.replace(/[\u0080-\uFFFF]/g, ' ');
  t = t.replace(/[\t ]{2,}/g, ' ').replace(/[ \t]+$/g, '');
  return t;
}

const input = 'ﬁ ﬂ “smart” ‘quotes’ – — • emdash…';
const out = asciiSanitize(input);
assert.ok(/fi fl "smart" 'quotes' - - -/.test(out), 'ASCII sanitize failed');
console.log('asciiSanitize ok');

