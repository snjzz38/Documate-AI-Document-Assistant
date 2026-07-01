// ==========================================================================
// FILE PATH: api/_utils/sourceFinder.js
// ==========================================================================

/*
 * TABLE OF CONTENTS
 * -------------------------------------------------------
 * 1. CONFIGURATION & CONSTANTS
 * 2. CITATION FORMATTING
 *    - _formatCitation, _formatApa, _formatMla, _formatChicago
 * 3. DATA ENRICHMENT
 *    - fetchAllCitations (Merges Crossref data)
 * 4. QUERY GENERATION
 *    - _generateQueries (Dynamic topic splitting for ANY topic)
 * 5. DATA ACQUISITION
 *    - search (OpenAlex fetcher with API Key & Mailto)
 *    - _transformWork (Parses OpenAlex JSON)
 *    - _reconstructAbstract (Inverted index decoder)
 * 6. ORCHESTRATION
 *    - searchTopic (Main pipeline)
 * 7. API HANDLER
 *    - handler() (Vercel/Netlify entry point)
 */

import { DoiAPI } from './doiAPI.js';

// ════════════════════════════════════════════════════════════════════════════
// MODULE 1: CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const OPENALEX_BASE = 'https://api.openalex.org/works';
// Fallbacks if env vars are missing, but ideally these are set in .env
const DEFAULT_MAILTO = process.env.OPENALEX_MAILTO || 'research@example.com';

export const SourceFinderAPI = {

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 2: CITATION FORMATTING
    // ════════════════════════════════════════════════════════════════════════

    _formatCitation(source, style = 'apa7') {
        if (style.includes('mla')) return this._formatMla(source);
        if (style.includes('chicago')) return this._formatChicago(source);
        return this._formatApa(source);
    },

    _formatApa(source) {
        const authors = (source.authors || []).filter(a => a.family && a.family.length > 1);
        const formatAuthor = a => {
            const initials = a.given
                ? a.given.split(/[\s\-]+/).filter(Boolean).map(n => n[0].toUpperCase() + '.').join(' ')
                : '';
            return initials ? `${a.family}, ${initials}` : a.family;
        };

        let authorStr = source.author || 'Unknown';
        if (authors.length === 1) authorStr = formatAuthor(authors[0]);
        else if (authors.length === 2) authorStr = `${formatAuthor(authors[0])} & ${formatAuthor(authors[1])}`;
        else if (authors.length === 3) authorStr = `${formatAuthor(authors[0])}, ${formatAuthor(authors[1])}, & ${formatAuthor(authors[2])}`;
        else if (authors.length > 3) authorStr = `${formatAuthor(authors[0])}, et al.`;

        const year = source.year || 'n.d.';
        const title = source.title || 'Untitled';
        const journal = source.venue || '';
        const volume = source.volume ? `, ${source.volume}` : '';
        const issue = source.issue ? `(${source.issue})` : '';
        const pages = source.pages ? `, ${source.pages}` : '';
        const doi = source.doi ? `https://doi.org/${source.doi}` : (source.url || '');

        let citation = `${authorStr} (${year}). ${title}.`;
        if (journal) citation += ` ${journal}${volume}${issue}${pages}.`;
        if (doi) citation += ` ${doi}`;
        return citation.trim();
    },

    _formatMla(source) {
        const authors = (source.authors || []).filter(a => a.family && a.family.length > 1);
        const formatFirst = a => a.given ? `${a.family}, ${a.given}` : a.family;
        const formatRest = a => a.given ? `${a.given} ${a.family}` : a.family;

        let authorStr = source.author || 'Unknown';
        if (authors.length === 1) authorStr = formatFirst(authors[0]);
        else if (authors.length === 2) authorStr = `${formatFirst(authors[0])}, and ${formatRest(authors[1])}`;
        else if (authors.length >= 3) authorStr = `${formatFirst(authors[0])}, et al.`;

        const title = source.title || 'Untitled';
        const journal = source.venue || '';
        const year = source.year || 'n.d.';
        const volume = source.volume ? `vol. ${source.volume}` : '';
        const issue = source.issue ? `no. ${source.issue}` : '';
        const pages = source.pages ? `pp. ${source.pages}` : '';
        const doi = source.doi ? `https://doi.org/${source.doi}` : (source.url || '');

        let citation = `${authorStr}. "${title}."`;
        if (journal) citation += ` ${journal},`;
        const details = [volume, issue, year, pages].filter(Boolean).join(', ');
        if (details) citation += ` ${details}`;
        citation += '.';
        if (doi) citation += ` ${doi}.`;
        return citation.trim();
    },

    _formatChicago(source) {
        const authors = (source.authors || []).filter(a => a.family && a.family.length > 1);
        const formatFirst = a => a.given ? `${a.family}, ${a.given}` : a.family;
        const formatRest = a => a.given ? `${a.given} ${a.family}` : a.family;

        let authorStr = source.author || 'Unknown';
        if (authors.length === 1) authorStr = formatFirst(authors[0]);
        else if (authors.length === 2) authorStr = `${formatFirst(authors[0])}, and ${formatRest(authors[1])}`;
        else if (authors.length >= 3) authorStr = `${formatFirst(authors[0])}, et al.`;

        const title = source.title || 'Untitled';
        const journal = source.venue || '';
        const year = source.year || 'n.d.';
        const volume = source.volume || '';
        const issue = source.issue ? `no. ${source.issue}` : '';
        const pages = source.pages || '';
        const doi = source.doi ? `https://doi.org/${source.doi}` : (source.url || '');

        let citation = `${authorStr}. "${title}."`;
        if (journal) citation += ` ${journal}`;
        if (volume) citation += ` ${volume}`;
        if (issue) citation += `, ${issue}`;
        citation += ` (${year})`;
        if (pages) citation += `: ${pages}`;
        citation += '.';
        if (doi) citation += ` ${doi}.`;
        return citation.trim();
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 3: DATA ENRICHMENT
    // ════════════════════════════════════════════════════════════════════════

    async fetchAllCitations(sources, style = 'apa7') {
        if (!sources?.length) return sources;
        console.log(`[SourceFinder] Fetching ${sources.length} citations in ${style} format...`);

        const results = [];
        const batchSize = 3;

        for (let i = 0; i < sources.length; i += batchSize) {
            const batch = sources.slice(i, i + batchSize);
            const enriched = await Promise.all(batch.map(async src => {
                if (!src.doi) {
                    return { ...src, citation: SourceFinderAPI._formatCitation(src, style), citationSource: 'generated' };
                }
                
                const meta = await DoiAPI.fetchFromCrossref(src.doi);
                if (!meta) {
                    return { ...src, citation: SourceFinderAPI._formatCitation(src, style), citationSource: 'generated' };
                }

                // Merge Crossref metadata — fill gaps from OpenAlex
                let mergedAuthors = meta.authors?.length ? meta.authors : src.authors;
                mergedAuthors = mergedAuthors.filter(a => a.family && a.family.length > 1 && !/^\d+$/.test(a.family));
                if (mergedAuthors.length === 0) mergedAuthors = (src.authors || []).filter(a => a.family && a.family.length > 1);

                const enrichedSrc = {
                    ...src,
                    authors: mergedAuthors,
                    title: meta.title || src.title,
                    venue: meta.journal || src.venue,
                    year: (meta.year && meta.year !== 'n.d.') ? meta.year : src.year,
                    volume: meta.volume || null,
                    issue: meta.issue || null,
                    pages: meta.pages || null,
                };
                enrichedSrc.citation = SourceFinderAPI._formatCitation(enrichedSrc, style);
                enrichedSrc.citationSource = 'crossref';
                return enrichedSrc;
            }));
            results.push(...enriched);
            if (i + batchSize < sources.length) {
                await new Promise(r => setTimeout(r, 300)); // Rate limit avoidance
            }
        }

        const crossrefCount = results.filter(s => s.citationSource === 'crossref').length;
        console.log(`[SourceFinder] ${crossrefCount}/${results.length} enriched from Crossref`);
        return results;
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 4: QUERY GENERATION
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Dynamically generates search queries for ANY topic.
     * 1. Uses the full topic.
     * 2. Extracts core keywords (removing stop words).
     * 3. Splits long topics into halves to ensure broad coverage.
     */
    _generateQueries(topic) {
        const queries = new Set([topic]);
        const words = topic.split(/\s+/).filter(w => w.length > 2);
        
        // Common stop words to filter out for keyword-only searches
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
            'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'impact', 'effects', 'role', 'influence', 'study', 'analysis',
            'how', 'does', 'do', 'what', 'why', 'where', 'when', 'which', 'who'
        ]);
        
        const keywords = words.filter(w => !stopWords.has(w.toLowerCase()));
        
        // Add a query with just the core keywords
        if (keywords.length > 0) {
            queries.add(keywords.join(' '));
        }
        
        // If we have enough keywords, split them into two halves for broader/narrower matches
        if (keywords.length > 3) {
            const mid = Math.floor(keywords.length / 2);
            queries.add(keywords.slice(0, mid + 1).join(' '));
            queries.add(keywords.slice(mid).join(' '));
        }

        return Array.from(queries).slice(0, 4);
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 5: DATA ACQUISITION
    // ════════════════════════════════════════════════════════════════════════

    async search(query, limit = 12, openAlexKey = null) {
        if (!query || query.trim().length < 3) return [];
        
        // FALLBACK: Grab from environment if orchestrator forgot to pass it
        const key = openAlexKey || process.env.OPENALEX_API_KEY;
        const mailto = process.env.OPENALEX_MAILTO || DEFAULT_MAILTO;
        
        try {
            const cleanQuery = query.trim().toLowerCase();
            
            // Build parameters using URLSearchParams for safe encoding
            const params = new URLSearchParams({
                search: cleanQuery,
                filter: 'has_abstract:true,is_oa:true,type:article',
                'per-page': '25',
                sort: 'relevance_score:desc',
                mailto: mailto // REQUIRED for OpenAlex Polite Pool
            });
            
            // Safely append API Key if available
            if (key) {
                params.append('api_key', key);
            } else {
                console.warn('[SourceFinder] ⚠️ OPENALEX_API_KEY is MISSING!');
            }

            const url = `${OPENALEX_BASE}?${params.toString()}`;

            const response = await fetch(url, {
                headers: { 'User-Agent': `DocuMate Academic Tool (mailto:${mailto})` }
            });
            
            if (!response.ok) throw new Error(`OpenAlex returned ${response.status}`);
            const data = await response.json();
            if (!data.results?.length) return [];

            return data.results
                .map(work => SourceFinderAPI._transformWork(work))
                .filter(p => {
                    if (!p.doi) return false;
                    if (!p.abstract || p.abstract.length < 150) return false;
                    const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 3);
                    const titleLower = p.title.toLowerCase();
                    const abstractLower = p.abstract.toLowerCase();
                    const matchCount = queryWords.filter(w =>
                        titleLower.includes(w) || abstractLower.includes(w)
                    ).length;
                    return matchCount >= Math.ceil(queryWords.length / 2);
                })
                .slice(0, limit);
        } catch (e) {
            console.error('[SourceFinder] Search failed:', e.message);
            return [];
        }
    },

    _transformWork(work) {
        const abstract = SourceFinderAPI._reconstructAbstract(work.abstract_inverted_index);
        const authors = (work.authorships || []).slice(0, 5).map(a => {
            const name = a.author?.display_name || '';
            const parts = name.split(' ');
            if (parts.length >= 2) return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
            return { given: '', family: name };
        }).filter(a => a.family);

        let displayAuthor = 'Unknown';
        if (authors.length > 0) {
            displayAuthor = authors.length > 2 ? `${authors[0].family} et al.` : authors.map(a => a.family).join(' & ');
        }

        const venue = work.primary_location?.source?.display_name || work.host_venue?.display_name || '';
        const doi = work.doi ? work.doi.replace('https://doi.org/', '') : null;

        return {
            id: work.id, title: work.title || 'Untitled',
            authors, author: displayAuthor, displayName: displayAuthor,
            year: work.publication_year || 'n.d.',
            venue, citationCount: work.cited_by_count || 0,
            url: doi ? `https://doi.org/${doi}` : work.id,
            doi, abstract, text: abstract
        };
    },

    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return null;
        try {
            const words = [];
            for (const [word, positions] of Object.entries(invertedIndex)) {
                for (const pos of positions) words[pos] = word;
            }
            return words.filter(Boolean).join(' ');
        } catch (e) { return null; }
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: ORCHESTRATION
    // ════════════════════════════════════════════════════════════════════════

    async searchTopic(topic, limit = 12, citationStyle = null, openAlexKey = null) {
        const queries = SourceFinderAPI._generateQueries(topic);
        console.log('[SourceFinder] Generated queries:', queries);

        const allResults = await Promise.all(queries.map(q => SourceFinderAPI.search(q, 8, openAlexKey)));

        const seen = new Set();
        const deduplicated = [];
        for (const results of allResults) {
            for (const paper of results) {
                if (paper.doi && !seen.has(paper.doi)) {
                    seen.add(paper.doi);
                    deduplicated.push(paper);
                }
            }
        }

        const topResults = deduplicated
            .sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0))
            .slice(0, limit);

        if (citationStyle) {
            return await SourceFinderAPI.fetchAllCitations(topResults, citationStyle);
        }
        return topResults;
    }
};

// ════════════════════════════════════════════════════════════════════════════
// MODULE 7: API HANDLER
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ success: false, error: 'Missing ?q=' });
        
        // DEBUG: Verify environment variable is loaded at the handler level
        const OPENALEX_KEY = process.env.OPENALEX_API_KEY;
        console.log('[SourceFinder] Handler ENV check -> OPENALEX_API_KEY:', OPENALEX_KEY ? `EXISTS (len: ${OPENALEX_KEY.length})` : 'UNDEFINED');
        
        const results = await SourceFinderAPI.searchTopic(query, 12, null, OPENALEX_KEY);
        
        return res.status(200).json({ success: true, count: results.length, results });
    } catch (err) {
        console.error('[SourceFinder]', err);
        return res.status(500).json({ success: false, error: 'Search failed' });
    }
}
