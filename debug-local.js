#!/usr/bin/env node

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs/promises';

const MOCK_DATE = process.env.MOCK_DATE; // YYYY-MM-DD
const PDF_PATH = process.env.MUSIC_LIST_PDF_PATH || process.env.FIXTURE_PDF_PATH || './music-list.pdf';

function normalizeUnicode(text) {
  return text.normalize('NFKC')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\u00AD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOCRArtifacts(text) {
  let t = text;
  t = t.replace(/(?<=\d)\s+(?=\d)/g, '');
  t = t.replace(/\bHymn\s+s\b/gi, 'Hymns');
  const noJoinNext = new Set(['flat','sharp','major','minor']);
  t = t.replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (m, a, b) => noJoinNext.has(b) ? m : `${a}${b}`);
  t = t.replace(/L\s*[’'`-]+\s*(?:[-—]\s*)?Estrange/gi, "L’Estrange");
  t = t.replace(/^Mass\s+for\s+—\s+(.+?)\s+([A-Z][A-Za-z’'\-]+)$/, 'Mass for $1 — $2');
  t = t.replace(/\b(Mass\s+for)\s+[—–-]\s+/i, '$1 ');
  t = t.replace(/\bof\s+—\s+/gi, 'of ');
  return t;
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
    if (match) { hour = parseInt(match[1]); minute = parseInt(match[2]); }
  }
  if (hour !== undefined && minute !== undefined) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  }
  return null;
}

function parseDate(dateStr, year) {
  const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  const match = dateStr.toLowerCase().match(/(\d{1,2})\s+(\w+)/);
  if (match) {
    const day = parseInt(match[1]);
    const monthIndex = months[match[2]];
    if (monthIndex !== undefined) return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
  }
  return null;
}

function isOrganPiece(text) {
  const organKeywords = ['voluntary','voluntaries','organ','prelude','postlude','toccata','fugue','chorale','chaconne','passacaglia','intrada','march','processional','sortie','offertoire','trumpet tune','rondo','scherzo','canzona','ricercar'];
  const choralKeywords = ['responses','canticles','magnificat','nunc dimittis','te deum','jubilate','mass','psalm','hymn'];
  const lower = text.toLowerCase();
  const lowerNoSpace = lower.replace(/\s+/g,'');
  const hasOrgan = organKeywords.some(k => lower.includes(k) || lowerNoSpace.includes(k.replace(/\s+/g,'')));
  const hasChoral = choralKeywords.some(k => lower.includes(k) || lowerNoSpace.includes(k.replace(/\s+/g,'')));
  return hasOrgan && !hasChoral;
}

function normalizePieceTitle(text) {
  text = normalizeOCRArtifacts(text.trim());
  text = text.replace(/(Mass\s+for)\s*[—–-]\s*/gi, '$1 ');
  if (text.includes('—')) return text;
  const colonMatch = text.match(/^(.+?):\s*(.+)$/);
  if (colonMatch) return `${colonMatch[2].trim()} — ${colonMatch[1].trim()}`;
  const spacesMatch = text.match(/^(.+?)\s{2,}(.+)$/);
  if (spacesMatch) return `${spacesMatch[1].trim()} — ${spacesMatch[2].trim()}`;
  const psalmComposerMatch = text.match(/^(Psalm\s+[\d\.–\-]+)\s+([A-Z][a-zA-Z\s\.’']*?)$/i);
  if (psalmComposerMatch) return `${psalmComposerMatch[1].trim()} — ${psalmComposerMatch[2].trim()}`;
  text = text.replace(/\bMass\s+for\s+—\s+([^—;]+?)\s+([A-Z][A-Za-z’'\-]+)\b/, 'Mass for $1 — $2');
  const spaceMatch = text.match(/^(.+?)\s+([A-Z][A-Za-z’'\-]+(?:\s+[A-Z][A-Za-z’'\-\.]+)*)\s*$/);
  if (spaceMatch && !text.match(/\d/) && spaceMatch[2].length < 30) {
    return `${spaceMatch[1].trim()} — ${spaceMatch[2].trim()}`;
  }
  return text;
}

function classifyPiece(text) {
  const lower = text.toLowerCase();
  if (isOrganPiece(text)) return 'organ';
  if (lower.includes('hymn')) return 'hymns';
  if (lower.includes('psalm')) return 'psalms';
  if (lower.includes('anthem')) return 'anthems';
  if (/^[A-Z][A-Za-z\.\s]+\s+in\s+.+$/.test(text)) return 'settings';
  if (lower.includes('magnificat') || lower.includes('nunc dimittis') || lower.includes('canticles') || lower.includes('service') || lower.includes('te deum') || lower.includes('jubilate') || lower.includes('responses')) return 'settings';
  return 'other';
}

function splitMultiplePieces(line) {
  const psalmMatch = line.match(/^(.+?)\s+(Psalm\s+\d+[\w\s\-–.]*?)$/i);
  if (psalmMatch) return [psalmMatch[1].trim(), psalmMatch[2].trim()];
  const hymnMatch = line.match(/^(.+?)\s+(Hymns?\s+\d+[a-z]?(?:\s*,\s*\d+[a-z]?)*\s*)$/i);
  if (hymnMatch) return [hymnMatch[1].trim(), hymnMatch[2].trim()];
  const keywords = ['Prelude','Postlude','Voluntary','Toccata','Anthem','Magnificat','Nunc Dimittis','Responses'];
  for (const k of keywords) {
    if (line.toLowerCase().includes(k.toLowerCase()) && line.indexOf(k) > 0) {
      const idx = line.indexOf(k);
      return [line.substring(0, idx).trim(), line.substring(idx).trim()];
    }
  }
  return [line];
}

function hasSongmen(choirText) { return /\bsongmen\b/i.test(choirText || ''); }

async function parsePDFBuffer(uint8) {
  const pdf = await pdfjsLib.getDocument({ data: uint8, useSystemFonts: true }).promise;
  let allLines = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lineGroups = {};
    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]);
      (lineGroups[y] ||= []).push({ x: item.transform[4], text: item.str });
    }
    const sortedY = Object.keys(lineGroups).map(Number).sort((a,b)=>b-a);
    for (const y of sortedY) {
      const lineText = lineGroups[y].sort((a,b)=>a.x-b.x).map(it=>it.text).join(' ').trim();
      if (lineText) allLines.push(normalizeOCRArtifacts(normalizeUnicode(lineText)));
    }
  }
  let endDate = null;
  for (const line of allLines.slice(0,10)) {
    const m = line.match(/(\d{1,2})\s+(\w+)\s+[–—-]\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (m) { endDate = parseDate(`${parseInt(m[3])} ${m[4].toLowerCase()}`, parseInt(m[5])); break; }
  }
  const services = [];
  let currentDate = null; let currentService = null; let i=0;
  while (i < allLines.length) {
    const line = allLines[i];
    const dayMatch = line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(\d{1,2})\s+(\w+)/i);
    if (dayMatch) { currentDate = parseDate(`${parseInt(dayMatch[2])} ${dayMatch[3].toLowerCase()}`, endDate ? endDate.getUTCFullYear() : new Date().getUTCFullYear()); i++; continue; }
    const timeMatch = line.match(/^(\d{4}|\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?)\s+(.+?)$/i);
    if (timeMatch && !line.includes('AUGUST') && !line.includes('SEPTEMBER') && (line.includes('Eucharist') || line.includes('Evensong') || line.includes('Morning Prayer') || line.includes('Evening Prayer'))) {
      const time = parseTime(timeMatch[1]);
      const full = timeMatch[2].trim();
      const choirMatch = full.match(/\(([^)]+)\)/);
      const choir = choirMatch ? choirMatch[1] : '';
      const serviceTitle = choirMatch ? full.substring(0, choirMatch.index).trim() : full;
      let firstPiece = null; if (choirMatch) { const after = full.substring(choirMatch.index + choirMatch[0].length).trim(); if (after) firstPiece = after; }
      if (currentService) services.push(currentService);
      currentService = { date: currentDate, time, service: serviceTitle, choir, pieces: { settings: [], anthems: [], psalms: [], hymns: [], organ: [] }, allPieces: [], rawLines: [] };
      if (firstPiece) {
        currentService.rawLines.push(firstPiece);
        const norm = normalizePieceTitle(firstPiece);
        const cat = classifyPiece(firstPiece);
        currentService.allPieces.push(norm);
        if (cat !== 'other') currentService.pieces[cat].push(norm);
      }
      i++; continue;
    }
    if (currentService && line && !line.match(/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)/i)) {
      currentService.rawLines.push(line);
      for (const p of splitMultiplePieces(line)) {
        const norm = normalizePieceTitle(p);
        const cat = classifyPiece(p);
        currentService.allPieces.push(norm);
        if (cat !== 'other') currentService.pieces[cat].push(norm);
      }
    }
    i++;
  }
  if (currentService) services.push(currentService);
  return { services, endDate };
}

function canonicalizeSettingPiece(pieceText, serviceTitle) {
  const lower = pieceText.toLowerCase();
  if (/(magnificat|nunc dimittis|te deum|jubilate|responses|canticles|service)/i.test(lower)) return normalizePieceTitle(pieceText);
  const m = pieceText.match(/^([A-Z][A-Za-z\.\s]+?)\s+in\s+(.+)$/);
  if (m) {
    const composer = m[1].trim().replace(/\s+/g, ' ');
    const key = m[2].trim().replace(/\s*-\s*/g, ' - ').replace(/\s*no\.\s*/i, 'no. ');
    if (/evensong|evening prayer/i.test(serviceTitle || '')) return `Mag and Nunc in ${key} — ${composer}`;
    if (/eucharist|mass/i.test(serviceTitle || '')) return `Mass in ${key} — ${composer}`;
    return `Service in ${key} — ${composer}`;
  }
  return normalizePieceTitle(pieceText);
}

function formatServiceLine(service) {
  const dateStr = service.date.toISOString().split('T')[0];
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
  const choir = (service.choir||'').replace(/\band\b/gi, '&');
  return `${dateStr} ${service.time}    ${service.service}  |  ${choir}  |  ${ordered.map(finalFix).join('; ')}`;
}

(async () => {
  const buf = await fs.readFile(PDF_PATH);
  const { services, endDate } = await parsePDFBuffer(new Uint8Array(buf));
  let now = new Date();
  if (MOCK_DATE) {
    if (MOCK_DATE.includes('T')) {
      const d = new Date(MOCK_DATE);
      if (!isNaN(d)) now = d;
    } else {
      now = new Date(`${MOCK_DATE}T12:00:00.000Z`);
    }
  }
  const stale = endDate && now > endDate;
  const songmen = services.filter(s => hasSongmen(s.choir));
  const upcoming = songmen.filter(s => {
    if (!s.date || !s.time) return false;
    const [h,m] = s.time.split(':').map(Number);
    const dt = new Date(s.date); dt.setUTCHours(h,m,0,0);
    return dt >= new Date(now.getTime() - 10*60*1000);
  }).sort((a,b)=>{
    const [ah,am] = a.time.split(':').map(Number); const [bh,bm] = b.time.split(':').map(Number);
    const ad = new Date(a.date); ad.setUTCHours(ah,am,0,0); const bd = new Date(b.date); bd.setUTCHours(bh,bm,0,0);
    return ad - bd;
  });
  console.log('STALE:', stale, 'End:', endDate?.toISOString().split('T')[0]);
  if (upcoming[0]) console.log('NEXT:', formatServiceLine(upcoming[0]));

  // Week lines (current ISO week Mon–Sun)
  const startOfWeek = new Date(now); startOfWeek.setUTCDate(now.getUTCDate() - now.getUTCDay() + 1); startOfWeek.setUTCHours(0,0,0,0);
  const endOfWeek = new Date(startOfWeek); endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6); endOfWeek.setUTCHours(23,59,59,999);
  const inWeek = upcoming.filter(s => s.date >= startOfWeek && s.date <= endOfWeek);
  console.log('WEEK COUNT:', inWeek.length);
  inWeek.forEach(s => console.log('WEEK:', formatServiceLine(s)));

  // JSON for next
  if (upcoming[0]) {
    const ns = upcoming[0];
    const json = {
      date: ns.date.toISOString().split('T')[0],
      time: ns.time,
      service: ns.service,
      choir: ns.choir,
      pieces: {
        settings: (ns.pieces.settings||[]).map(p=>canonicalizeSettingPiece(p, ns.service)),
        anthems: ns.pieces.anthems||[],
        psalms: ns.pieces.psalms||[],
        hymns: ns.pieces.hymns||[],
        organ: ns.pieces.organ||[]
      },
      source: {
        music_list_url: 'fixture',
        end_date: endDate?.toISOString().split('T')[0] || null,
        fetched_at: now.toISOString()
      },
      stale: !!stale
    };
    console.log('JSON:', JSON.stringify(json, null, 2));
  }
})();
