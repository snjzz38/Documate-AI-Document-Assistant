// api/utils/googleSearch.js
import { GroqAPI } from './groqAPI.js';

const SEARX_INSTANCES = [
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.bus-hit.me',
    'https://searx.be',
    'https://search.ononoki.org',
    'https://priv.au'
];

// Domains that should NEVER appear as academic citations
const BANNED_DOMAINS = [
    // Social / UGC
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    // E-commerce
    'amazon', 'ebay', 'etsy', 'alibaba',
    // Dictionary / thesaurus (NOT academic sources — these were polluting your results)
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
    // Commercial / brand sites whose name matches common keywords
    'impact.com', 'watchimpact.com', 'impactmobile', 'impacttest.com',
    // Encyclopedic (use sparingly, not as primary citation)
    'wikipedia.org', 'britannica.com', 'wikihow.com', 'investopedia.com'
];

const BANNED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mp3', '.pdf.jpg'];

const PREFERRED_DOMAINS = [
    'edu', 'gov', 'pubmed', 'ncbi.nlm.nih.gov', 'jstor',
    'scholar.google', 'arxiv', 'nature.com', 'science.org',
    'springer', 'wiley', 'tandfonline', 'sagepub', 'oup.com',
    'cambridge.org/core', 'pnas.org', 'cell.com', 'bmj.com', 'thelancet.com',
    'doi.org', 'sciencedirect', 'frontiersin', 'mdpi.com',
    'taylorfrancis.com', 'worldscientific', 'eric.ed.gov', 'ssrn.com'
];

// Generic words that should NEVER be the primary search term.
// These were polluting queries — "impact" alone returns the SaaS company, not academic sources.
const GENERIC_WORDS = new Set([
    'impact', 'importance', 'role', 'effect', 'affect', 'influence',
    'benefit', 'advantage', 'disadvantage', 'cause', 'result',
    'study', 'research', 'analysis', 'paper', 'article', 'review',
    'overview', 'introduction', 'conclusion', 'summary', 'discussion',
    'education', 'learning', 'development', 'growth', 'progress',
    'personal', 'societal', 'social', 'economic', 'academic',
    'main', 'three', 'one', 'two', 'first', 'second', 'third',
    'pillar', 'foundation', 'key', 'tool'
]);

export const GoogleSearchAPI = {

    async search(query, apiKey, cx, groqKey = null) {
        // Step 1: Extract claim-specific queries via Groq
        const queries = groqKey
            ? await this._extractClaimQueries(query, groqKey)
            : [this._buildFallbackQuery(query)];

        console.log('[Search] Claim queries:', queries);

        // Step 2: Search OpenAlex FIRST (primary — real academic papers with DOIs)
        const openAlexResults = await this._searchOpenAlex(queries);
        console.log('[Search] OpenAlex results:', openAlexResults.length);

        // Step 3: Search SearXNG IN PARALLEL (secondary — broader coverage)
        const searxResultArrays = await Promise.all(
            queries.map(q => this._searchSearx(q))
        );
        const searxResults = searxResultArrays.flat();
        console.log('[Search] SearXNG results:', searxResults.length);

        // Step 4: Merge, filter, score, deduplicate
        const allResults = [...openAlexResults, ...searxResults];
        const filtered = this._filterAndScore(allResults);
        console.log('[Search] After scoring:', filtered.length);

        // Step 5: Groq relevance filter — strict academic-only pass
        const relevant = await this._filterByRelevance(filtered, query, groqKey);
        console.log('[Search] After relevance filter:', relevant.length);

        return relevant;
    },

    // ─── NEW: OpenAlex API ──────────────────────────────────────────────
    // Free, no API key, returns real peer-reviewed papers with abstracts.
    // This is the single biggest improvement — you stop searching the open
    // web and start searching actual academic literature.
    // ────────────────────────────────────────────────────────────────────
    async _searchOpenAlex(queries) {
        const allResults = [];

        await Promise.all(queries.map(async (query) => {
            try {
                const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=8&mailto=research@example.com`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);

                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'AcademicCitationTool/1.0 (mailto:research@example.com)' }
                });
                clearTimeout(timeout);

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                for (const work of (data.results || [])) {
                    const doi = work.doi || (work.ids?.doi ? `https://doi.org/${work.ids.doi}` : null);
                    const link = doi || work.id;
                    const abstract = this._reconstructAbstract(work.abstract_inverted_index);
                    const authors = (work.authorships || [])
                        .map(a => a.author?.display_name)
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(', ');

                    if (!work.title || !link) continue;

                    allResults.push({
                        title: work.title,
                        link,
                        snippet: abstract || '',
                        authors,
                        year: work.publication_year,
                        venue: work.primary_location?.source?.display_name || '',
                        source: 'openalex',
                        _score: 10  // heavy boost — these are real academic papers
                    });
                }
            } catch (e) {
                console.error('[Search] OpenAlex failed for query:', query, e.message);
            }
        }));

        return allResults;
    },

    // OpenAlex returns abstracts as inverted indexes — reconstruct to plain text.
    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions
            .sort((a, b) => a[0] - b[0])
            .map(p => p[1])
            .join(' ')
            .substring(0, 400);
    },

    // ─── Improved SearXNG search ────────────────────────────────────────
    // Now requests JSON via &format=json — far more reliable than HTML scraping.
    // Falls back to HTML parsing if the instance refuses JSON.
    // ────────────────────────────────────────────────────────────────────
    async _searchSearx(query) {
        const shuffled = [...SEARX_INSTANCES].sort(() => Math.random() - 0.5);

        for (const instance of shuffled.slice(0, 4)) {
            try {
                const url = `${instance}/search?q=${encodeURIComponent(query)}&categories=general,science&language=en&format=json`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);

                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                clearTimeout(timeout);

                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const contentType = res.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await res.json();
                    const results = (data.results || [])
                        .map(r => ({
                            title: r.title || '',
                            link: r.url || '',
                            snippet: r.content || ''
                        }))
                        .filter(r => r.title && r.link);
                    if (results.length > 0) {
                        console.log('[Search] SearXNG JSON:', results.length, 'from', instance);
                        return results;
                    }
                } else {
                    // HTML fallback
                    const html = await res.text();
                    const results = this._parseResults(html);
                    if (results.length > 0) {
                        console.log('[Search] SearXNG HTML:', results.length, 'from', instance);
                        return results;
                    }
                }
            } catch (e) {
                console.error('[Search] SearXNG instance failed:', instance, e.message);
            }
        }

        console.warn('[Search] All SearXNG instances failed for:', query);
        return [];
    },

    // ─── Improved Groq query extraction ─────────────────────────────────
    // The prompt now explicitly bans generic words ("impact", "importance",
    // "education" alone) and requires 2-4 SPECIFIC topical keywords per query.
    // ────────────────────────────────────────────────────────────────────
    async _extractClaimQueries(text, groqKey) {
        try {
            const prompt = `You are helping find ACADEMIC sources for a student essay.

ESSAY TEXT (first 1500 chars):
"${text.substring(0, 1500)}"

TASK: Return a JSON array of 5-7 search queries that will surface peer-reviewed academic papers, scholarly articles, or .edu/.gov sources relevant to the SPECIFIC claims in this essay.

CRITICAL RULES:
1. Each query must target a SPECIFIC claim, theory, statistic, or named entity in the essay — NOT the general topic.
2. NEVER use these generic words as the primary term: impact, importance, role, effect, benefit, study, research, education, learning, development, growth, personal, societal, economic.
3. Each query must combine 2-4 SPECIFIC topical keywords that would appear in academic paper titles.
4. Cover EVERY distinct section or argument in the essay — not just the first one.
5. If a researcher, theorist, or study is named, include their name.
6. Prefer queries likely to surface journal articles, NOT dictionaries or commercial sites.

GOOD EXAMPLES (for an essay on education):
- "education critical thinking skills academic achievement"
- "higher education lifetime earnings poverty reduction"
- "civic engagement voter turnout education level"
- "education crime recidivism reduction study"
- "gender equality access education developing countries"
- "lifelong learning adult education economic outcomes"
- "education workforce productivity innovation national growth"

BAD EXAMPLES (do NOT do this):
- "impact of education" (too generic, returns brand sites)
- "importance of education" (returns opinion blogs)
- "education research" (returns anything)

Return ONLY a raw JSON array, no explanation, no markdown:
["query one", "query two", "query three"]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            console.log('[Search] Groq raw response:', response);

            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array in response');

            const queries = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(queries) || queries.length === 0) throw new Error('Empty array');

            // Filter out queries that are too generic (only contain GENERIC_WORDS)
            const cleaned = queries
                .filter(q => typeof q === 'string' && q.trim().split(/\s+/).length >= 3)
                .map(q => q.trim().substring(0, 120))
                .filter(q => {
                    const words = q.toLowerCase().split(/\s+/);
                    const specificWords = words.filter(w => !GENERIC_WORDS.has(w));
                    return specificWords.length >= 2;  // require at least 2 specific words
                });

            if (cleaned.length === 0) throw new Error('All queries too generic');
            console.log('[Search] Extracted queries:', cleaned);
            return cleaned;

        } catch (e) {
            console.error('[Search] _extractClaimQueries failed:', e.message);
            return [this._buildFallbackQuery(text)];
        }
    },

    // ─── Improved relevance filter ──────────────────────────────────────
    // Now explicitly tells Groq to reject dictionaries, brand sites,
    // social media, and "results that only share a keyword with the topic."
    // ────────────────────────────────────────────────────────────────────
    async _filterByRelevance(results, originalText, groqKey) {
        if (!groqKey || results.length === 0) return results;

        try {
            const summaries = results.map((r, i) =>
                `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 200)}`
            ).join('\n');

            const prompt = `You are filtering search results for an academic essay.

ESSAY TOPIC SUMMARY (first 800 chars):
"${originalText.substring(0, 800)}"

SEARCH RESULTS:
${summaries}

TASK: Return ONLY the index numbers of results that satisfy BOTH criteria:
1. ACADEMIC NATURE — peer-reviewed paper, journal article, scholarly book chapter, .edu page, .gov report, or a reputable research organization (e.g., OECD, World Bank, Brookings).
2. DIRECT RELEVANCE — directly about a specific claim in the essay, not just sharing a keyword.

STRICTLY EXCLUDE:
- Dictionary or thesaurus entries (e.g., "impact definition", "meaning of...")
- Commercial / brand websites whose name happens to match a keyword (e.g., impact.com for an essay about "impact of education")
- Social media, forums, Q&A sites, blog posts without scholarly attribution
- TV networks, marketing platforms, insurance sites, etc.
- Results that only share a word with the essay topic but aren't about the same subject

Return ONLY a raw JSON array of index numbers, e.g.: [0, 1, 3, 5]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indices = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(indices)) throw new Error('Not an array');

            const filtered = indices
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            // Safety: if Groq filtered everything out, return originals
            return filtered.length > 0 ? filtered : results;

        } catch (e) {
            console.error('[Search] Relevance filter failed:', e.message);
            return results;
        }
    },

    // ─── Improved filter + score + dedup ────────────────────────────────
    // Adds:
    //   - URL pattern bans for /dictionary/ and /definition/
    //   - Title-similarity dedup (kills multiple "impact definition" results)
    //   - Stronger scoring: +5 for PREFERRED_DOMAINS, +4 for DOI links
    //   - Penalty for titles containing "definition", "meaning", "what is"
    // ────────────────────────────────────────────────────────────────────
    _filterAndScore(results) {
        const seenUrls = new Set();
        const seenTitles = new Set();
        const seenDomains = new Set();

        return results
            .filter(r => {
                if (!r.title || !r.link) return false;

                const lowerUrl = r.link.toLowerCase();
                const lowerTitle = r.title.toLowerCase();

                if (BANNED_EXTENSIONS.some(ext => lowerUrl.includes(ext))) return false;

                // Ban dictionary entries by URL pattern
                if (lowerUrl.includes('/dictionary/') || lowerUrl.includes('/definition/')) return false;

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (BANNED_DOMAINS.some(b => domain.includes(b))) return false;

                    // Title-based dedup (first 60 chars, normalized) — kills
                    // near-duplicate "impact definition" results from multiple sites
                    const normalizedTitle = lowerTitle.substring(0, 60).trim();
                    if (seenTitles.has(normalizedTitle)) return false;
                    seenTitles.add(normalizedTitle);

                    if (seenUrls.has(lowerUrl)) return false;
                    seenUrls.add(lowerUrl);

                    // For non-academic domains, allow only 1 result per domain
                    // (academic domains like sciencedirect may legitimately have many)
                    const isAcademic = PREFERRED_DOMAINS.some(p => domain.includes(p)) ||
                                       domain.endsWith('.edu') || domain.endsWith('.gov');
                    if (!isAcademic) {
                        if (seenDomains.has(domain)) return false;
                        seenDomains.add(domain);
                    }
                    return true;
                } catch { return false; }
            })
            .map(r => {
                let score = r._score || 0;
                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (PREFERRED_DOMAINS.some(p => domain.includes(p))) score += 5;
                    if (domain.endsWith('.edu')) score += 3;
                    if (domain.endsWith('.gov')) score += 3;
                    if (r.link.includes('doi.org')) score += 4;
                    if (domain.includes('blog')) score -= 3;
                    if (r.title.length < 15) score -= 2;
                    if (r.snippet && r.snippet.length > 100) score += 1;
                    // Penalize dictionary-style titles even if they slip through URL filter
                    if (/\b(definition|meaning|what is)\b/i.test(r.title)) score -= 5;
                    // Bonus for results with author metadata (OpenAlex)
                    if (r.authors) score += 2;
                } catch {}
                return { ...r, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 15);
    },

    // ─── REWRITTEN fallback query builder ───────────────────────────────
    // OLD: extracted Capitalized Words → grabbed section headers like "Impact"
    //      and "Personal Growth" → returned dictionary/brand sites.
    // NEW: extracts lowercase content words (4+ chars), filters out
    //      GENERIC_WORDS, joins 4 most-specific words + "academic study".
    // ────────────────────────────────────────────────────────────────────
    _buildFallbackQuery(text) {
        const stopWords = new Set([
            'the','a','an','is','are','was','were','be','been','being','have','has','had',
            'do','does','did','will','would','could','should','may','might','must','can',
            'this','that','these','those','they','their','what','which','who','where',
            'when','why','how','all','each','every','both','few','more','most','other',
            'some','such','no','nor','not','only','own','same','so','than','too','very',
            'just','also','now','people','things','many','much','often','even','well',
            'make','made','take','get','put','use','used','using','instead','through',
            ...GENERIC_WORDS
        ]);

        const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        const meaningful = [...new Set(words)]
            .filter(w => !stopWords.has(w))
            .slice(0, 4);

        return (meaningful.join(' ') || 'education research') + ' academic study';
    },

    // ─── HTML parser (fallback only — kept for SearXNG instances that refuse JSON)
    _parseResults(html) {
        const results = [];

        const articleRegex = /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let match;

        while ((match = articleRegex.exec(html)) !== null) {
            const block = match[1];
            const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
            const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) ||
                               block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
            const snippetMatch = block.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/);

            if (urlMatch && titleMatch) {
                const url = urlMatch[1];
                const title = this._clean(titleMatch[1]);
                const snippet = snippetMatch ? this._clean(snippetMatch[1]) : '';
                if (title && url && !url.includes('searx')) {
                    results.push({ title, link: url, snippet });
                }
            }
        }

        if (results.length < 3) {
            const divRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            while ((match = divRegex.exec(html)) !== null) {
                const block = match[1];
                const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
                const titleMatch = block.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/);
                if (urlMatch && titleMatch) {
                    const url = urlMatch[1];
                    const title = this._clean(titleMatch[1]);
                    if (title && !url.includes('searx') && !results.some(r => r.link === url)) {
                        results.push({ title, link: url, snippet: '' });
                    }
                }
            }
        }

        return results.slice(0, 30);
    },

    _clean(html) {
        return (html || '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim().substring(0, 300);
    }
};
