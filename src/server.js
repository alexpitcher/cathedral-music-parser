#!/usr/bin/env node

import Fastify from 'fastify';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const fastify = Fastify({ logger: false });

// Global state
let cachedData = {
  services: [],
  sourceUrl: '',
  pdfUrl: '',
  endDate: null,
  lastFetch: null,
  isStale: false,
  error: null
};

// Environment
const PORT = process.env.PORT || 3000;
const MUSIC_LIST_URL = process.env.MUSIC_LIST_URL || 'https://leicestercathedral.org/music-list/';

// Utility functions
function normalizeUnicode(text) {
  return text.normalize('NFKC')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\u00AD/g, '') // soft hyphens
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(timeStr) {
  const time = timeStr.trim().toLowerCase();
  let hour, minute;
  
  // Handle 4-digit format like "1030", "1530"
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
      return new Date(year, monthIndex, day);
    }
  }
  return null;
}

function isOrganPiece(text) {
  const organKeywords = [
    'voluntary', 'voluntaries', 'organ', 'prelude', 'postlude', 'toccata',
    'fugue', 'chorale', 'chaconne', 'passacaglia', 'intrada', 'march',
    'processional', 'sortie', 'offertoire', 'trumpet tune', 'rondo',
    'scherzo', 'canzona', 'ricercar'
  ];
  
  const choralKeywords = [
    'responses', 'canticles', 'magnificat', 'nunc dimittis', 'te deum',
    'jubilate', 'mass', 'psalm', 'hymn'
  ];
  
  const lowerText = text.toLowerCase();
  const hasOrgan = organKeywords.some(keyword => lowerText.includes(keyword));
  const hasChoral = choralKeywords.some(keyword => lowerText.includes(keyword));
  
  return hasOrgan && !hasChoral;
}

function normalizePieceTitle(text) {
  // Handle "Composer: Title" format
  const colonMatch = text.match(/^(.+?):\s*(.+)$/);
  if (colonMatch) {
    return `${colonMatch[2].trim()} — ${colonMatch[1].trim()}`;
  }
  
  // Handle "Title  Composer" format (multiple spaces)
  const spacesMatch = text.match(/^(.+?)\s{2,}(.+)$/);
  if (spacesMatch) {
    return `${spacesMatch[1].trim()} — ${spacesMatch[2].trim()}`;
  }
  
  // Handle service settings like "Wood in E-flat (No.2)"
  const settingMatch = text.match(/^(\w+)\s+in\s+(.+)$/i);
  if (settingMatch) {
    return `Service in ${settingMatch[2]} — ${settingMatch[1]}`;
  }
  
  return text.trim();
}

function classifyPiece(text) {
  const lower = text.toLowerCase();
  
  if (isOrganPiece(text)) return 'organ';
  if (lower.includes('hymn')) return 'hymns';
  if (lower.includes('psalm')) return 'psalms';
  if (lower.includes('anthem')) return 'anthems';
  if (lower.includes('magnificat') || lower.includes('nunc dimittis') || 
      lower.includes('canticles') || lower.includes('service') ||
      lower.includes('te deum') || lower.includes('jubilate')) return 'settings';
      
  return 'other';
}

function hasSongmen(choirText) {
  if (!choirText) return false;
  return /\bsongmen\b/i.test(choirText);
}

async function discoverLatestPDF() {
  try {
    const response = await fetch(MUSIC_LIST_URL);
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let latestPDF = null;
    let latestDate = null;
    
    $('a[href*=".pdf"]').each((i, link) => {
      const href = $(link).attr('href');
      const text = $(link).text().trim();
      
      // Look for "to DD MONTH" pattern
      const match = text.match(/to\s+(\d{1,2})\s+(\w+)/i);
      if (match) {
        const day = parseInt(match[1]);
        const month = match[2].toLowerCase();
        
        const monthMap = {
          january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
          july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
        };
        
        if (monthMap[month] !== undefined) {
          const currentYear = new Date().getFullYear();
          const date = new Date(currentYear, monthMap[month], day);
          
          if (!latestDate || date > latestDate) {
            latestDate = date;
            latestPDF = href.startsWith('http') ? href : `https://leicestercathedral.org${href}`;
          }
        }
      }
    });
    
    return { url: latestPDF, endDate: latestDate };
  } catch (error) {
    throw new Error(`Failed to discover PDF: ${error.message}`);
  }
}

async function parsePDF(pdfUrl) {
  try {
    const response = await fetch(pdfUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true
    }).promise;
    
    let fullText = '';
    
    // Extract text from all pages
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Group text items by Y position (lines)
      const lines = {};
      for (const item of textContent.items) {
        const y = Math.round(item.transform[5]);
        if (!lines[y]) {
          lines[y] = [];
        }
        lines[y].push({
          x: item.transform[4],
          text: item.str
        });
      }
      
      // Sort lines by Y position (top to bottom)
      const sortedYPositions = Object.keys(lines)
        .map(Number)
        .sort((a, b) => b - a); // Descending (top to bottom)
      
      let pageText = '';
      for (const y of sortedYPositions) {
        // Sort items on this line by X position (left to right)
        const lineItems = lines[y].sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(item => item.text).join(' ').trim();
        
        if (lineText) {
          pageText += lineText + '\n';
        }
      }
      
      fullText += pageText;
    }
    
    const text = normalizeUnicode(fullText);
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    
    // Extract date range from header
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
    
    // Parse services
    const services = [];
    let currentDate = null;
    let currentService = null;
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      
      // Day header (e.g., "SUNDAY 31 AUGUST TRINITY 11")
      const dayMatch = line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(\d{1,2})\s+(\w+)/i);
      if (dayMatch) {
        const day = parseInt(dayMatch[2]);
        const month = dayMatch[3].toLowerCase();
        const year = endDate ? endDate.getFullYear() : new Date().getFullYear();
        currentDate = parseDate(`${day} ${month}`, year);
        i++;
        continue;
      }
      
      // Service line (starts with 4-digit time or standard time)
      const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (timeMatch) {
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
          pieces: {
            settings: [],
            anthems: [],
            psalms: [],
            hymns: [],
            organ: []
          },
          rawLines: []
        };
        i++;
        continue;
      }
      
      // Piece line
      if (currentService && line && !line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)/i)) {
        currentService.rawLines.push(line);
        
        const normalizedPiece = normalizePieceTitle(line);
        const category = classifyPiece(line);
        
        if (category !== 'other') {
          currentService.pieces[category].push(normalizedPiece);
        }
      }
      
      i++;
    }
    
    if (currentService) {
      services.push(currentService);
    }
    
    return { services, endDate };
  } catch (error) {
    throw new Error(`Failed to parse PDF: ${error.message}`);
  }
}

async function refreshData() {
  try {
    const { url: pdfUrl, endDate } = await discoverLatestPDF();
    const { services, endDate: parsedEndDate } = await parsePDF(pdfUrl);
    
    const finalEndDate = parsedEndDate || endDate;
    const now = new Date();
    const isStale = finalEndDate && now > finalEndDate;
    
    cachedData = {
      services: services.filter(service => hasSongmen(service.choir)),
      sourceUrl: MUSIC_LIST_URL,
      pdfUrl,
      endDate: finalEndDate,
      lastFetch: now,
      isStale,
      error: null
    };
    
    console.log(`Data refreshed: ${cachedData.services.length} Songmen services, stale: ${isStale}`);
  } catch (error) {
    cachedData.error = error.message;
    console.error('Failed to refresh data:', error);
  }
}

function getCurrentServices() {
  if (cachedData.isStale) return [];
  
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  
  return cachedData.services.filter(service => {
    if (!service.date || !service.time) return false;
    
    const [hour, minute] = service.time.split(':').map(Number);
    const serviceDateTime = new Date(service.date);
    serviceDateTime.setHours(hour, minute, 0, 0);
    
    return serviceDateTime >= tenMinutesAgo;
  });
}

function getNextService() {
  const services = getCurrentServices();
  return services.length > 0 ? services[0] : null;
}

function getCurrentWeekServices() {
  const services = getCurrentServices();
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
  endOfWeek.setHours(23, 59, 59, 999);
  
  return services.filter(service => {
    return service.date >= startOfWeek && service.date <= endOfWeek;
  });
}

function formatServiceLine(service) {
  const dateStr = service.date.toISOString().split('T')[0];
  const pieces = [
    ...service.pieces.settings,
    ...service.pieces.anthems,
    ...service.pieces.psalms,
    ...service.pieces.hymns
  ].join('; ');
  
  const choir = service.choir.replace(/\band\b/g, '&');
  return `${dateStr} ${service.time}    ${service.service}  |  ${choir}  |  ${pieces}`;
}

function getStaleMessage() {
  if (!cachedData.endDate) return "STALE: Music list unavailable — no newer list published.";
  const endDateStr = cachedData.endDate.toISOString().split('T')[0];
  return `STALE: Music list ended ${endDateStr} — no newer list published.`;
}

// Routes
fastify.get('/songmen/next', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  if (cachedData.isStale || cachedData.error) {
    return getStaleMessage();
  }
  
  const nextService = getNextService();
  if (!nextService) {
    return getStaleMessage();
  }
  
  return formatServiceLine(nextService);
});

fastify.get('/songmen/week', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  if (cachedData.isStale || cachedData.error) {
    return getStaleMessage();
  }
  
  const weekServices = getCurrentWeekServices();
  if (weekServices.length === 0) {
    return getStaleMessage();
  }
  
  return weekServices.map(formatServiceLine).join('\n');
});

fastify.get('/songmen/raw', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  const services = getCurrentServices();
  return services.map(service => {
    const dateStr = service.date.toISOString().split('T')[0];
    const header = `${dateStr} ${service.time} ${service.service} (${service.choir})`;
    return [header, ...service.rawLines, ''].join('\n');
  }).join('\n');
});

fastify.get('/status', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  const currentServices = getCurrentServices();
  const songmenCount = currentServices.length;
  
  return [
    `source_page_url: ${cachedData.sourceUrl}`,
    `latest_pdf_url: ${cachedData.pdfUrl}`,
    `end_date: ${cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : 'unknown'}`,
    `last_fetch: ${cachedData.lastFetch ? cachedData.lastFetch.toISOString() : 'never'}`,
    `services_parsed: ${cachedData.services.length}`,
    `songmen_services: ${songmenCount}`,
    `stale: ${cachedData.isStale}`,
    cachedData.error ? `error: ${cachedData.error}` : ''
  ].filter(line => line).join('\n');
});

fastify.get('/json', async (request, reply) => {
  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  const nextService = getNextService();
  if (!nextService || cachedData.isStale || cachedData.error) {
    return {
      date: null,
      time: null,
      service: null,
      choir: null,
      pieces: null,
      source: {
        music_list_url: cachedData.sourceUrl,
        end_date: cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : null,
        fetched_at: cachedData.lastFetch ? cachedData.lastFetch.toISOString() : null
      },
      stale: true
    };
  }
  
  return {
    date: nextService.date.toISOString().split('T')[0],
    time: nextService.time,
    service: nextService.service,
    choir: nextService.choir,
    pieces: nextService.pieces,
    source: {
      music_list_url: cachedData.sourceUrl,
      end_date: cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : null,
      fetched_at: cachedData.lastFetch ? cachedData.lastFetch.toISOString() : null
    },
    stale: false
  };
});

// Start server
async function start() {
  try {
    console.log('Refreshing data on startup...');
    await refreshData();
    
    // Schedule periodic refresh every 12 hours
    setInterval(refreshData, 12 * 60 * 60 * 1000);
    
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Leicester Cathedral Songmen service running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();