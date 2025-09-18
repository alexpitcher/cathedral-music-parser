#!/usr/bin/env node

import Fastify from 'fastify';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const fastify = Fastify({ logger: false });

// Global state
let cachedData = {
  services: [],
  sourceUrl: '',
  pdfUrls: [],
  endDate: null,
  lastFetch: null,
  isStale: false,
  error: null
};

// Environment
const PORT = process.env.PORT || 3000;
const MUSIC_LIST_URL = process.env.MUSIC_LIST_URL || 'https://leicestercathedral.org/music-list/';
const MUSIC_LIST_PDF_PATH = process.env.MUSIC_LIST_PDF_PATH || process.env.FIXTURE_PDF_PATH || null;
const MAX_PDFS = parseInt(process.env.MAX_PDFS || '3', 10);
const MOCK_DATE = process.env.MOCK_DATE; // Format: YYYY-MM-DD or full ISO timestamp

function getMockDate() {
  if (!MOCK_DATE) return null;
  
  // If it already contains 'T', it's a full ISO timestamp
  if (MOCK_DATE.includes('T')) {
    return new Date(MOCK_DATE);
  }
  
  // Otherwise, it's just a date, append noon UTC
  return new Date(`${MOCK_DATE}T12:00:00.000Z`);
}

// Utility functions
function normalizeUnicode(text) {
  return text.normalize('NFKC')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\u00AD/g, '') // soft hyphens
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOCRArtifacts(text) {
  let t = text;
  // Join digits split by spaces (e.g., 89.2 0 -> 89.20)
  t = t.replace(/(?<=\d)\s+(?=\d)/g, '');
  // Fix Hymn s -> Hymns
  t = t.replace(/\bHymn\s+s\b/gi, 'Hymns');
  // Fix split words like V oluntary, S aviour but not musical keys (E flat, D major, etc.)
  const noJoinNext = new Set(['flat','sharp','major','minor']);
  t = t.replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (m, a, b) => noJoinNext.has(b) ? m : `${a}${b}`);
  // Normalise L’Estrange from various broken OCR forms
  t = t.replace(/L\s*[’'`-]+\s*(?:[-—]\s*)?Estrange/gi, "L’Estrange");
  // Fix Mass for — Five Voices Byrd -> Mass for Five Voices — Byrd
  t = t.replace(/^Mass\s+for\s+—\s+(.+?)\s+([A-Z][A-Za-z’'\-]+)$/, 'Mass for $1 — $2');
  // Also remove stray dash right after "Mass for" so composer formatting can re-add correctly
  t = t.replace(/\b(Mass\s+for)\s+[—–-]\s+/i, '$1 ');
  // Remove stray em-dash after preposition "of" (e.g., Accession of — King Charles III)
  t = t.replace(/\bof\s+—\s+/gi, 'of ');
  return t;
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
      // Create date at noon UTC to avoid timezone shifts
      return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
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
  const lowerNoSpace = lowerText.replace(/\s+/g, '');
  const hasOrgan = organKeywords.some(keyword => {
    const k = keyword.toLowerCase();
    return lowerText.includes(k) || lowerNoSpace.includes(k.replace(/\s+/g, ''));
  });
  const hasChoral = choralKeywords.some(keyword => {
    const k = keyword.toLowerCase();
    return lowerText.includes(k) || lowerNoSpace.includes(k.replace(/\s+/g, ''));
  });
  return hasOrgan && !hasChoral;
}

function normalizePieceTitle(text) {
  text = normalizeOCRArtifacts(text.trim());
  // If already contains an em dash, assume "Title — Composer" and leave
  if (text.includes('—')) return text;
  // Clean stray dash after "Mass for"
  text = text.replace(/(Mass\s+for)\s*[—–-]\s*/gi, '$1 ');
  // Fix cases like "A Prayer of — St Patrick Rutter" -> "A Prayer of St Patrick — Rutter"
  text = text.replace(/\bof\s+[—–-]\s+(St(?:\.?|aint)?\s+[A-Z][A-Za-z’'\-]+)\s+([A-Z][A-Za-z’'\-]+)/, 'of $1 — $2');
  // Collapse odd dash sequences like " - — " -> " — "
  text = text.replace(/\s+-\s+—\s+/g, ' — ');
  
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
  
  // Leave bare "Composer in Key" mappings for settings to higher-level formatter
  
  // Handle "Psalm NN Composer" format
  const psalmComposerMatch = text.match(/^(Psalm\s+[\d\.–\-]+)\s+([A-Z][a-zA-Z\s\.]*?)$/i);
  if (psalmComposerMatch) {
    return `${psalmComposerMatch[1].trim()} — ${psalmComposerMatch[2].trim()}`;
  }
  
  // Handle "Mass for — Five Voices Byrd" -> "Mass for Five Voices — Byrd"
  text = text.replace(/\bMass\s+for\s+—\s+([^—;]+?)\s+([A-Z][A-Za-z’'\-]+)\b/, 'Mass for $1 — $2');
  // Handle "Piece Composer" format (single space, composer may include apostrophes/hyphens)
  const spaceMatch = text.match(/^(.+?)\s+([A-Z][A-Za-z’'\-]+(?:\s+[A-Z][A-Za-z’'\-\.]+)*)\s*$/);
  if (spaceMatch && !text.match(/\d/) && spaceMatch[2].length < 30) {
    return `${spaceMatch[1].trim()} — ${spaceMatch[2].trim()}`;
  }
  
  return text;
}

function classifyPiece(text) {
  const lower = text.toLowerCase();
  
  // Organ pieces first (most specific)
  if (lower.includes('prelude') || lower.includes('postlude') || 
      lower.includes('processional') || lower.includes('voluntary') || 
      lower.includes('toccata') || lower.includes('fugue')) return 'organ';
  
  // Liturgical categories
  if (lower.includes('hymn')) return 'hymns';
  if (lower.includes('psalm')) return 'psalms';
  if (lower.includes('anthem')) return 'anthems';
  
  // Service settings (Magnificat/Nunc Dimittis, Responses, etc.)
  if (lower.includes('magnificat') || lower.includes('nunc dimittis') || 
      lower.includes('responses') || lower.includes('service')) return 'settings';
  
  // Heuristic for service settings: "Composer in Key" format 
  // This should match "Wood in E", "Stanford in G", but NOT "God be in my head"
  // Pattern: Single surname/composer name + "in" + musical key/mode
  if (/^[A-Z][a-z]+\s+in\s+[A-Z]\s*(minor|major|flat|sharp|-\s*flat|-\s*sharp)?$/i.test(text)) return 'settings';
  
  return 'anthems'; // Default for most other pieces
}

function splitPsalmSection(section) {
  // Handle "Psalms 110 Garrett , 150 Stanford" - multiple psalms with composers
  const multiPsalmMatch = section.match(/^Psalms?\s+(.+)$/i);
  if (multiPsalmMatch) {
    const content = multiPsalmMatch[1];
    
    // Split on commas and numbers to separate multiple psalms
    const parts = content.split(/,\s*/).map(p => p.trim());
    const result = [];
    
    for (const part of parts) {
      if (/^\d+/.test(part)) {
        // Starts with number - this is a new psalm
        result.push(`Psalm ${part}`);
      } else if (result.length > 0) {
        // Doesn't start with number - append to previous psalm
        const lastIndex = result.length - 1;
        result[lastIndex] += ` ${part}`;
      } else {
        // First item doesn't start with number - this is still part of the first psalm
        result.push(`Psalm ${part}`);
      }
    }
    
    return result;
  }
  
  return [section];
}

function splitMultiplePieces(line) {
  // Pattern 1: Remove service notes like "Preacher: Name" before processing
  const cleanLine = line.replace(/\s+Preacher:\s+.+$/i, '').trim();
  
  // Pattern 2: "Composer in Key Responses OtherComposer" - split service setting + responses
  const settingResponsesMatch = cleanLine.match(/^([A-Z][a-z]+\s+in\s+[A-Za-z\s\-]+?)\s+(Responses\s+.+)$/i);
  if (settingResponsesMatch) {
    const setting = settingResponsesMatch[1].trim();
    const responses = settingResponsesMatch[2].trim();
    return [setting, responses];
  }
  
  // Pattern 3: "Something Psalm(s) NN... rest" - detect psalm anywhere in line
  const psalmMatch = cleanLine.match(/^(.+?)\s+(Psalms?\s+.+)$/i);
  if (psalmMatch) {
    const beforePsalm = psalmMatch[1].trim();
    const psalmAndAfter = psalmMatch[2].trim();
    
    // Further split the psalm section if it contains multiple psalms
    const psalmPieces = splitPsalmSection(psalmAndAfter);
    
    if (beforePsalm) {
      return [beforePsalm, ...psalmPieces];
    } else {
      return psalmPieces;
    }
  }
  
  // Pattern 4: "Something Hymn(s) NN..." - detect hymn anywhere in line  
  const hymnMatch = cleanLine.match(/^(.+?)\s+(Hymns?\s+.+)$/i);
  if (hymnMatch) {
    const beforeHymn = hymnMatch[1].trim();
    const hymnAndAfter = hymnMatch[2].trim();
    
    if (beforeHymn) {
      return [beforeHymn, hymnAndAfter];
    } else {
      return [hymnAndAfter];
    }
  }
  
  // Default: return as single piece
  return [cleanLine];
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

// Discover multiple PDFs on the page and return sorted by end date (latest first)
async function discoverLatestPDFs() {
  try {
    const response = await fetch(MUSIC_LIST_URL);
    const html = await response.text();
    const $ = cheerio.load(html);

    const monthMap = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };

    const results = [];
    const seen = new Set();
    const currentYear = new Date().getFullYear();
    $('a[href*=".pdf"]').each((i, link) => {
      const href = $(link).attr('href');
      const text = $(link).text().trim();
      if (!href) return;
      const url = href.startsWith('http') ? href : `https://leicestercathedral.org${href}`;
      if (seen.has(url)) return;
      // Look for "to DD MONTH" pattern
      const match = text.match(/to\s+(\d{1,2})\s+(\w+)/i);
      if (match) {
        const day = parseInt(match[1]);
        const month = match[2].toLowerCase();
        if (monthMap[month] !== undefined) {
          const date = new Date(currentYear, monthMap[month], day);
          results.push({ url, endDate: date });
          seen.add(url);
        }
      }
    });

    results.sort((a, b) => (b.endDate?.getTime() || 0) - (a.endDate?.getTime() || 0));
    return results;
  } catch (error) {
    throw new Error(`Failed to discover PDFs: ${error.message}`);
  }
}

function dedupeServices(services) {
  const map = new Map();
  for (const svc of services) {
    if (!svc || !svc.date || !svc.time) continue;
    const dateStr = svc.date.toISOString().split('T')[0];
    const key = `${dateStr}|${svc.time}|${(svc.service || '').trim()}|${(svc.choir || '').trim()}`;
    if (!map.has(key)) {
      map.set(key, svc);
    }
  }
  return Array.from(map.values());
}

async function parsePDF(pdfUrl) {
  try {
    if (!pdfUrl || typeof pdfUrl !== 'string' || !pdfUrl.trim()) {
      throw new Error('No PDF URL provided');
    }
    const response = await fetch(pdfUrl);
    if (!response) {
      throw new Error(`Fetch returned null/undefined for URL: ${pdfUrl}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP error fetching PDF: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return await parsePDFBuffer(new Uint8Array(arrayBuffer));
  } catch (error) {
    throw new Error(`Failed to parse PDF (${pdfUrl || 'unknown'}): ${error.message}`);
  }
}

async function parsePDFBuffer(uint8)
{
  try {
    const pdf = await pdfjsLib.getDocument({
      data: uint8,
      useSystemFonts: true
    }).promise;
    
    let allLines = [];
    
    // Extract text from all pages
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Group text items by Y position (lines)
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
      
      // Sort lines by Y position (top to bottom)
      const sortedYPositions = Object.keys(lineGroups)
        .map(Number)
        .sort((a, b) => b - a); // Descending (top to bottom)
      
      for (const y of sortedYPositions) {
        // Sort items on this line by X position (left to right)
        const lineItems = lineGroups[y].sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(item => item.text).join(' ').trim();
        
        if (lineText) {
          allLines.push(normalizeOCRArtifacts(normalizeUnicode(lineText)));
        }
      }
    }
    
    const lines = allLines;
    
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
      
      // Service line (starts with 4-digit time or standard time, but not date ranges)
      const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)$/i);
      if (timeMatch && !line.includes('AUGUST') && !line.includes('SEPTEMBER') && 
          (line.includes('Eucharist') || line.includes('Evensong') || line.includes('Morning Prayer') || line.includes('Evening Prayer'))) {
        const time = parseTime(timeMatch[1]);
        const fullServiceLine = timeMatch[2].trim();
        
        // Extract choir from parentheses anywhere in the line
        const choirMatch = fullServiceLine.match(/\(([^)]+)\)/);
        const choir = choirMatch ? choirMatch[1] : '';
        
        // Service title is everything before the choir parentheses
        const serviceTitle = choirMatch 
          ? fullServiceLine.substring(0, choirMatch.index).trim()
          : fullServiceLine;
        
        // Extract any text after choir parentheses as the first piece
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
          pieces: {
            settings: [],
            anthems: [],
            psalms: [],
            hymns: [],
            organ: []
          },
          allPieces: [],
          rawLines: []
        };
        
        // Add the first piece if found
        if (firstPiece) {
          currentService.rawLines.push(firstPiece);
          const normalizedPiece = normalizePieceTitle(firstPiece);
          const category = classifyPiece(firstPiece);
          currentService.allPieces.push(normalizedPiece);
          if (category !== 'other') {
            currentService.pieces[category].push(normalizedPiece);
          }
        }
        i++;
        continue;
      }
      
      // Piece line
      if (currentService && line && !line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)/i)) {
        currentService.rawLines.push(line);
        
        // Try to split multiple pieces on one line
        const pieces = splitMultiplePieces(line);
        
        for (const piece of pieces) {
          const normalizedPiece = normalizePieceTitle(piece);
          const category = classifyPiece(piece);
          
          currentService.allPieces.push(normalizedPiece);
          if (category !== 'other') {
            currentService.pieces[category].push(normalizedPiece);
          }
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
    let pdfUrls = [];
    let endDates = [];
    let allServices = [];

    if (MUSIC_LIST_PDF_PATH) {
      const paths = MUSIC_LIST_PDF_PATH.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of paths) {
        const buf = await fs.readFile(p);
        const parsed = await parsePDFBuffer(new Uint8Array(buf));
        allServices.push(...parsed.services);
        if (parsed.endDate) endDates.push(parsed.endDate);
        pdfUrls.push(`file://${p}`);
      }
    } else {
      const discovered = await discoverLatestPDFs();
      if (!discovered || discovered.length === 0) {
        throw new Error('No PDF link found on the music list page');
      }
      for (const entry of discovered.slice(0, Math.max(1, MAX_PDFS))) {
        const parsed = await parsePDF(entry.url);
        allServices.push(...parsed.services);
        if (parsed.endDate) endDates.push(parsed.endDate);
        else if (entry.endDate) endDates.push(entry.endDate);
        pdfUrls.push(entry.url);
      }
    }

    const services = dedupeServices(allServices);
    const finalEndDate = endDates.length ? new Date(Math.max(...endDates.map(d => d.getTime()))) : null;
    const now = getMockDate() || new Date();
    const isStale = finalEndDate && now > finalEndDate;
    
    // Normalize and sort qualifying services
    const qualifying = services
      .filter(service => hasSongmen(service.choir))
      .sort((a, b) => {
        const [ah, am] = (a.time || '00:00').split(':').map(Number);
        const [bh, bm] = (b.time || '00:00').split(':').map(Number);
        const ad = new Date(a.date);
        ad.setUTCHours(ah, am, 0, 0);
        const bd = new Date(b.date);
        bd.setUTCHours(bh, bm, 0, 0);
        return ad - bd;
      });

    cachedData = {
      services: qualifying,
      sourceUrl: MUSIC_LIST_URL,
      pdfUrls,
      endDate: finalEndDate,
      lastFetch: now,
      isStale,
      error: null
    };
    
    console.log(`Data refreshed: ${cachedData.services.length} Songmen services, stale: ${isStale}`);
    if (MOCK_DATE) {
      console.log(`Using mock date/time: ${MOCK_DATE}`);
      const currentServices = getCurrentServices();
      console.log(`Current services available: ${currentServices.length}`);
    }
  } catch (error) {
    cachedData.error = error.message;
    console.error('Failed to refresh data:', error);
  }
}

function getCurrentServices() {
  if (cachedData.isStale) return [];
  
  const now = getMockDate() || new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  
  return cachedData.services.filter(service => {
    if (!service.date || !service.time) return false;
    
    const [hour, minute] = service.time.split(':').map(Number);
    const serviceDateTime = new Date(service.date);
    serviceDateTime.setUTCHours(hour, minute, 0, 0);
    
    return serviceDateTime >= tenMinutesAgo;
  }).sort((a, b) => {
    const [ah, am] = a.time.split(':').map(Number);
    const [bh, bm] = b.time.split(':').map(Number);
    const ad = new Date(a.date);
    ad.setUTCHours(ah, am, 0, 0);
    const bd = new Date(b.date);
    bd.setUTCHours(bh, bm, 0, 0);
    return ad - bd;
  });
}

function getNextService() {
  const services = getCurrentServices();
  return services.length > 0 ? services[0] : null;
}

function getCurrentWeekServices() {
  const services = getCurrentServices();
  const now = getMockDate() || new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setUTCDate(now.getUTCDate() - now.getUTCDay() + 1); // Monday
  startOfWeek.setUTCHours(0, 0, 0, 0);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6); // Sunday
  endOfWeek.setUTCHours(23, 59, 59, 999);
  
  return services.filter(service => {
    return service.date >= startOfWeek && service.date <= endOfWeek;
  });
}

function getTomorrowServices() {
  const services = getCurrentServices();
  const now = getMockDate() || new Date();
  const tomorrowStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setUTCHours(23, 59, 59, 999);
  return services.filter(svc => svc.date >= tomorrowStart && svc.date <= tomorrowEnd);
}

function getServicesOnDate(dateStr) {
  // Use upcoming services list then filter to the given calendar date (YYYY-MM-DD)
  const services = getCurrentServices();
  return services.filter(svc => svc.date.toISOString().split('T')[0] === dateStr);
}

function canonicalizeSettingPiece(pieceText, serviceTitle) {
  const lower = pieceText.toLowerCase();
  // Already explicit
  if (/(magnificat|nunc dimittis|te deum|jubilate|responses|canticles|service)/i.test(lower)) {
    return normalizePieceTitle(pieceText);
  }
  // Pattern: Composer in Key
  const m = pieceText.match(/^([A-Z][A-Za-z\.\s]+?)\s+in\s+(.+)$/);
  if (m) {
    const composer = m[1].trim().replace(/\s+/g, ' ');
    const key = m[2].trim().replace(/\s*-\s*/g, ' - ').replace(/\s*no\.\s*/i, 'no. ');
    if (/evensong|evening prayer/i.test(serviceTitle || '')) {
      return `Mag and Nunc in ${key} — ${composer}`;
    }
    if (/eucharist|mass/i.test(serviceTitle || '')) {
      return `Mass in ${key} — ${composer}`;
    }
    return `Service in ${key} — ${composer}`;
  }
  return normalizePieceTitle(pieceText);
}

function formatServiceLine(service) {
  const dateStr = service.date.toISOString().split('T')[0];
  // Order: settings/canticles; anthems (plus uncategorised); psalms; hymns. Exclude organ.
  const ordered = [];
  const settingsRaw = service.pieces.settings || [];
  const settings = settingsRaw.map(p => canonicalizeSettingPiece(p, service.service));
  const anthems = (service.pieces.anthems || []).map(normalizePieceTitle);
  const psalms = (service.pieces.psalms || []).map(normalizePieceTitle);
  const hymns = (service.pieces.hymns || []).map(normalizePieceTitle);
  const organ = new Set((service.pieces.organ || []));
  const known = new Set([...(settingsRaw || []), ...anthems, ...psalms, ...hymns, ...organ]);
  const isFeastNote = (p) => /\b(\d{3,4})\b/.test(p) && !/(psalm|hymn|anthem|magnificat|nunc dimittis|responses|canticles|service|mass|te deum|jubilate)/i.test(p);
  const others = (service.allPieces || []).filter(p => !known.has(p) && !isOrganPiece(p) && !isFeastNote(p)).map(normalizePieceTitle);
  ordered.push(...settings, ...anthems, ...others, ...psalms, ...hymns);
  const finalFix = (s) => s
    .replace(/\b(Mass\s+for)\s*[—–-]\s*/gi, '$1 ')
    .replace(/\b(of)\s*[—–-]\s*/gi, '$1 ')
    .replace(/\s{2,}/g, ' ');
  const pieces = ordered.map(finalFix).join('; ');
  
  const choir = service.choir.replace(/\band\b/gi, '&');
  return `${dateStr} ${service.time}    ${service.service}  |  ${choir}  |  ${pieces}`;
}

function piecesSummary(service) {
  // Reuse the same ordering as formatServiceLine for consistency
  const settingsRaw = service.pieces.settings || [];
  const settings = settingsRaw.map(p => canonicalizeSettingPiece(p, service.service));
  const anthems = (service.pieces.anthems || []).map(normalizePieceTitle);
  const psalms = (service.pieces.psalms || []).map(normalizePieceTitle);
  const hymns = (service.pieces.hymns || []).map(normalizePieceTitle);
  const organ = new Set((service.pieces.organ || []));
  const known = new Set([...(settingsRaw || []), ...anthems, ...psalms, ...hymns, ...organ]);
  const isFeastNote = (p) => /\b(\d{3,4})\b/.test(p) && !/(psalm|hymn|anthem|magnificat|nunc dimittis|responses|canticles|service|mass|te deum|jubilate)/i.test(p);
  const others = (service.allPieces || []).filter(p => !known.has(p) && !isOrganPiece(p) && !isFeastNote(p)).map(normalizePieceTitle);
  const ordered = [...settings, ...anthems, ...others, ...psalms, ...hymns];
  const finalFix = (s) => s
    .replace(/\b(Mass\s+for)\s*[—–-]\s*/gi, '$1 ')
    .replace(/\b(of)\s*[—–-]\s*/gi, '$1 ')
    .replace(/\s{2,}/g, ' ');
  return ordered.map(finalFix).join('; ');
}

function formatServiceHuman(service) {
  const dateStr = service.date.toISOString().split('T')[0];
  const choir = service.choir.replace(/\band\b/gi, '&');
  const settings = (service.pieces.settings || []).map(p => canonicalizeSettingPiece(p, service.service));
  const anthems = (service.pieces.anthems || []).map(normalizePieceTitle);
  const psalms = (service.pieces.psalms || []).map(normalizePieceTitle);
  const hymns = (service.pieces.hymns || []).map(normalizePieceTitle);
  const lines = [];
  if (settings.length) lines.push(`Settings: ${settings.join('; ')}`);
  if (anthems.length) lines.push(`Anthems: ${anthems.join('; ')}`);
  if (psalms.length) lines.push(`Psalms: ${psalms.join('; ')}`);
  if (hymns.length) lines.push(`Hymns: ${hymns.join('; ')}`);
  const details = lines.join('\n');
  return `${dateStr} ${service.time}  ${service.service}\nChoir: ${choir}${details ? `\n${details}` : ''}`;
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
  
  // More human-readable, multi-line layout for /songmen/next
  return formatServiceHuman(nextService);
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
    return '';
  }
  
  return weekServices.map(formatServiceHuman).join('\n\n');
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

fastify.get('/songmen/tomorrow', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');

  if (cachedData.isStale || cachedData.error) {
    return getStaleMessage();
  }

  const tomorrowServices = getTomorrowServices();
  if (tomorrowServices.length === 0) return '';
  return tomorrowServices.map(formatServiceHuman).join('\n\n');
});

fastify.get('/songmen/day', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');

  if (cachedData.isStale || cachedData.error) {
    return getStaleMessage();
  }

  const query = request.query || {};
  let targetDateStr;
  if (typeof query.date === 'string' && /\d{4}-\d{2}-\d{2}/.test(query.date)) {
    targetDateStr = query.date;
  } else {
    const now = getMockDate() || new Date();
    targetDateStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().split('T')[0];
  }

  const dayServices = getServicesOnDate(targetDateStr);
  if (dayServices.length === 0) return '';
  return dayServices.map(formatServiceHuman).join('\n\n');
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
    `pdf_urls: ${(cachedData.pdfUrls || []).join(', ')}`,
    `end_date: ${cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : 'unknown'}`,
    `last_fetch: ${cachedData.lastFetch ? cachedData.lastFetch.toISOString() : 'never'}`,
    `services_parsed: ${cachedData.services.length}`,
    `songmen_services: ${songmenCount}`,
    `stale: ${cachedData.isStale}`,
    cachedData.error ? `error: ${cachedData.error}` : ''
  ].filter(line => line).join('\n');
});

// Back-compat: /json remains as "next"
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
    pieces: {
      settings: (nextService.pieces.settings || []).map(p => canonicalizeSettingPiece(p, nextService.service)),
      anthems: (nextService.pieces.anthems || []).map(normalizePieceTitle),
      psalms: (nextService.pieces.psalms || []).map(normalizePieceTitle),
      hymns: (nextService.pieces.hymns || []).map(normalizePieceTitle),
      organ: nextService.pieces.organ || []
    },
    source: {
      music_list_url: cachedData.sourceUrl,
      end_date: cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : null,
      fetched_at: cachedData.lastFetch ? cachedData.lastFetch.toISOString() : null
    },
    stale: false
  };
});

fastify.get('/json/next', async (request, reply) => {
  // Alias of /json but explicit path
  return fastify.inject({ method: 'GET', url: '/json' }).then(r => {
    reply.headers(r.headers);
    reply.code(r.statusCode);
    return r.payload;
  });
});

fastify.get('/json/week', async (request, reply) => {
  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');

  if (cachedData.isStale || cachedData.error) {
    return {
      services: [],
      source: {
        music_list_url: cachedData.sourceUrl,
        end_date: cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : null,
        fetched_at: cachedData.lastFetch ? cachedData.lastFetch.toISOString() : null
      },
      stale: true
    };
  }

  const weekServices = getCurrentWeekServices();
  const servicesJson = weekServices.map(svc => ({
    date: svc.date.toISOString().split('T')[0],
    time: svc.time,
    service: svc.service,
    choir: svc.choir,
    pieces: {
      settings: (svc.pieces.settings || []).map(p => canonicalizeSettingPiece(p, svc.service)),
      anthems: (svc.pieces.anthems || []).map(normalizePieceTitle),
      psalms: (svc.pieces.psalms || []).map(normalizePieceTitle),
      hymns: (svc.pieces.hymns || []).map(normalizePieceTitle),
      organ: svc.pieces.organ || []
    }
  }));

  return {
    services: servicesJson,
    source: {
      music_list_url: cachedData.sourceUrl,
      end_date: cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : null,
      fetched_at: cachedData.lastFetch ? cachedData.lastFetch.toISOString() : null
    },
    stale: false
  };
});

// XML escaping utility for Cisco IP phone XML
function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ASCII sanitizer and helpers for Cisco 79xx handsets
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
  // Strip non-ASCII (keep CR/LF/TAB)
  t = t.replace(/[\u0080-\uFFFF]/g, ' ');
  // Collapse spaces and trim trailing spaces
  t = t.replace(/[\t ]{2,}/g, ' ').replace(/[ \t]+$/g, '');
  return t;
}

function shortService(title) {
  if (!title) return '';
  const m = String(title).match(/^(.*?)\s+with\s+/i);
  return m ? m[1] : String(title);
}

function firstOrEmpty(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : '';
}

function truncate32(s) {
  if (!s) return '';
  const a = asciiSanitize(s);
  return a.length <= 32 ? a : a.slice(0, 29) + '...';
}

// Cisco 79xx-friendly Next service endpoint
fastify.get('/cisco/next', async (request, reply) => {
  reply.header('Content-Type', 'text/xml; charset=US-ASCII');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');

  const title = 'Next Songmen Service';
  const prompt = 'Press Exit to close';

  try {
    if (cachedData.error) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>Error</Prompt>\n<Text>Service unavailable.</Text>\n</CiscoIPPhoneText>`;
      return xml;
    }

    if (cachedData.isStale) {
      const endStr = cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : 'unknown';
      const text = asciiSanitize(`STALE - list ended ${endStr}\nNo newer list published.`);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>${escapeXml(prompt)}</Prompt>\n<Text>${escapeXml(text)}</Text>\n</CiscoIPPhoneText>`;
      return xml;
    }

    const next = getNextService();
    if (!next) {
      const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>${escapeXml(prompt)}</Prompt>\n<Text>Service unavailable.</Text>\n</CiscoIPPhoneText>`;
      return xml;
    }

    const dateStr = next.date.toISOString().split('T')[0];
    const timeStr = next.time;
    const choir = (next.choir || '').replace(/\band\b/gi, '&');
    const firstSetting = firstOrEmpty(next.pieces?.settings || []);
    const firstAnthem = firstOrEmpty(next.pieces?.anthems || []);
    const endStr = cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '';

    const lines = [];
    lines.push(truncate32(`${dateStr} ${timeStr}`));
    lines.push(truncate32(shortService(next.service)));
    lines.push(truncate32(choir));
    if (firstSetting) lines.push(truncate32(firstSetting));
    if (firstAnthem) lines.push(truncate32(firstAnthem));
    if (endStr) lines.push(truncate32(`List to ${endStr}`));
    lines.push('More: /songmen/next');

    const text = asciiSanitize(lines.join('\n'));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>${escapeXml(prompt)}</Prompt>\n<Text>${escapeXml(text)}</Text>\n<SoftKeyItem>\n<Name>Exit</Name>\n<URL>Init:Services</URL>\n<Position>1</Position>\n</SoftKeyItem>\n</CiscoIPPhoneText>`;
    return xml;
  } catch (error) {
    const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>Error</Prompt>\n<Text>Service unavailable.</Text>\n</CiscoIPPhoneText>`;
    return xml;
  }
});

// Cisco 79xx-friendly Week list (next 5 services this week)
fastify.get('/cisco/week', async (request, reply) => {
  reply.header('Content-Type', 'text/xml; charset=US-ASCII');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');

  const title = 'This Week — Songmen';
  const prompt = 'Press Exit to close';

  try {
    if (cachedData.error) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>Error</Prompt>\n<Text>Service unavailable.</Text>\n</CiscoIPPhoneText>`;
      return xml;
    }
    if (cachedData.isStale) {
      const endStr = cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : 'unknown';
      const text = asciiSanitize(`STALE - list ended ${endStr}\nNo newer list published.`);
      const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>${escapeXml(prompt)}</Prompt>\n<Text>${escapeXml(text)}</Text>\n<SoftKeyItem>\n<Name>Exit</Name>\n<URL>Init:Services</URL>\n<Position>1</Position>\n</SoftKeyItem>\n</CiscoIPPhoneText>`;
      return xml;
    }

    const week = getCurrentWeekServices();
    const now = getMockDate() || new Date();
    const todayStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().split('T')[0];
    const tomorrowStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().split('T')[0];
    const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    const lines = [];
    for (const svc of week.slice(0, 5)) {
      const svcDateStr = svc.date.toISOString().split('T')[0];
      let label;
      if (svcDateStr === todayStr) label = 'Today';
      else if (svcDateStr === tomorrowStr) label = 'Tomorrow';
      else label = weekday[svc.date.getUTCDay()];
      const line = `${label} ${svc.time} ${shortService(svc.service)}`;
      lines.push(truncate32(line));
    }

    const text = asciiSanitize(lines.length ? lines.join('\n') : 'No upcoming services');
    const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>${escapeXml(prompt)}</Prompt>\n<Text>${escapeXml(text)}</Text>\n<SoftKeyItem>\n<Name>Exit</Name>\n<URL>Init:Services</URL>\n<Position>1</Position>\n</SoftKeyItem>\n</CiscoIPPhoneText>`;
    return xml;
  } catch (error) {
    const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CiscoIPPhoneText>\n<Title>${escapeXml(title)}</Title>\n<Prompt>Error</Prompt>\n<Text>Service unavailable.</Text>\n</CiscoIPPhoneText>`;
    return xml;
  }
});

// Cisco IP phone XML endpoints
fastify.get('/cisco/text', async (request, reply) => {
  reply.header('Content-Type', 'text/xml; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  try {
    const query = request.query || {};
    const mode = query.mode === 'next' ? 'next' : 'week';
    
    let title = 'Leicester Songmen';
    let prompt, text;
    
    if (cachedData.isStale || cachedData.error) {
      const endDateStr = cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : 'unknown';
      prompt = `STALE until ${endDateStr}`;
      text = getStaleMessage();
    } else {
      if (mode === 'next') {
        prompt = 'Next service';
        const nextService = getNextService();
        if (!nextService) {
          text = getStaleMessage();
        } else {
          text = formatServiceHuman(nextService);
        }
      } else { // week
        prompt = 'This week';
        const weekServices = getCurrentWeekServices();
        if (weekServices.length === 0) {
          text = '';
        } else {
          text = weekServices.map(formatServiceHuman).join('\n\n');
        }
      }
    }
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CiscoIPPhoneText>
<Title>${escapeXml(title)}</Title>
<Prompt>${escapeXml(prompt)}</Prompt>
<Text>${escapeXml(text)}</Text>
</CiscoIPPhoneText>`;
    
    return xml;
  } catch (error) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CiscoIPPhoneText>
<Title>Leicester Songmen</Title>
<Prompt>Error</Prompt>
<Text>Service unavailable.</Text>
</CiscoIPPhoneText>`;
    
    return xml;
  }
});

fastify.get('/cisco/menu', async (request, reply) => {
  reply.header('Content-Type', 'text/xml; charset=utf-8');
  reply.header('X-Source-End-Date', cachedData.endDate ? cachedData.endDate.toISOString().split('T')[0] : '');
  reply.header('X-Last-Fetch', cachedData.lastFetch ? cachedData.lastFetch.toISOString() : '');
  reply.header('X-Stale', cachedData.isStale ? 'true' : 'false');
  
  try {
    // Construct absolute URLs for menu items
    const protocol = request.headers['x-forwarded-proto'] || (request.socket.encrypted ? 'https' : 'http');
    const host = request.headers.host || `localhost:${PORT}`;
    const baseUrl = `${protocol}://${host}`;
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CiscoIPPhoneMenu>
<Title>Leicester Songmen</Title>
<Prompt>Select option</Prompt>
<MenuItem>
<Name>Next</Name>
<URL>/cisco/next</URL>
</MenuItem>
<MenuItem>
<Name>This Week</Name>
<URL>/cisco/week</URL>
</MenuItem>
<SoftKeyItem>
<Name>Select</Name>
<URL>SoftKey:Select</URL>
<Position>1</Position>
</SoftKeyItem>
<SoftKeyItem>
<Name>Exit</Name>
<URL>SoftKey:Exit</URL>
<Position>2</Position>
</SoftKeyItem>
</CiscoIPPhoneMenu>`;
    
    return xml;
  } catch (error) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CiscoIPPhoneText>
<Title>Leicester Songmen</Title>
<Prompt>Error</Prompt>
<Text>Service unavailable.</Text>
</CiscoIPPhoneText>`;
    
    return xml;
  }
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
