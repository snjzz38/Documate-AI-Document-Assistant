// ==========================================================================
// FILE PATH: api/_utils/searx.js
// ==========================================================================

/**
 * api/_utils/searx.js
 * DocuMate SearXNG Web Search Utility (Non-Academic Balance)
 * 
 * Table of Contents:
 * 1. SearXNG Query Builder Module
 * 2. SearXNG Client & Fetcher Module
 */

// ==========================================================================
// MODULE 1: SearXNG Query Builder
// ==========================================================================
export const SearxQueryBuilder = {
    /**
     * Clean and format query for general web searches (excluding dry academic indexes)
     */
    buildGeneralQuery(text) {
        if (!text) return 'general research';
        
        // Remove scholarly terms to reduce duplicate academic results
        const cleaned = text
            .replace(/\b(academic|scholarly|literature|scientific|journal|publication|thesis|paper)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
            
        return cleaned || 'general research';
    }
};

// ==========================================================================
// MODULE 2: SearXNG Client & Fetcher
// ==========================================================================
export const SearxAPI = {
    // Freshly synchronized pool of public instances with high uptimes
    INSTANCES: [
      "https://linxx.net",
      "https://oloke.xyz",
      "https://searxng.website",
      "https://searx.ononoki.org",
      "https://namejeff.xyz",
      "https://catboy.house",
      "https://xka.cz",
      "https://chocolatemoo53.com",
      "https://rowie.at",
      "https://tiekoetter.com"
    ],

    async search(query, limit = 10) {
        if (!query) return [];

        const searchQuery = SearxQueryBuilder.buildGeneralQuery(query);
        
        // Prioritize custom environment variable if defined, otherwise randomize our fallback pool
        const customUrl = process.env.SEARX_INSTANCE_URL;
        const instancesToTry = customUrl ? [customUrl] : [...this.INSTANCES].sort(() => Math.random() - 0.5);

        for (const baseUrl of instancesToTry) {
            // trailing /search endpoint is explicitly defined
            const url = `${baseUrl}/search?q=${encodeURIComponent(searchQuery)}&format=json&categories=general`;
            
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 4000); // 4s aggressive timeout
                
                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        // ANTI-BOT SPOOFING HEADERS: Mimics real browser navigation signatures
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1'
                    }
                });
                clearTimeout(timeout);
                
                // Handle rate limiting (429) or other request blocks gracefully
                if (res.status === 429) {
                    console.warn(`[SearX] Rate limited (429) on: ${baseUrl}. Trying next fallback...`);
                    continue;
                }
                
                if (!res.ok) {
                    console.warn(`[SearX] HTTP Error ${res.status} on: ${baseUrl}. Trying next fallback...`);
                    continue;
                }
                
                const data = await res.json();
                
                // Verify the instance supports JSON output formatting (some return 403 or empty errors)
                if (data.error || !data.results) {
                    console.warn(`[SearX] JSON format disabled or restricted on: ${baseUrl}. Trying next fallback...`);
                    continue;
                }

                const results = data.results || [];
                console.log(`[SearX] Successful search via: ${baseUrl}`);
                
                return results.slice(0, limit).map(item => {
                    let year = 'n.d.';
                    if (item.published_date) {
                        const match = item.published_date.match(/\b(20\d{2})\b/);
                        if (match) year = match[1];
                    }
                    
                    let siteName = 'Web Source';
                    try {
                        const hostname = new URL(item.url).hostname.replace('www.', '');
                        const parts = hostname.split('.');
                        siteName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
                    } catch {}

                    return {
                        title: item.title || 'Untitled Web Source',
                        link: item.url,
                        snippet: item.content || item.snippet || 'No summary available.',
                        source: 'searx',
                        meta: {
                            author: null,
                            year: year,
                            published: year,
                            siteName: siteName
                        }
                    };
                });
                
            } catch (e) {
                console.warn(`[SearX] Connection failed or timed out for ${baseUrl}:`, e.message);
                // Move to next instance in loop
            }
        }

        console.error('[SearX] All public SearXNG instances in the fallback pool failed or rate-limited.');
        return [];
    }
};
