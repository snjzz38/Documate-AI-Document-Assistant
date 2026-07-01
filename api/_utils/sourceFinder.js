// ==========================================================================
// FILE PATH: api/_utils/sourceFinder.js
// ==========================================================================

/*
 * TABLE OF CONTENTS
 * -------------------------------------------------------
 * 1. CONFIGURATION & CONSTANTS
 * 2. CORE INTERFACE
 * 3. STAGE 1: TOPIC ANALYSIS (Groq)
 * 4. STAGE 2: QUERY GENERATION (Fallback)
 * 5. STAGE 3: DATA ACQUISITION (OpenAlex + API Key)
 * 6. STAGE 4: SCORING & DEDUPLICATION
 * 7. STAGE 5: AI RELEVANCE FILTERING (Groq)
 * 8. DATA ENRICHMENT (Crossref Integration)
 * 9. CITATION FORMATTING (APA, MLA, Chicago)
 * 10. UTILITIES & HELPERS
 * 11. API HANDLER
 */

import { GroqAPI } from './groqAPI.js';
import { DoiAPI } from './doiAPI.js';

// ════════════════════════════════════════════════════════════════════════════
// MODULE 1: CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const OPENALEX_BASE = 'https://api.openalex.org/works';
const DEFAULT_MAILTO = process.env.OPENALEX_MAILTO || 'research@example.com';

const BANNED_DOMAINS = [
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    'amazon', 'ebay', 'etsy', 'alibaba',
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
    'wikipedia.org', 'britannica.com', 'wikihow.com', 'investopedia.com'
];

const MINIMUM_RESULTS = 8;


// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: CORE INTERFACE
// ════════════════════════════════════════════════════════════════════════════

export const SourceFinderAPI = {

    async searchTopic(topic, limit = 12, citationStyle = null, openAlexKey = null, groqKey = null) {
        const stats = SourceFinderAPI._createStats();
        stats.startedAt = Date.now();

        // Stage 1: Analyze Topic (If Groq key provided)
        let brief = null;
        if (groqKey) {
            brief = await SourceFinderAPI._analyzeTopic(topic, groqKey, stats);
        }

        // Stage 2: Generate Queries
        const queries = brief ? brief.queries : [SourceFinderAPI._buildFallbackQuery(topic)];
        stats.queriesGenerated = queries.length;

        // Stage 3: Fetch from OpenAlex
        const openAlexResults = await SourceFinderAPI._searchOpenAlex(queries, stats, openAlexKey);
        stats.results.raw = openAlexResults.length;

        // Stage 4: Score and Deduplicate
        const scoredResults = SourceFinderAPI._filterAndScore(openAlexResults, brief);
        stats.results.afterScoring = scoredResults.length;

        // Stage 5: AI Relevance Filter
        const relevantResults = await SourceFinderAPI._filterByRelevance(scoredResults, topic, groqKey, brief, stats);
        stats.results.afterFilter = relevantResults.length;

        // Finalize Stats
        stats.finishedAt = Date.now();
        stats.elapsedMs = stats.finishedAt - stats.startedAt;

        if (citationStyle) {
            return await SourceFinderAPI.fetchAllCitations(relevantResults, citationStyle);
        }
        return relevantResults;
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 3: STAGE 1 - TOPIC ANALYSIS
    // ════════════════════════════════════════════════════════════════════════

    async _analyzeTopic(text, groqKey, stats) {
        const stage = stats.stages.topicAnalysis;
        stage.calls += 1;
        stats.totals.groqCalls += 1;
        const start = Date.now();

        try {
            const prompt = `You are analyzing a research topic to prepare a "search brief" for finding academic sources.

TOPIC:
"${text.substring(0, 1500)}"

TASK: Return a JSON object:
{
  "central_question": "the specific question this topic seeks to answer",
  "discipline": "the academic discipline (e.g., 'genetic engineering ethics', 'CRISPR biology')",
  "must_engage_with": ["3-6 short PHRASES that capture the core claims"],
  "exclude_fields": ["3-5 fields that share keywords but should be STRICTLY EXCLUDED (e.g., 'AI algorithmic fairness', 'business ethics')"],
  "queries": [
    "5-8 NATURAL SEARCH PHRASES of 4-8 words each",
    "each phrase must read like a coherent description of a specific claim",
    "phrases should be the kind of text likely to appear in an academic paper TITLE or ABSTRACT"
  ]
}

CRITICAL RULES:
1. ALWAYS return PHRASES, not keyword lists.
2. Each phrase must SELF-CONTEXTUALIZE to prevent topic drift (e.g., use "CRISPR germline editing" not just "ethics").
3. Each phrase must be 4-8 words.

Return ONLY the raw JSON object, no markdown.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            brief.queries = brief.queries
                .filter(q => typeof q === 'string')
                .map(q => q.trim().substring(0, 150))
                .filter(q => { const wc = q.split(/\s+/).length; return wc >= 4 && wc <= 8; })
                .slice(0, 8);

            if (brief.queries.length === 0) throw new Error('No valid queries');
            return brief;

        } catch (e) {
            stage.ms = Date.now() - start;
            stage.failures += 1;
            console.error('[SourceFinder] _analyzeTopic failed:', e.message);
            return null;
        }
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 4: STAGE 2 - QUERY GENERATION
    // ════════════════════════════════════════════════════════════════════════

    _buildFallbackQuery(text) {
        const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        const meaningful = [...new Set(words)].slice(0, 4);
        return (meaningful.join(' ') || 'academic research') + ' academic study';
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 5: STAGE 3 - DATA ACQUISITION
    // ════════════════════════════════════════════════════════════════════════

    async _searchOpenAlex(queries, stats, openAlexKey) {
        const allResults = [];
        const stage = stats.stages.openalex;
        const key = openAlexKey || process.env.OPENALEX_API_KEY;
        const mailto = process.env.OPENALEX_MAILTO || DEFAULT_MAILTO;

        await Promise.all(queries.map(async (query) => {
            const start = Date.now();
            stage.calls += 1;
            stats.totals.httpRequests += 1;
            try {
                const params = new URLSearchParams({
                    search: query,
                    filter: 'is_oa:true,has_abstract:true,type:article',
                    'per-page': '15',
                    mailto: mailto
                });
                
                if (key) params.append('api_key', key);

                const url = `${OPENALEX_BASE}?${params.toString()}`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);

                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeout);

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                stage.ms += Date.now() - start;

                for (const work of (data.results || [])) {
                    const doi = work.doi ? work.doi.replace('https://doi.org/', '') : null;
                    const link = doi ? `https://doi.org/${doi}` : work.id;
                    const abstract = SourceFinderAPI._reconstructAbstract(work.abstract_inverted_index);
                    const authors = (work.authorships || []).slice(0, 5).map(a => {
                        const name = a.author?.display_name || '';
                        const parts = name.split(' ');
                        if (parts.length >= 2) return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
                        return { given: '', family: name };
                    }).filter(a => a.family);

                    if (!work.title || !link) continue;
                    if (!authors.length && !work.publication_year) continue;

                    allResults.push({
                        id: work.id,
                        title: work.title,
                        link,
                        snippet: abstract || '',
                        authors,
                        author: authors.length > 2 ? `${authors[0].family} et al.` : authors.map(a => a.family).join(' & '),
                        year: work.publication_year,
                        venue: work.primary_location?.source?.display_name || '',
                        citationCount: work.cited_by_count || 0,
                        doi,
                        abstract,
                        source: 'openalex',
                        _score: 10
                    });
                }
                stage.resultsReturned += (data.results || []).length;
            } catch (e) {
                stage.ms += Date.now() - start;
                stage.failures += 1;
                console.error('[SourceFinder] OpenAlex failed:', e.message);
            }
        }));

        return allResults;
    },

    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 400);
    },


    // ════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - SCORING & DEDUPLICATION
    // ════════════════════════════════════════════════════════════

    _filterAndScore(results, brief) {
        brief = brief || {}; // FIX: Coerce null to empty object if arguments are passed out of order
        
        const seenUrls = new Set();
        const seenTitles = new Set();
        const excludeFields = (brief.exclude_fields || []).map(f => f.toLowerCase());

        return results
            .filter(r => {
                if (!r.title || !r.link) return false;
                const lowerUrl = r.link.toLowerCase();
                const lowerTitle = r.title.toLowerCase();

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (BANNED_DOMAINS.some(b => domain.includes(b))) return false;

                    // Dynamic field exclusion
                    if (excludeFields.length > 0) {
                        const paperContext = `${r.title} ${r.venue}`.toLowerCase();
                        for (const exclude of excludeFields) {
                            if (paperContext.includes(exclude)) return false;
                        }
                    }

                    const normalizedTitle = lowerTitle.substring(0, 60).trim();
                    if (seenTitles.has(normalizedTitle)) return false;
                    seenTitles.add(normalizedTitle);

                    if (seenUrls.has(lowerUrl)) return false;
                    seenUrls.add(lowerUrl);
                    return true;
                } catch { return false; }
            })
            .map(r => {
                let score = r._score || 0;
                try {
                    if (r.link.includes('doi.org')) score += 4;
                    if (r.citationCount > 50) score += 3;
                    if (r.citationCount > 10) score += 1;
                } catch {}
                return { ...r, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 20);
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING
    // ════════════════════════════════════════════════════════════════════════

    async _filterByRelevance(results, originalText, groqKey, brief, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results.slice(0, MINIMUM_RESULTS);
        }

        try {
            const summaries = results.map((r, i) => `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 250)}`).join('\n');

            const briefContext = brief ? `
GROUND TRUTH:
- Central question: ${brief.central_question || '(unspecified)'}
- Discipline: ${brief.discipline || '(unspecified)'}
- Must engage with: ${JSON.stringify(brief.must_engage_with || [])}

DOMAIN TYPE CONSTRAINT:
Only include papers where concepts are SPECIFICALLY ABOUT "${brief.discipline || 'the topic'}".
STRICT EXCLUSION: Reject generic methodology papers that don't analyze the specific topic.
` : `TOPIC: "${originalText.substring(0, 800)}"`;

            const prompt = `You are filtering search results.

 ${briefContext}

SEARCH RESULTS:
 ${summaries}

TASK: Return ONLY the index numbers of results that are highly relevant to the topic.
STRICTLY EXCLUDE papers that discuss generic ethics, AI, or algorithms UNLESS specifically tied to the topic.

Return ONLY a raw JSON array of index numbers, e.g.: [0, 1, 3, 5]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indices = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(indices)) throw new Error('Not an array');

            let filtered = indices
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            if (stage) stage.ok = true;

            if (filtered.length >= MINIMUM_RESULTS) {
                return filtered;
            }

            // Fallback if too strict
            if (filtered.length > 0 && filtered.length < MINIMUM_RESULTS) {
                const approvedIds = new Set(filtered.map(f => f.link));
                const fillers = results
                    .filter(r => !approvedIds.has(r.link))
                    .slice(0, MINIMUM_RESULTS - filtered.length);
                return [...filtered, ...fillers];
            }

            return results.slice(0, MINIMUM_RESULTS);

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[SourceFinder] Relevance filter failed:', e.message);
            return results.slice(0, MINIMUM_RESULTS);
        }
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 8: DATA ENRICHMENT
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
                await new Promise(r => setTimeout(r, 300));
            }
        }

        const crossrefCount = results.filter(s => s.citationSource === 'crossref').length;
        console.log(`[SourceFinder] ${crossrefCount}/${results.length} enriched from Crossref`);
        return results;
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 9: CITATION FORMATTING
    // ════════════════════════════════════════════════════════════════════════

    _formatCitation(source, style = 'apa7') {
        if (style.includes('mla')) return SourceFinderAPI._formatMla(source);
        if (style.includes('chicago')) return SourceFinderAPI._formatChicago(source);
        return SourceFinderAPI._formatApa(source);
    },

    _formatApa(source) {
        const authors = (source.authors || []).filter(a => a.family && a.family.length > 1);
        const formatAuthor = a => {
            const initials = a.given ? a.given.split(/[\s\-]+/).filter(Boolean).map(n => n[0].toUpperCase() + '.').join(' ') : '';
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
    // MODULE 10: UTILITIES & HELPERS
    // ════════════════════════════════════════════════════════════════════════

    _createStats() {
        return {
            startedAt: null,
            finishedAt: null,
            elapsedMs: 0,
            queriesGenerated: 0,
            stages: {
                topicAnalysis: { calls: 0, failures: 0, ms: 0, ok: false },
                openalex: { calls: 0, failures: 0, ms: 0, resultsReturned: 0 },
                filter: { calls: 0, failures: 0, ms: 0, ok: false }
            },
            results: { raw: 0, afterScoring: 0, afterFilter: 0 },
            totals: { externalRequests: 0, groqCalls: 0, httpRequests: 0, failedRequests: 0, successRate: 1 }
        };
    }
};


// ════════════════════════════════════════════════════════════════════════
// MODULE 11: API HANDLER
// ════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    try {
        const query = req.query.q;
        const style = req.query.style || 'apa7';
        if (!query) return res.status(400).json({ success: false, error: 'Missing ?q=' });
        
        const OPENALEX_KEY = process.env.OPENALEX_API_KEY;
        const GROQ_KEY = process.env.GROQ_API_KEY;
        
        const results = await SourceFinderAPI.searchTopic(query, 12, style, OPENALEX_KEY, GROQ_KEY);
        
        return res.status(200).json({ success: true, count: results.length, results });
    } catch (err) {
        console.error('[SourceFinder]', err);
        return res.status(500).json({ success: false, error: 'Search failed' });
    }
}
