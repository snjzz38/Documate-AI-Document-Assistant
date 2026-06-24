// api/_utils/doiAPI.js
// Fetches citation metadata from DOIs using Crossref API (free, no key needed)

export const DoiAPI = {
    /**
     * Extract DOI from URL or text
     */
    extractDOI(text) {
        if (!text) return null;
        
        // Common DOI patterns
        const patterns = [
            /doi\.org\/([^\s"'<>]+)/i,
            /doi:\s*([^\s"'<>]+)/i,
            /(10\.\d{4,}\/[^\s"'<>]+)/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                // Clean up the DOI
                let doi = match[1]
                    .replace(/[.,;)}\]]+$/, '') // Remove trailing punctuation
                    .replace(/\/full$/, '')     // Remove /full suffix
                    .replace(/\/abstract$/, ''); // Remove /abstract suffix
                return doi;
            }
        }
        return null;
    },

    /**
     * Fetch metadata from Crossref API
     */
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
                journal: work['container-title']?.[0] || work.publisher || 'Unknown Journal',
                volume: work.volume || null,      // ADD
                issue: work.issue || null,        // ADD
                pages: work.page || null,         // ADD
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

    /**
     * Try to resolve a URL to DOI metadata
     */
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
