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
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
  t = t.replace(/[\u0080-\uFFFF]/g, ' ');
  t = t.replace(/[\t ]{2,}/g, ' ').replace(/[ \t]+$/g, '');
  return t;
}

const input = 'ﬁ ﬂ “smart” ‘quotes’ – — • emdash…';
const out = asciiSanitize(input);
if (!/fi fl \"smart\" 'quotes' - - -/.test(out)) {
  console.error('ASCII sanitize failed:', out);
  process.exit(1);
}

const withCtrl = "Hello\x01World\nOK\tDone";
const outCtrl = asciiSanitize(withCtrl);
if (outCtrl != 'Hello World\nOK\tDone') {
  console.error('Control char sanitize failed:', outCtrl);
  process.exit(1);
}

console.log('asciiSanitize ok');

