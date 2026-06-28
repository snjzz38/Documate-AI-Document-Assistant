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

const BANNED_DOMAINS = [
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    'amazon', 'ebay', 'etsy', 'alibaba',
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
    'wikipedia.org', 'britannica.com', 'wikihow.com', 'investopedia.com'
];

const BANNED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mp3', '.pdf.jpg'];

const ACADEMIC_DOMAINS = [
    'edu', 'gov', 'pubmed', 'ncbi.nlm.nih.gov', 'jstor',
    'scholar.google', 'arxiv', 'nature.com', 'science.org',
    'springer', 'wiley', 'tandfonline', 'sagepub', 'oup.com',
    'cambridge.org/core', 'pnas.org', 'cell.com', 'bmj.com', 'thelancet.com',
    'doi.org', 'sciencedirect', 'frontiersin', 'mdpi.com',
    'worldscientific', 'ssrn.com', 'acm.org', 'ieee.org', 'aps.org',
    'iop.org', 'royalsocietypublishing.org', 'plato.stanford.edu',
    'philpapers.org', 'oxfordacademic.com', 'eric.ed.gov'
];

const GENERIC_WORDS = new Set([
    'impact', 'importance', 'role', 'effect', 'affect', 'influence',
    'benefit', 'advantage', 'disadvantage', 'cause', 'result',
    'study', 'research', 'analysis', 'paper', 'article', 'review',
    'overview', 'introduction', 'conclusion', 'summary', 'discussion',
    'education', 'learning', 'development', 'growth', 'progress',
    'personal', 'societal', 'social', 'economic', 'academic',
    'main', 'three', 'one', 'two', 'first', 'second', 'third',
    'pillar', 'foundation', 'key', 'tool', 'thing', 'way', 'part',
    'make', 'made', 'take', 'get', 'use', 'used', 'using',
    'people', 'world', 'system', 'process', 'approach', 'method',
    'also', 'even', 'well', 'much', 'many', 'often', 'still'
]);

export const GoogleSearchAPI = {

    async search(query, apiKey, cx, groqKey = null) {
        let brief = null;
        if (groqKey) {
            brief = await this._analyzeTopic(query, groqKey);
            console.log('[Search] Brief:', JSON.stringify(brief, null, 2));
        }

        // Use the API-specific search queries
        const queries = brief
            ? brief.search_queries
            : [this._buildFallbackQuery(query)];
        console.log('[Search] Queries:', queries);

        const [openAlexResults, searxResultArrays] = await Promise.all([
            this._searchOpenAlex(queries, brief),
            Promise.all(queries.map(q => this._searchSearx(q)))
        ]);
        
        const searxResults = searxResultArrays.flat();
        const allResults = [...openAlexResults, ...searxResults];
        console.log(`[Search] Raw: OpenAlex=${openAlexResults.length}, SearXNG=${searxResults.length}`);

        const filtered = this._filterAndScore(allResults, brief);
        console.log('[Search] After scoring:', filtered.length);

        const relevant = await this._filterByRelevance(filtered, query, groqKey, brief);
        console.log('[Search] After relevance:', relevant.length);

        return relevant;
    },

    async _analyzeTopic(text, groqKey) {
        try {
            const prompt = `You are analyzing a student essay to prepare a "search brief" for finding academic sources.

ESSAY TEXT:
"${text.substring(0, 2500)}"

Return a JSON object with EXACTLY these fields:

{
  "discipline": "the specific academic discipline — e.g. 'philosophy of mathematics', 'macroeconomics', 'developmental psychology'",
  "core_question": "the central question the essay tries to answer",
  "key_arguments": ["the 3-5 main claims or arguments the essay makes"],
  "named_entities": [
    {"name": "any proper noun, named theory, or distinctive phrase from the essay", "context": "how the essay uses it"}
  ],
  "off_topic_disciplines": [
    {
      "discipline": "name of a discipline that shares KEYWORDS with the essay but asks DIFFERENT questions",
      "red_flags": ["2-4 title words that reliably signal a paper is from THIS off-topic discipline"]
    }
  ],
  "must_engage_with": [
    "3-5 specific natural language phrases that a TRULY relevant source MUST discuss",
    "A source engaging with NONE of these phrases is off-topic",
    "BAD: 'invention vs discovery'. GOOD: 'mathematics as invention or discovery'"
  ],
  "search_queries": [
    "5-7 search queries formatted specifically for ACADEMIC SEARCH ENGINES",
    "Each must be 3-5 keywords long (NOT natural language sentences)",
    "Always pair a concrete term with the discipline or abstract framing",
    "BAD: 'is mathematics invented or discovered' (too long, natural language)",
    "GOOD: 'philosophy mathematics invention discovery'",
    "BAD: 'constructivism mathematics'",
    "GOOD: 'philosophical constructivism epistemology mathematics'",
    "If a named distinctive phrase appears (e.g. 'unreasonable effectiveness'), include it in quotes in a query"
  ]
}

CRITICAL RULES:
1. "off_topic_disciplines": Think hard about what OTHER fields share keywords but ask different questions.
2. "search_queries": MUST be 3-5 word keyword clusters. Search engines do not understand natural language questions.
3. Cover ALL sections of the essay, not just the introduction.

Return ONLY raw JSON. No markdown fences. No explanation.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object found');

            const brief = JSON.parse(jsonMatch[0]);

            if (!brief.search_queries?.length) throw new Error('No search_queries');
            if (!brief.off_topic_disciplines) brief.off_topic_disciplines = [];
            if (!brief.must_engage_with) brief.must_engage_with = [];
            if (!brief.discipline) brief.discipline = '';
            if (!brief.core_question) brief.core_question = '';

            // Enforce 2-6 word length for API queries
            brief.search_queries = brief.search_queries
                .filter(q => typeof q === 'string')
                .map(q => q.trim())
                .filter(q => {
                    const wordCount = q.split(/\s+/).length;
                    return wordCount >= 2 && wordCount <= 6;
                })
                .slice(0, 8);

            brief._redFlags = brief.off_topic_disciplines
                .flatMap(d => d.red_flags || [])
                .map(f => f.toLowerCase().trim())
                .filter(f => f.length > 2 && f.length < 40);

            if (brief.search_queries.length === 0) throw new Error('No valid queries after length filter');

            return brief;

        } catch (e) {
            console.error('[Search] _analyzeTopic failed:', e.message);
            return null;
        }
    },

    async _searchOpenAlex(queries, brief) {
        const allResults = [];
        const disciplineHint = brief?.discipline ? ` ${brief.discipline}` : '';

        await Promise.all(queries.map(async (query) => {
            try {
                const enrichedQuery = disciplineHint && !this._queryHasDiscipline(query, brief.discipline)
                    ? query + disciplineHint
                    : query;

                const url = `https://api.openalex.org/works?search=${encodeURIComponent(enrichedQuery)}&per-page=8&mailto=research@example.com`;
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
                    if (!work.title || !link) continue;

                    const abstract = this._reconstructAbstract(work.abstract_inverted_index);
                    const authors = (work.authorships || [])
                        .map(a => a.author?.display_name).filter(Boolean).slice(0, 3).join(', ');

                    allResults.push({
                        title: work.title, link, snippet: abstract || '',
                        authors, year: work.publication_year,
                        venue: work.primary_location?.source?.display_name || '',
                        source: 'openalex', _score: 10
                    });
                }
            } catch (e) {
                console.error('[Search] OpenAlex error:', query, e.message);
            }
        }));
        return allResults;
    },

    _queryHasDiscipline(query, discipline) {
        if (!discipline) return true;
        return discipline.toLowerCase().split(/\s+/)
            .filter(w => w.length >= 3)
            .some(w => query.toLowerCase().includes(w));
    },

    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 400);
    },

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
                        .map(r => ({ title: r.title || '', link: r.url || '', snippet: r.content || '' }))
                        .filter(r => r.title && r.link);
                    if (results.length > 0) return results;
                } else {
                    const html = await res.text();
                    const results = this._parseResults(html);
                    if (results.length > 0) return results;
                }
            } catch (e) {
                console.error('[Search] SearXNG failed:', instance, e.message);
            }
        }
        return [];
    },

    _filterAndScore(results, brief) {
        const seenUrls = new Set();
        const seenTitles = new Set();
        const seenDomains = new Set();
        const redFlags = brief?._redFlags || [];

        return results
            .filter(r => {
                if (!r.title || !r.link) return false;
                const lowerUrl = r.link.toLowerCase();
                const lowerTitle = r.title.toLowerCase();
                const lowerSnippet = (r.snippet || '').toLowerCase();

                if (BANNED_EXTENSIONS.some(ext => lowerUrl.includes(ext))) return false;
                if (lowerUrl.includes('/dictionary/') || lowerUrl.includes('/definition/')) return false;

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (BANNED_DOMAINS.some(b => domain.includes(b))) return false;

                    // SOFTENED red-flag filter: Only hard-reject if 3+ flags in title, or 4+ in snippet
                    if (redFlags.length > 0) {
                        const titleFlags = redFlags.filter(f => lowerTitle.includes(f)).length;
                        const snippetFlags = redFlags.filter(f => lowerSnippet.includes(f)).length;
                        if (titleFlags >= 3) return false;
                        if (snippetFlags >= 5) return false;
                    }

                    const normalizedTitle = lowerTitle.substring(0, 60).trim();
                    if (seenTitles.has(normalizedTitle)) return false;
                    seenTitles.add(normalizedTitle);

                    if (seenUrls.has(lowerUrl)) return false;
                    seenUrls.add(lowerUrl);

                    const isAcademic = ACADEMIC_DOMAINS.some(p => domain.includes(p)) || domain.endsWith('.edu') || domain.endsWith('.gov');
                    if (!isAcademic && seenDomains.has(domain)) return false;
                    seenDomains.add(domain);

                    return true;
                } catch { return false; }
            })
            .map(r => {
                let score = r._score || 0;
                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (ACADEMIC_DOMAINS.some(p => domain.includes(p))) score += 5;
                    if (domain.endsWith('.edu')) score += 3;
                    if (domain.endsWith('.gov')) score += 3;
                    if (r.link.includes('doi.org')) score += 4;
                    if (r.authors) score += 2;
                    if (r.snippet && r.snippet.length > 100) score += 1;

                    if (domain.includes('blog')) score -= 3;
                    if (r.title.length < 15) score -= 2;
                    if (/\b(definition|meaning|what is)\b/i.test(r.title)) score -= 5;

                    // Soft red-flag penalty
                    if (redFlags.length > 0) {
                        const lowerTitle = r.title.toLowerCase();
                        const lowerSnippet = (r.snippet || '').toLowerCase();
                        const flagHits = redFlags.filter(f => lowerTitle.includes(f) || lowerSnippet.includes(f)).length;
                        score -= flagHits * 2; 
                    }
                } catch {}
                return { ...r, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 20);
    },

    async _filterByRelevance(results, originalText, groqKey, brief) {
        if (!groqKey || results.length === 0) return results;

        try {
            const summaries = results.map((r, i) =>
                `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 250)}`
            ).join('\n');

            let contextBlock;
            if (brief) {
                const offTopicLines = (brief.off_topic_disciplines || [])
                    .map(d => `  - ${d.discipline}: red flags ${JSON.stringify(d.red_flags || [])}`)
                    .join('\n');

                contextBlock = `
DISCIPLINE: ${brief.discipline || '(unspecified)'}
CORE QUESTION: ${brief.core_question || '(unspecified)'}
A relevant source must engage with at least ONE of these phrases: ${JSON.stringify(brief.must_engage_with || [])}

OFF-TOPIC DISCIPLINES (share keywords but ask different questions):
 ${offTopicLines || '  (none identified)'}

CRITICAL FILTERING RULES:
1. DISCIPLINE MATCH: The source must belong to the same discipline as the essay. If the essay is about "philosophy of mathematics", reject pure math, psychology, or education papers.
2. KEYWORD INTERSECTION vs ENGAGEMENT: A source that merely shares a keyword (e.g., "constructivism") but applies it in a different discipline (e.g., pedagogy) must be REJECTED.
3. PHRASE ECHOES: If a famous phrase from the essay is used as a playful metaphor in a different discipline (e.g., "unreasonable fairness" in Computer Science), REJECT it. Only accept sources discussing the phrase in its ORIGINAL context.`;
            } else {
                contextBlock = `
ESSAY TOPIC (first 800 chars):
"${originalText.substring(0, 800)}"

A relevant source must directly address the essay's central argument or question.`;
            }

            const prompt = `You are filtering search results for an academic essay.

 ${contextBlock}

SEARCH RESULTS:
 ${summaries}

TASK: Return ONLY the index numbers of results that:
1. Are ACADEMIC (peer-reviewed, journal article, scholarly book, .edu/.gov page)
2. Are from the SAME discipline as the essay
3. DIRECTLY ENGAGE with the core question — NOT merely share a keyword

STRICTLY EXCLUDE:
- Papers from off-topic disciplines — even if they share keywords
- Dictionary / thesaurus / encyclopedia entries
- Commercial sites, blog posts, forum threads

Return ONLY a raw JSON array of index numbers, e.g.: [0, 1, 3, 5]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indices = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(indices)) throw new Error('Not an array');

            const filtered = indices
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            // FIX: If the LLM over-filters and rejects everything, return the top 5 
            // statically scored results instead of dumping the whole unfiltered list
            return filtered.length > 0 ? filtered : results.slice(0, 5);

        } catch (e) {
            console.error('[Search] Relevance filter failed:', e.message);
            return results.slice(0, 5);
        }
    },

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
            .slice(0, 5);

        return (meaningful.join(' ') || 'academic research') + ' scholarly study';
    },

    _parseResults(html) {
        const results = [];
        const articleRegex = /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let match;

        while ((match = articleRegex.exec(html)) !== null) {
            const block = match[1];
            const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
            const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
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
