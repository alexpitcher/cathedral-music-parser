#!/usr/bin/env node

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fetch from 'node-fetch';

function normalizeUnicode(text) {
  return text.normalize('NFKC')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\u00AD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(timeStr) {
  const time = timeStr.trim().toLowerCase();
  let hour, minute;
  
  if (time.match(/^\d{4}$/)) {
    hour = parseInt(time.substring(0, 2));
    minute = parseInt(time.substring(2, 4));
  } else if (time.includes('pm') || time.includes('am')) {
    const match = time.match(/(\d{1,2})[:.]?(\d{0,2})\s*(am|pm)/);
    if (match) {
      hour = parseInt(match[1]);
      minute = parseInt(match[2] || '0');
      if (match[3] === 'pm' && hour !== 12) hour += 12;
      if (match[3] === 'am' && hour === 12) hour = 0;
    }
  } else {
    const match = time.match(/(\d{1,2})[:.]?(\d{2})/);
    if (match) {
      hour = parseInt(match[1]);
      minute = parseInt(match[2]);
    }
  }
  
  if (hour !== undefined && minute !== undefined) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  }
  return null;
}

function parseDate(dateStr, year) {
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };
  
  const match = dateStr.toLowerCase().match(/(\d{1,2})\s+(\w+)/);
  if (match) {
    const day = parseInt(match[1]);
    const monthName = match[2];
    const monthIndex = months[monthName];
    if (monthIndex !== undefined) {
      return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
    }
  }
  return null;
}

function hasSongmen(choirText) {
  if (!choirText) return false;
  return /\bsongmen\b/i.test(choirText);
}

async function debugServiceParsing() {
  try {
    console.log('=== DEBUG SERVICE PARSING ===');
    
    const response = await fetch('https://leicestercathedral.org/uploads/music-list-to-13-september.pdf');
    const arrayBuffer = await response.arrayBuffer();
    
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true
    }).promise;
    
    let allLines = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const lineGroups = {};
      for (const item of textContent.items) {
        const y = Math.round(item.transform[5]);
        if (!lineGroups[y]) {
          lineGroups[y] = [];
        }
        lineGroups[y].push({
          x: item.transform[4],
          text: item.str
        });
      }
      
      const sortedYPositions = Object.keys(lineGroups)
        .map(Number)
        .sort((a, b) => b - a);
      
      for (const y of sortedYPositions) {
        const lineItems = lineGroups[y].sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(item => item.text).join(' ').trim();
        
        if (lineText) {
          allLines.push(normalizeUnicode(lineText));
        }
      }
    }
    
    // Find all Songmen lines
    const songmenLines = allLines.filter(line => line.includes('Songmen') || line.includes('songmen'));
    console.log('1. ALL SONGMEN LINES:', songmenLines.length);
    songmenLines.forEach((line, i) => {
      console.log(`   ${i+1}. "${line}"`);
    });
    
    console.log('\n2. TESTING SERVICE DETECTION FOR EACH LINE:');
    
    songmenLines.forEach((line, i) => {
      console.log(`\n--- Testing line ${i+1}: "${line}" ---`);
      
      // Test time regex
      const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)$/i);
      console.log('   Time match:', !!timeMatch);
      if (timeMatch) {
        console.log('   Time part:', timeMatch[1]);
        console.log('   Service part:', timeMatch[2]);
        console.log('   Parsed time:', parseTime(timeMatch[1]));
      }
      
      // Test date exclusions
      const hasAugust = line.includes('AUGUST');
      const hasSeptember = line.includes('SEPTEMBER');
      console.log('   Has AUGUST:', hasAugust);
      console.log('   Has SEPTEMBER:', hasSeptember);
      
      // Test service type keywords
      const hasEucharist = line.includes('Eucharist');
      const hasEvensong = line.includes('Evensong');
      const hasMorningPrayer = line.includes('Morning Prayer');
      const hasEveningPrayer = line.includes('Evening Prayer');
      const hasServiceKeyword = hasEucharist || hasEvensong || hasMorningPrayer || hasEveningPrayer;
      
      console.log('   Has Eucharist:', hasEucharist);
      console.log('   Has Evensong:', hasEvensong);
      console.log('   Has Morning Prayer:', hasMorningPrayer);
      console.log('   Has Evening Prayer:', hasEveningPrayer);
      console.log('   Has service keyword:', hasServiceKeyword);
      
      // Overall service detection
      const wouldBeDetected = timeMatch && !hasAugust && !hasSeptember && hasServiceKeyword;
      console.log('   ✓ WOULD BE DETECTED AS SERVICE:', wouldBeDetected);
      
      if (wouldBeDetected && timeMatch) {
        const fullServiceLine = timeMatch[2].trim();
        const choirMatch = fullServiceLine.match(/\(([^)]+)\)/);
        const choir = choirMatch ? choirMatch[1] : '';
        const hasSongmenInChoir = hasSongmen(choir);
        
        console.log('   Extracted choir:', `"${choir}"`);
        console.log('   ✓ HAS SONGMEN IN CHOIR:', hasSongmenInChoir);
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugServiceParsing();