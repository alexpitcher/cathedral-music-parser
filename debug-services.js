#!/usr/bin/env node

import fetch from 'node-fetch';

async function debugServices() {
  try {
    // Test the actual server's internal data
    console.log('=== TESTING SERVER ENDPOINTS ===');
    
    const status = await fetch('http://localhost:3000/status').then(r => r.text());
    console.log('Status:', status);
    
    const raw = await fetch('http://localhost:3000/songmen/raw').then(r => r.text());
    console.log('\nRaw services:', raw || '(empty)');
    
    const next = await fetch('http://localhost:3000/songmen/next').then(r => r.text());
    console.log('\nNext service:', next);
    
    // Test with a simple date check
    const now = new Date('2025-09-11T20:54:00.000Z'); // Current environment time
    const endDate = new Date('2025-09-13T00:00:00.000Z'); // September 13
    
    console.log('\n=== DATE COMPARISON ===');
    console.log('Now:', now.toISOString());
    console.log('End date:', endDate.toISOString());
    console.log('Is now > endDate?', now > endDate);
    console.log('Should be stale?', now > endDate);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugServices();