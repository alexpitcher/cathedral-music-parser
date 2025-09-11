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

async function debugCompleteFlow() {
  try {
    console.log('=== COMPLETE DEBUG FLOW ===');
    
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
    
    console.log('1. EXTRACTED LINES:', allLines.length);
    
    // Parse end date
    let endDate = null;
    for (const line of allLines.slice(0, 10)) {
      const dateMatch = line.match(/(\d{1,2})\s+(\w+)\s+[–—-]\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (dateMatch) {
        const endDay = parseInt(dateMatch[3]);
        const endMonth = dateMatch[4].toLowerCase();
        const year = parseInt(dateMatch[5]);
        endDate = parseDate(`${endDay} ${endMonth}`, year);
        console.log('2. END DATE:', endDate.toISOString().split('T')[0]);
        break;
      }
    }
    
    // Parse services
    const services = [];
    let currentDate = null;
    let currentService = null;
    
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      
      // Day header
      const dayMatch = line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(\d{1,2})\s+(\w+)/i);
      if (dayMatch) {
        const day = parseInt(dayMatch[2]);
        const month = dayMatch[3].toLowerCase();
        const year = endDate ? endDate.getFullYear() : new Date().getFullYear();
        currentDate = parseDate(`${day} ${month}`, year);
        continue;
      }
      
      // Service line
      const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (timeMatch && !line.includes('–') && !line.includes('AUGUST') && !line.includes('SEPTEMBER')) {
        const time = parseTime(timeMatch[1]);
        const serviceTitle = timeMatch[2].trim();
        const choir = timeMatch[3] || '';
        
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
      }
    }
    
    if (currentService) {
      services.push(currentService);
    }
    
    console.log('3. TOTAL SERVICES:', services.length);
    
    // Filter Songmen services
    const songmenServices = services.filter(service => hasSongmen(service.choir));
    console.log('4. SONGMEN SERVICES:', songmenServices.length);
    
    songmenServices.forEach((service, i) => {
      console.log(`   ${i+1}. ${service.date?.toISOString().split('T')[0]} ${service.time} ${service.service} (${service.choir})`);
    });
    
    // Check current filtering
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    
    console.log('\n5. CURRENT TIME FILTERING:');
    console.log('   Now:', now.toISOString());
    console.log('   Ten minutes ago:', tenMinutesAgo.toISOString());
    
    const currentServices = songmenServices.filter(service => {
      if (!service.date || !service.time) return false;
      
      const [hour, minute] = service.time.split(':').map(Number);
      const serviceDateTime = new Date(service.date);
      serviceDateTime.setUTCHours(hour, minute, 0, 0);
      
      const isValid = serviceDateTime >= tenMinutesAgo;
      console.log(`   ${service.date.toISOString().split('T')[0]} ${service.time} -> ${serviceDateTime.toISOString()} >= ${tenMinutesAgo.toISOString()}? ${isValid}`);
      
      return isValid;
    });
    
    console.log('\n6. CURRENT SERVICES AFTER TIME FILTER:', currentServices.length);
    
    // Check staleness
    const isStale = endDate && now > endDate;
    console.log('\n7. STALENESS CHECK:');
    console.log('   End date:', endDate?.toISOString());
    console.log('   Now > end date?', isStale);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugCompleteFlow();