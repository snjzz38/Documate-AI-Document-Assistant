// ==========================================================================
// FILE PATH: api/_utils/doiAPI.js
// ==========================================================================

/**
 * api/_utils/doiAPI.js
 * DocuMate DOI Resolution & Citation Formatting Utility
 * 
 * Table of Contents:
 * 1. DOI Extraction Module
 * 2. Crossref Metadata Fetcher Module
 * 3. Doi.org Content Negotiation Fallback Module
 * 4. Unified URL Resolver Module
 * 5. Author Name Formatter Module
 * 6. Academic Style Generator Module
 */

// ==========================================================================
// MODULE 1: DOI Extraction
// ==========================================================================
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
                    .replace(/\?(.*)$/, '')     // Remove query parameters
                    .replace(/#(.*)$/, '');     // Remove fragment identifiers
                
                // Clean publisher-specific path prefixes (e.g. Wiley/Springer "full/10.1111/...", "abs/")
                doi = doi.replace(/^(abs|full|pdf|epdf|abstract)\//i, '');
                
                // Clean standard suffixes (e.g. ".../full", ".../pdf")
                doi = doi.replace(/\/(full|abstract|pdf)$/i, '');

                return doi;
            }
        }
        return null;
    },

// ==========================================================================
// MODULE 2: Crossref Metadata Fetcher
// ==========================================================================
    async fetchFromCrossref(doi) {
        if (!doi) return null;
        
        try {
            const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000); // Increased timeout for slower queries
            
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
            
            const authors = (work.author || []).map(a => ({
                given: a.given || '',
                family: a.family || ''
            })).filter(a => a.family);
            
            let year = 'n.d.';
            if (work.published?.['date-parts']?.[0]?.[0]) {
                year = String(work.published['date-parts'][0][0]);
            } else if (work['published-print']?.['date-parts']?.[0]?.[0]) {
                year = String(work['published-print']['date-parts'][0][0]);
            } else if (work['published-online']?.['date-parts']?.[0]?.[0]) {
                year = String(work['published-online']['date-parts'][0][0]);
            }
            
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
            console.error('[DOI] Crossref lookup bypassed:', e.message);
            return null;
        }
    },

// ==========================================================================
// MODULE 3: Doi.org Content Negotiation Fallback
// ==========================================================================
    async fetchFromDoiOrg(doi) {
        if (!doi) return null;
        
        try {
            const url = `https://doi.org/${encodeURIComponent(doi)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            
            // Standard CSL-JSON content negotiation request
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/vnd.citationstyles.csl+json',
                    'User-Agent': 'Documate/1.0 (Citation Tool; mailto:contact@example.com)'
                }
            });
            clearTimeout(timeout);
            
            if (!res.ok) return null;
            
            const work = await res.json();
            
            const authors = (work.author || []).map(a => ({
                given: a.given || '',
                family: a.family || ''
            })).filter(a => a.family);
            
            let year = 'n.d.';
            if (work.issued?.['date-parts']?.[0]?.[0]) {
                year = String(work.issued['date-parts'][0][0]);
            }
            
            const journal = work['container-title'] || work.publisher || 'Unknown Journal';
            
            return {
                doi: doi,
                title: work.title || 'Untitled',
                authors: authors,
                year: year,
                journal: journal,
                volume: work.volume || null,
                issue: work.issue || null,
                pages: work.page || null,
                type: work.type || 'article',
                url: `https://doi.org/${doi}`,
                abstract: work.abstract || null,
                isDOI: true
            };
        } catch (e) {
            console.error('[DOI] Doi.org fallback lookup failed:', e.message);
            return null;
        }
    },

// ==========================================================================
// MODULE 4: Unified URL Resolver
// ==========================================================================
    async resolve(url, snippet = '') {
        let doi = this.extractDOI(url);
        
        if (!doi && snippet) {
            doi = this.extractDOI(snippet);
        }
        
        if (!doi) return null;
        
        // Attempt Primary (Crossref) -> Fallback (Doi.org content negotiation)
        return (await this.fetchFromCrossref(doi)) || (await this.fetchFromDoiOrg(doi));
    },

// ==========================================================================
// MODULE 5: Author Name Formatter
// ==========================================================================
    formatAPAAuthors(authors) {
        if (!authors || !Array.isArray(authors) || authors.length === 0) return null;
        
        const formatted = authors.map(a => {
            const family = (a.family || '').trim();
            const given = (a.given || '').trim();
            if (!family) return '';
            
            const initials = given
                ? given.split(/[\s-]+/).map(part => `${part[0].toUpperCase()}.`).join(' ')
                : '';
            return initials ? `${family}, ${initials}` : family;
        }).filter(Boolean);

        if (formatted.length === 0) return null;
        if (formatted.length === 1) return formatted[0];
        if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
        
        if (formatted.length <= 20) {
            return formatted.slice(0, -1).join(', ') + `, & ${formatted[formatted.length - 1]}`;
        }
        return formatted.slice(0, 19).join(', ') + ', ... ' + formatted[formatted.length - 1];
    },

    formatStandardAuthors(authors, useAnd = true) {
        if (!authors || !Array.isArray(authors) || authors.length === 0) return null;
        
        const formatted = authors.map((a, i) => {
            const family = (a.family || '').trim();
            const given = (a.given || '').trim();
            if (!family) return '';
            
            if (i === 0) {
                return given ? `${family}, ${given}` : family;
            } else {
                return given ? `${given} ${family}` : family;
            }
        }).filter(Boolean);

        const amp = useAnd ? 'and' : '&';
        if (formatted.length === 0) return null;
        if (formatted.length === 1) return formatted[0];
        if (formatted.length === 2) return `${formatted[0]} ${amp} ${formatted[1]}`;
        return formatted.slice(0, -1).join(', ') + `, ${amp} ${formatted[formatted.length - 1]}`;
    },

    toTitleCase(str) {
        if (!str) return '';
        const minorWords = /^(a|an|the|and|but|or|for|nor|on|in|at|by|to|for|of|with|about|as)$/i;
        return str.split(/\s+/).map((word, index) => {
            if (index > 0 && minorWords.test(word)) return word.toLowerCase();
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }).join(' ');
    },

    cleanAuthorName(author) {
        if (!author) return null;
        const str = String(author).trim();
        const invalidPatterns = [
            /^https?:\/\//i, /facebook\.com/i, /twitter\.com/i, /^www\./i,
            /^default$/i, /^unknown$/i, /^admin$/i, /^editor$/i, /^staff$/i,
            /^contributor$/i, /^pmc\.?$/i, /^ncbi/i, /^\d+$/, /^[^a-zA-Z]*$/,
            /→|►|→|View all/i, /^doi$/i, /^n\.?d\.?$/i
        ];
        
        for (const pattern of invalidPatterns) {
            if (pattern.test(str)) return null;
        }
        if (str.length < 3 || str.length > 80) return null;
        
        let cleaned = str.replace(/^(By|Written by|Author:|Posted by)\s*/i, '').replace(/\s+/g, ' ').trim();
        return cleaned || null;
    },

    cleanSiteName(site) {
        if (!site) return 'Unknown';
        let cleaned = String(site).replace(/^www\./, '').replace(/^https?:\/\//, '')
            .replace(/\.(com|org|edu|net|gov|io|health)$/i, '').replace(/[→\-–|]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        
        if (cleaned.includes(' ') && cleaned.length > 5) {
            return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
        }

        const parts = cleaned.split(/[.\s]/);
        const meaningful = parts.find(p => p.length > 2 && !/^(www|http|https|doi)$/i.test(p));
        return meaningful ? meaningful.charAt(0).toUpperCase() + meaningful.slice(1).toLowerCase() : 'Unknown';
    },

    getYear(source) {
        const y = source.meta?.year || source.year;
        if (y && y !== 'n.d.' && /^\d{4}$/.test(String(y))) return String(y);
        if (source.meta?.published && source.meta.published !== 'n.d.') {
            const match = source.meta.published.match(/\b(19|20)\d{2}\b/);
            if (match) return match[0];
        }
        const text = (source.content || '') + (source.snippet || '');
        const contentMatch = text.match(/\b(202[0-6]|201\d|200\d)\b/);
        return contentMatch ? contentMatch[0] : 'n.d.';
    },

// ==========================================================================
// MODULE 6: Academic Style Generator
// ==========================================================================
    formatInText(source, style) {
        const s = String(style || 'chicago').toLowerCase();
        const year = this.getYear(source);
        
        let authorName = '';
        if (source.meta?.isDOI && source.meta?.authors?.length > 0) {
            const firstAuthor = source.meta.authors[0];
            authorName = firstAuthor.family || this.cleanSiteName(source.meta?.siteName || source.title);
            
            if (source.meta.authors.length === 2) {
                const secondAuthor = source.meta.authors[1];
                authorName += s.includes('apa') ? ` & ${secondAuthor.family}` : ` and ${secondAuthor.family}`;
            } else if (source.meta.authors.length > 2) {
                authorName += ' et al.';
            }
        } else {
            authorName = this.cleanAuthorName(source.meta?.author) || this.cleanSiteName(source.meta?.siteName || source.title);
        }
        
        if (s.includes('mla')) return `(${authorName})`;
        if (s.includes('apa')) return `(${authorName}, ${year})`;
        return `(${authorName} ${year})`;
    },

    formatBib(source, style) {
        const s = String(style || 'chicago').toLowerCase();
        const year = this.getYear(source);
        const site = this.cleanSiteName(source.meta?.siteName || source.title);
        const url = source.doi ? `https://doi.org/${source.doi}` : source.link;
        const title = source.title || 'Untitled';
        const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        const volume = source.meta?.volume || source.volume || null;
        const issue = source.meta?.issue || source.issue || null;
        const pages = source.meta?.pages || source.pages || null;

        let author;
        const hasDoiAuthors = !!(source.meta?.isDOI && source.meta?.authors?.length > 0);

        if (s.includes('apa')) {
            author = hasDoiAuthors
                ? this.formatAPAAuthors(source.meta.authors)
                : (this.cleanAuthorName(source.meta?.author) || site);
                
            const cleanSite = this.toTitleCase(site);
            
            let journalSpecs = '';
            if (volume) {
                journalSpecs += `, *${volume}*`;
                if (issue) journalSpecs += `(${issue})`;
            }
            if (pages) {
                journalSpecs += `, ${pages}`;
            }

            const authorPeriod = author.endsWith('.') ? '' : '.';
            return `${author}${authorPeriod} (${year}). ${title}. *${cleanSite}*${journalSpecs}. ${url}`;
        }

        if (s.includes('mla')) {
            author = hasDoiAuthors
                ? this.formatStandardAuthors(source.meta.authors, true)
                : (this.cleanAuthorName(source.meta?.author) || site);

            let containerSpecs = '';
            if (volume) containerSpecs += `, vol. ${volume}`;
            if (issue) containerSpecs += `, no. ${issue}`;
            if (pages) containerSpecs += `, pp. ${pages}`;

            const authorPeriod = author.endsWith('.') ? '' : '.';
            return `${author}${authorPeriod} "${title}." *${site}*${containerSpecs}, ${year}, ${url}.`;
        }

        author = hasDoiAuthors
            ? this.formatStandardAuthors(source.meta.authors, true)
            : (this.cleanAuthorName(source.meta?.author) || site);

        let chicagoSpecs = '';
        if (volume) {
            chicagoSpecs += ` ${volume}`;
            if (issue) chicagoSpecs += `, no. ${issue}`;
        }
        if (pages) {
            chicagoSpecs += ` (${year}): ${pages}`;
        } else {
            chicagoSpecs += ` (${year})`;
        }

        const authorPeriod = author.endsWith('.') ? '' : '.';
        return `${author}${authorPeriod} "${title}." *${site}*${chicagoSpecs}. ${url} (Accessed ${today})`;
    }
};
