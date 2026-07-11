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
    async search(query, limit = 10) {
        if (!query) return [];

        const searchQuery = SearxQueryBuilder.buildGeneralQuery(query);
        
        // Base public SearXNG instance URL (customizable via env with priv.au as fallback)
        const baseUrl = process.env.SEARX_INSTANCE_URL || 'https://priv.au';
        const url = `${baseUrl}/search?q=${encodeURIComponent(searchQuery)}&format=json&categories=general`;
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error(`SearXNG HTTP Error ${res.status}`);
            
            const data = await res.json();
            const results = data.results || [];
            
            // Map SearXNG general results into unified source schema
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
                        author: null, // Will fall back to HTML scraper if resolved later
                        year: year,
                        published: year,
                        siteName: siteName
                    }
                };
            });
        } catch (e) {
            console.error('[SearX] Search request failed:', e.message);
            return [];
        }
    }
};
