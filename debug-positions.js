#!/usr/bin/env node

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fetch from 'node-fetch';

async function debugPDFPositions() {
  try {
    const response = await fetch('https://leicestercathedral.org/uploads/music-list-to-13-september.pdf');
    const arrayBuffer = await response.arrayBuffer();
    
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true
    }).promise;
    
    console.log(`PDF has ${pdf.numPages} pages`);
    
    // Just look at first page
    const page = await pdf.getPage(1);
    const textContent = await page.getTextContent();
    
    console.log(`\nPage 1 has ${textContent.items.length} text items`);
    
    // Analyze Y positions
    const yPositions = new Set();
    textContent.items.forEach(item => {
      yPositions.add(Math.round(item.transform[5]));
    });
    
    const sortedYs = Array.from(yPositions).sort((a, b) => b - a);
    console.log(`\nFound ${sortedYs.length} unique Y positions:`);
    sortedYs.slice(0, 20).forEach(y => console.log(`Y: ${y}`));
    
    // Show first 10 text items with positions
    console.log('\n=== FIRST 10 TEXT ITEMS WITH POSITIONS ===');
    textContent.items.slice(0, 10).forEach((item, i) => {
      console.log(`${i}: "${item.str}" at (${item.transform[4].toFixed(1)}, ${item.transform[5].toFixed(1)})`);
    });
    
    // Group by Y and show some examples
    console.log('\n=== GROUPING BY Y POSITION (first few groups) ===');
    const groups = {};
    textContent.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (!groups[y]) groups[y] = [];
      groups[y].push(item);
    });
    
    let count = 0;
    for (const y of sortedYs.slice(0, 5)) {
      const items = groups[y].sort((a, b) => a.transform[4] - b.transform[4]);
      const text = items.map(item => item.str).join(' ');
      console.log(`Y ${y}: "${text}"`);
      count++;
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugPDFPositions();