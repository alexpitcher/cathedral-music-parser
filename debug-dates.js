#!/usr/bin/env node

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
      const date = new Date(year, monthIndex, day);
      console.log(`Parsing "${dateStr}" (${year}) -> Day: ${day}, Month: ${monthName} (${monthIndex}) -> ${date.toISOString()}`);
      return date;
    }
  }
  return null;
}

// Test the actual date range from PDF
const dateRangeLine = "31 AUGUST – 13 SEPTEMBER 2025";
const dateMatch = dateRangeLine.match(/(\d{1,2})\s+(\w+)\s+[–—-]\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);

if (dateMatch) {
  console.log('Date range match:', dateMatch);
  console.log('End day:', dateMatch[3]);
  console.log('End month:', dateMatch[4]);
  console.log('Year:', dateMatch[5]);
  
  const endDay = parseInt(dateMatch[3]);
  const endMonth = dateMatch[4].toLowerCase();
  const year = parseInt(dateMatch[5]);
  
  const endDate = parseDate(`${endDay} ${endMonth}`, year);
  console.log('Parsed end date:', endDate);
  console.log('End date ISO:', endDate.toISOString().split('T')[0]);
}

// Test current date logic
const now = new Date();
console.log('Current date:', now.toISOString());
console.log('Current date (date only):', now.toISOString().split('T')[0]);

// Test 10-minute grace period
const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
console.log('10 minutes ago:', tenMinutesAgo.toISOString());