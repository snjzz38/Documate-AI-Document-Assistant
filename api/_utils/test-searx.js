/**
 * test-searx.js
 * Standalone test script for SearXNG API integration
 * 
 * Run with: node test-searx.js
 */
import { SearxAPI } from './api/_utils/searx.js';

async function runTest() {
    const testQuery = "neurodiversity in the workplace";
    
    console.log(`[Test] Starting SearXNG search test...`);
    console.log(`[Test] Query: "${testQuery}"`);
    console.log(`[Test] Instance URL: ${process.env.SEARX_INSTANCE_URL || 'https://priv.au'}`);
    console.log(`--------------------------------------------------`);

    try {
        const start = Date.now();
        const results = await SearxAPI.search(testQuery, 5);
        const elapsed = Date.now() - start;

        console.log(`[Test] Request completed in ${elapsed}ms`);
        console.log(`[Test] Total results returned: ${results.length}`);

        if (results.length === 0) {
            console.warn(`[Test] ⚠️ Warning: Search returned 0 results. The public instance may be offline, rate-limiting requests, or blocking your IP.`);
            return;
        }

        results.forEach((item, index) => {
            console.log(`\n--- Result #${index + 1} ---`);
            console.log(`Title:   ${item.title}`);
            console.log(`Link:    ${item.link}`);
            console.log(`Snippet: ${item.snippet.substring(0, 120)}...`);
            console.log(`Site:    ${item.meta?.siteName || 'N/A'}`);
            console.log(`Year:    ${item.meta?.year || 'N/A'}`);
        });

        console.log(`\n[Test] ✅ Success! SearXNG pipeline is fully functional.`);
    } catch (error) {
        console.error(`\n[Test] ❌ Test Failed! Error encountered during runtime:`);
        console.error(error);
    }
}

runTest();
