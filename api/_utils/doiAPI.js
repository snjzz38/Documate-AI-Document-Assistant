// ==========================================================================
// FILE PATH: api/_utils/doiAPI.js
// ==========================================================================

/**
 * api/_utils/doiAPI.js
 * DocuMate DOI Resolution API Utility
 * 
 * Table of Contents:
 * 1. DOI Extraction Module
 * 2. Crossref Metadata Fetcher Module
 * 3. Unified URL Resolver Module
 */
// ════════════════════════════════════════════════════════════════════════════
// MODULE 1: DOI Extraction
// ════════════════════════════════════════════════════════════════════════════
export const DoiAPI = {
    extractDOI(text) {
        if (!text) return null;
        
        // Common DOI patterns
        const patterns = [
            /doi\.org\/([^\s"'<>]+)/i,
            /doi:\s*([^\s"'<>]+)/i,
            /doi\/([^\s"'<>?#]+)/i,
            /(10\.\d{4,}\/[^\s"'<>?#]+)/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                // Clean up trailing punctuation, query parameters, and hashes
                let doi = match[1]
                    .replace(/[.,;)}\]]+$/, '') // Remove trailing punctuation
                    .replace(/\?(.*)$/, '')     // Remove query parameters completely
                    .replace(/#(.*)$/, '');     // Remove fragment identifiers completely
                
                // Clean publisher-specific path prefixes (e.g., Wiley/Springer "/full/", "/abs/")
                doi = doi.replace(/^(abs|full|pdf|epdf|abstract)\//i, '');
                
                // Clean suffixes
                doi = doi.replace(/\/(full|abstract|pdf)$/i, '');

                return doi;
            }
        }
        return null;
    },

// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: Crossref Metadata Fetcher
// ════════════════════════════════════════════════════════════════════════════
    async fetchFromCrossref(doi) {
        if (!doi) return null;
        
        try {
            const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Documate/1.0 (Citation Tool; mailto:contact@example.com)'
                }
            });
            clearTimeout(timeout);
            
            if (!res.ok) return null;
            
            const data = await res.json();
            const work = data.message;
            
            if (!work) return null;
            
            // Extract authors
            const authors = (work.author || []).map(a => ({
                given: a.given || '',
                family: a.family || ''
            })).filter(a => a.family);
            
            // Extract year
            let year = 'n.d.';
            if (work.published?.['date-parts']?.[0]?.[0]) {
                year = String(work.published['date-parts'][0][0]);
            } else if (work['published-print']?.['date-parts']?.[0]?.[0]) {
                year = String(work['published-print']['date-parts'][0][0]);
            } else if (work['published-online']?.['date-parts']?.[0]?.[0]) {
                year = String(work['published-online']['date-parts'][0][0]);
            }
            
            // Extract journal/publisher
            const journal = work['container-title']?.[0] || 
                           work.publisher || 
                           'Unknown Journal';
                           
            return {
                doi: doi,
                title: work.title?.[0] || 'Untitled',
                authors: authors,
                year: year,
                journal: journal,
                volume: work.volume || null,
                issue: work.issue || null,
                pages: work.page || null,
                type: work.type || 'article',
                url: `https://doi.org/${doi}`,
                abstract: work.abstract?.replace(/<[^>]+>/g, '').substring(0, 500) || null,
                isDOI: true
            };
        } catch (e) {
            console.error('[DOI] Crossref fetch failed:', e.message);
            return null;
        }
    },

// ════════════════════════════════════════════════════════════════════════════
// MODULE 3: Unified URL Resolver
// ════════════════════════════════════════════════════════════════════════════
    
    async resolve(url, snippet = '') {
        // Try to extract DOI from URL first
        let doi = this.extractDOI(url);
        
        // If not in URL, try snippet
        if (!doi && snippet) {
            doi = this.extractDOI(snippet);
        }
        
        if (!doi) return null;
        
        return await this.fetchFromCrossref(doi);
    }
};
