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

async function debugFullParsing() {
  try {
    console.log('=== FULL PARSING DEBUG ===');
    
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
    
    const lines = allLines;
    
    // Parse end date
    let endDate = null;
    for (const line of lines.slice(0, 10)) {
      const dateMatch = line.match(/(\d{1,2})\s+(\w+)\s+[–—-]\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (dateMatch) {
        const endDay = parseInt(dateMatch[3]);
        const endMonth = dateMatch[4].toLowerCase();
        const year = parseInt(dateMatch[5]);
        endDate = parseDate(`${endDay} ${endMonth}`, year);
        break;
      }
    }
    
    console.log('1. End date:', endDate?.toISOString().split('T')[0]);
    
    // Parse services - EXACT SAME LOGIC AS SERVER
    const services = [];
    let currentDate = null;
    let currentService = null;
    let i = 0;
    
    console.log('\n2. PARSING PROCESS:');
    
    while (i < lines.length) {
      const line = lines[i];
      
      // Day header
      const dayMatch = line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(\d{1,2})\s+(\w+)/i);
      if (dayMatch) {
        const day = parseInt(dayMatch[2]);
        const month = dayMatch[3].toLowerCase();
        const year = endDate ? endDate.getFullYear() : new Date().getFullYear();
        currentDate = parseDate(`${day} ${month}`, year);
        console.log(`   DAY HEADER: "${line}" -> ${currentDate?.toISOString().split('T')[0]}`);
        i++;
        continue;
      }
      
      // Service line
      const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)$/i);
      if (timeMatch && !line.includes('AUGUST') && !line.includes('SEPTEMBER') && 
          (line.includes('Eucharist') || line.includes('Evensong') || line.includes('Morning Prayer') || line.includes('Evening Prayer'))) {
        const time = parseTime(timeMatch[1]);
        const fullServiceLine = timeMatch[2].trim();
        
        const choirMatch = fullServiceLine.match(/\(([^)]+)\)/);
        const choir = choirMatch ? choirMatch[1] : '';
        const serviceTitle = choirMatch 
          ? fullServiceLine.substring(0, choirMatch.index).trim()
          : fullServiceLine;
        
        let firstPiece = null;
        if (choirMatch) {
          const afterChoir = fullServiceLine.substring(choirMatch.index + choirMatch[0].length).trim();
          if (afterChoir) {
            firstPiece = afterChoir;
          }
        }
        
        if (currentService) {
          services.push(currentService);
        }
        
        currentService = {
          date: currentDate,
          time: time,
          service: serviceTitle,
          choir: choir,
          pieces: { settings: [], anthems: [], psalms: [], hymns: [], organ: [] },
          rawLines: []
        };
        
        if (firstPiece) {
          currentService.rawLines.push(firstPiece);
        }
        
        const isSongmen = hasSongmen(choir);
        console.log(`   SERVICE: "${line}"`);
        console.log(`      Date: ${currentDate?.toISOString().split('T')[0]}`);
        console.log(`      Time: ${time}`);
        console.log(`      Title: "${serviceTitle}"`);
        console.log(`      Choir: "${choir}"`);
        console.log(`      First piece: "${firstPiece}"`);
        console.log(`      ✓ HAS SONGMEN: ${isSongmen}`);
        
        i++;
        continue;
      }
      
      i++;
    }
    
    if (currentService) {
      services.push(currentService);
    }
    
    console.log(`\n3. TOTAL SERVICES PARSED: ${services.length}`);
    
    const songmenServices = services.filter(service => hasSongmen(service.choir));
    console.log(`4. SONGMEN SERVICES AFTER FILTERING: ${songmenServices.length}`);
    
    songmenServices.forEach((service, i) => {
      console.log(`   ${i+1}. ${service.date?.toISOString().split('T')[0]} ${service.time} ${service.service} (${service.choir})`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugFullParsing();