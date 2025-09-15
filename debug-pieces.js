#!/usr/bin/env node

// Test the piece splitting and classification logic

function splitMultiplePieces(line) {
  console.log(`\nTesting: "${line}"`);
  
  // More comprehensive splitting logic
  
  // Pattern 1: "Something Psalm(s) NN... rest" - detect psalm anywhere in line
  const psalmMatch = line.match(/^(.+?)\s+(Psalms?\s+.+)$/i);
  if (psalmMatch) {
    const beforePsalm = psalmMatch[1].trim();
    const psalmAndAfter = psalmMatch[2].trim();
    
    console.log(`  Found psalm pattern: "${beforePsalm}" + "${psalmAndAfter}"`);
    
    // Further split the psalm section if it contains multiple psalms or other pieces
    const psalmPieces = splitPsalmSection(psalmAndAfter);
    
    if (beforePsalm) {
      return [beforePsalm, ...psalmPieces];
    } else {
      return psalmPieces;
    }
  }
  
  // Pattern 2: "Something Hymn(s) NN..." - detect hymn anywhere in line  
  const hymnMatch = line.match(/^(.+?)\s+(Hymns?\s+.+)$/i);
  if (hymnMatch) {
    const beforeHymn = hymnMatch[1].trim();
    const hymnAndAfter = hymnMatch[2].trim();
    
    console.log(`  Found hymn pattern: "${beforeHymn}" + "${hymnAndAfter}"`);
    
    if (beforeHymn) {
      return [beforeHymn, hymnAndAfter];
    } else {
      return [hymnAndAfter];
    }
  }
  
  // No splitting pattern found
  console.log(`  No splitting pattern found`);
  return [line];
}

function splitPsalmSection(section) {
  console.log(`    Splitting psalm section: "${section}"`);
  
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
    
    console.log(`    Split into: ${result.map(r => `"${r}"`).join(', ')}`);
    return result;
  }
  
  return [section];
}

function classifyPiece(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes('hymn')) return 'hymns';
  if (lower.includes('psalm')) return 'psalms';
  if (lower.includes('anthem')) return 'anthems';
  if (lower.includes('magnificat') || lower.includes('nunc dimittis') || 
      lower.includes('responses') || lower.includes('service')) return 'settings';
  
  // Heuristic for service settings like "Wood in E"
  if (/^[A-Z][A-Za-z\.\s]+\s+in\s+[A-Za-z\s\-]+$/i.test(text)) return 'settings';
  
  return 'anthems'; // Default for most other pieces
}

// Test cases from the actual data
const testLines = [
  "Crux fidelis MacDonald Psalms 110 Garrett , 150 Stanford",
  "Wood in E Psalm 135.1 – 14 Lucas", 
  "The Bells of St Martin's Paterson Psalm 119.65 – 72",
  "A Prayer of St Patrick Rutter Hymns 341, 300, 487, 505",
  "God be in my head Armtrong - Gibbs Hymn 694",
  "Give us the wings of faith Bullock Psalm 119.33 – 40 Goss , 89 – 96 Bairstow",
  "Walmisley in D minor Responses Moore",
  "Responses Lloyd",
  "Stanford in G Responses Radcliffe"
];

console.log('=== PIECE SPLITTING AND CLASSIFICATION TEST ===\n');

testLines.forEach(line => {
  const pieces = splitMultiplePieces(line);
  
  console.log(`Result pieces:`);
  pieces.forEach((piece, i) => {
    const category = classifyPiece(piece);
    console.log(`  ${i+1}. "${piece}" → ${category}`);
  });
});