// api/utils/googleSearch.js
// SearXNG Academic Search — v3
// Changes from v2:
//   - Semantic concept normalization before query generation
//   - Enforced topic+mechanism+context query structure
//   - Strong academic scoring (floor enforcement, blog blackhole)
//   - Soft keyword constraints (entity presence check, not hard kill)
//   - Richer relevance prompt (sees entity list, not just essay snippet)
//   - JSON API first with per-session instance capability cache
//   - Up to 3 results per preferred domain, 1 per generic domain

import { GroqAPI } from './groqAPI.js';

// ─── Instances ────────────────────────────────────────────────────────────────
const INSTANCES = [
    { url: 'https://priv.au',              jsonKnown: true  },
    { url: 'https://search.sapti.me',      jsonKnown: null  },
    { url: 'https://searx.tiekoetter.com', jsonKnown: null  },
    { url: 'https://search.bus-hit.me',    jsonKnown: null  },
    { url: 'https://searx.be',             jsonKnown: null  },
    { url: 'https://search.ononoki.org',   jsonKnown: null  },
    { url: 'https://searxng.site',         jsonKnown: null  },
    { url: 'https://paulgo.io',            jsonKnown: null  },
];

// Per-session instance capability memory (JSON supported: true/false/null=unknown)
const instanceCapability = new Map(INSTANCES.map(i => [i.url, i.jsonKnown]));

// ─── Domain Lists ─────────────────────────────────────────────────────────────
const BANNED_DOMAINS = new Set([
    'reddit.com','quora.com','stackoverflow.com','stackexchange.com',
    'youtube.com','tiktok.com','instagram.com','facebook.com',
    'twitter.com','x.com','pinterest.com',
    'amazon.com','ebay.com','etsy.com','alibaba.com',
    'petmd.com','dogster.com','hillspet.com',
    'rover.com','dogtime.com','thesprucepets.com',
]);

const BANNED_EXTENSIONS = ['.jpg','.jpeg','.png','.gif','.webp','.svg','.mp4','.mp3'];

// Tier 1: top academic publishers — allow up to 3 results, heavy score bonus
const TIER1_DOMAINS = [
    'pubmed.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','arxiv.org',
    'nature.com','science.org','cell.com','pnas.org','bmj.com','thelancet.com',
    'springer.com','wiley.com','tandfonline.com','sagepub.com','oup.com',
    'cambridge.org','jstor.org','frontiersin.org','mdpi.com','plos.org',
    'royalsocietypublishing.org','sciencedirect.com','scholar.google.com',
    'researchgate.net','semanticscholar.org','crossref.org','biorxiv.org',
];

// Tier 2: reputable non-journal sources — allow up to 2 results
const TIER2_DOMAINS = [
    'nih.gov','cdc.gov','who.int','mayoclinic.org','clevelandclinic.org',
    'britannica.com','wikipedia.org','sciencedaily.com','physoc.org',
    'avma.org','javma.com',
];

// Blog / content-farm signals → heavy scoring penalty
const BLOG_SIGNALS = [
    'blog','wordpress','medium.com','substack','hubpages','ezinearticles','wixsite',
];

// Academic engines to prefer when the instance supports engine selection
const ACADEMIC_ENGINES = 'google,bing,duckduckgo,brave,semantic_scholar,crossref';

// ─── Semantic Concept Map ─────────────────────────────────────────────────────
// Maps colloquial/surface terms → precise academic equivalents.
// Applied during query generation to prevent literal keyword drift.
const CONCEPT_MAP = [
    [/\bpanting\b/i,                    'thermoregulation evaporative cooling'],
    [/\bupright ears?\b|\bearring?\b/i, 'auditory range frequency sensitivity'],
    [/\bhearing\b/i,                    'auditory physiology frequency detection'],
    [/\bsmell(ing)?\b|\bnose\b/i,       'olfactory receptor neuroscience'],
    [/\bpolic(e|ing)\b/i,               'law enforcement K9 working dog'],
    [/\brescue\b/i,                     'search rescue canine training'],
    [/\bsmart(ness|er)?\b|\bintelligen\w+/i, 'canine cognition problem-solving'],
    [/\bfur\b|\bcoat\b/i,               'thermoinsulation double coat morphology'],
    [/\bwolf\b/i,                       'canis lupus evolutionary ancestry'],
    [/\bbreed\b/i,                      'breed morphology genetic selection'],
];

// ─── Public API ───────────────────────────────────────────────────────────────
export const GoogleSearchAPI = {

    /**
     * Main entry point.
     * @param {string}  query     - Raw essay text or user query
     * @param {string}  _apiKey   - Unused (kept for API compat)
     * @param {string}  _cx       - Unused (kept for API compat)
     * @param {string}  groqKey   - Optional Groq key for LLM-assisted pipeline
     * @param {object}  opts      - { timeRange: 'day'|'month'|'year'|null }
     */
    async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
        const { timeRange = null } = opts;

        // 1. Extract key entities for anchoring and constraint checking
        const entities = groqKey
            ? await this._extractEntities(query, groqKey)
            : this._extractEntitiesFallback(query);

        console.log('[Search] Entities:', entities);

        // 2. Generate semantically-anchored queries
        const queries = groqKey
            ? await this._extractClaimQueries(query, entities, groqKey)
            : [this._buildFallbackQuery(query)];

        console.log('[Search] Queries:', queries);

        // 3. Run all queries in parallel
        const allResultArrays = await Promise.all(
            queries.map(q => this._searchWithFallback(q, { timeRange }))
        );
        const raw = allResultArrays.flat();
        console.log('[Search] Raw results:', raw.length);

        // 4. Score, filter, dedup with academic enforcement
        const scored = this._filterAndScore(raw, entities);
        console.log('[Search] After scoring:', scored.length);

        // 5. Soft entity-presence check (penalises but doesn't kill synonym-only sources)
        const anchored = this._softEntityFilter(scored, entities);
        console.log('[Search] After entity anchor:', anchored.length);

        // 6. LLM relevance pass with full entity context
        const final = groqKey
            ? await this._filterByRelevance(anchored, query, entities, groqKey)
            : anchored;

        console.log('[Search] Final:', final.length);
        return final;
    },

    // ─── Entity Extraction ────────────────────────────────────────────────────

    async _extractEntities(text, groqKey) {
        const prompt = `Extract the key named entities and core topics from this essay text.
Return a JSON object with:
- "anchors": 2-4 specific things that MUST be covered (named people, species, breeds, places, theories)
- "concepts": 3-6 academic/mechanistic concept terms
- "exclude": 1-3 topics that are NOT the focus (to prevent drift)

Essay (first 800 chars):
"""
${text.substring(0, 800)}
"""

Return ONLY raw JSON, no markdown fences:
{"anchors": [...], "concepts": [...], "exclude": [...]}`;

        try {
            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const match = response.match(/\{[\s\S]*?\}/);
            if (!match) throw new Error('No JSON');
            const parsed = JSON.parse(match[0]);
            return {
                anchors:  Array.isArray(parsed.anchors)  ? parsed.anchors  : [],
                concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
                exclude:  Array.isArray(parsed.exclude)  ? parsed.exclude  : [],
            };
        } catch (e) {
            console.warn('[Search] Entity extraction failed:', e.message);
            return this._extractEntitiesFallback(text);
        }
    },

    _extractEntitiesFallback(text) {
        const namedThings = (text.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\b/g) || [])
            .filter(w => !['The','This','That','These','Those','However','Furthermore',
                           'In','By','It','Also','As','An','At','Or','If'].includes(w));
        return {
            anchors:  [...new Set(namedThings)].slice(0, 3),
            concepts: [],
            exclude:  [],
        };
    },

    // ─── Query Generation ─────────────────────────────────────────────────────

    async _extractClaimQueries(text, entities, groqKey) {
        // Pre-expand surface terms to academic equivalents
        let expandedText = text.substring(0, 1500);
        for (const [pattern, replacement] of CONCEPT_MAP) {
            expandedText = expandedText.replace(pattern, `$& [→ ${replacement}]`);
        }

        const anchorStr  = entities.anchors.join(', ')  || '(none identified)';
        const conceptStr = entities.concepts.join(', ') || '(none identified)';
        const excludeStr = entities.exclude.join(', ')  || '(none)';

        const prompt = `You are generating precise academic search queries for an essay.

KEY ENTITIES (must appear in most queries): ${anchorStr}
CORE ACADEMIC CONCEPTS to use: ${conceptStr}
OFF-SCOPE TOPICS to avoid: ${excludeStr}

ESSAY TEXT (with academic concept hints):
"""
${expandedText}
"""

TASK: Return a JSON array of 4–6 search queries. Every query MUST follow this structure:
  [anchor entity] + [mechanism or process] + [context or domain]

STRICT RULES:
1. Each query MUST include at least one anchor entity from: ${anchorStr}
2. Prefer the academic concept terms from the hints — NOT the colloquial words
3. Each query must be 5–9 words
4. Cover EACH distinct claim in the essay — do NOT repeat topics
5. Do NOT write generic queries like "dog behavior research" or "animal science study"
6. Do NOT cover off-scope topics: ${excludeStr}

GOOD STRUCTURE EXAMPLES:
  "German Shepherd thermoregulation panting evaporative cooling physiology"
  "canine olfactory receptor count sensitivity neuroscience"
  "German Shepherd police K9 training effectiveness research"
  "working dog breed morphology selective breeding traits"
  "canine auditory frequency range detection physiology study"

Return ONLY a raw JSON array — no markdown, no explanation:
["query one", "query two", "query three"]`;

        try {
            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const match = response.match(/\[[\s\S]*?\]/);
            if (!match) throw new Error('No array');

            const queries = JSON.parse(match[0]);
            const cleaned = queries
                .filter(q => typeof q === 'string' && q.trim().split(/\s+/).length >= 4)
                .map(q => q.trim().substring(0, 120));

            if (cleaned.length === 0) throw new Error('Empty after cleaning');
            console.log('[Search] LLM queries:', cleaned);
            return cleaned;
        } catch (e) {
            console.warn('[Search] Query gen failed:', e.message);
            return [this._buildFallbackQuery(text)];
        }
    },

    _buildFallbackQuery(text) {
        const namedThings = (text.match(/\b[A-Z][a-z]{3,}\b/g) || [])
            .filter(w => !['The','This','That','These','Those','However','Furthermore',
                           'In','By','It','Also','As','An','At'].includes(w));
        const unique = [...new Set(namedThings)].slice(0, 4);
        if (unique.length >= 2) return unique.join(' ') + ' research study';

        const STOP = new Set(['the','a','an','is','are','was','were','be','been','have',
            'had','do','does','did','will','would','could','should','may','might','must',
            'this','that','they','their','what','which','who','where','when','how','all',
            'each','every','some','such','not','only','also','now','many','much','very',
            'just','make','made','take','get','use','used','people','things','often']);
        const words = (text.toLowerCase().match(/\b[a-z]{6,}\b/g) || []);
        const meaningful = [...new Set(words)].filter(w => !STOP.has(w)).slice(0, 5);
        return (meaningful.join(' ') || text.substring(0, 50)) + ' academic research';
    },

    // ─── Instance Dispatch ────────────────────────────────────────────────────

    async _searchWithFallback(query, { timeRange }) {
        const sorted = [...INSTANCES].sort((a, b) => {
            const rank = v => v === true ? 0 : v === null ? 1 : 2;
            const capA = instanceCapability.get(a.url);
            const capB = instanceCapability.get(b.url);
            return rank(capA) - rank(capB) + (Math.random() - 0.5) * 0.4;
        });

        for (const instance of sorted.slice(0, 5)) {
            try {
                const results = await this._fetchFromInstance(instance.url, query, { timeRange });
                if (results.length > 0) {
                    console.log(`[Search] ✓ ${results.length} from ${instance.url}`);
                    return results;
                }
            } catch (e) {
                console.warn(`[Search] ✗ ${instance.url}: ${e.message}`);
            }
        }

        console.warn('[Search] All instances failed for:', query);
        return [];
    },

    async _fetchFromInstance(instanceUrl, query, { timeRange }) {
        const cap = instanceCapability.get(instanceUrl);

        if (cap !== false) {
            try {
                const results = await this._fetchJSON(instanceUrl, query, { timeRange });
                instanceCapability.set(instanceUrl, true);
                return results;
            } catch (e) {
                if (e.message === 'JSON_DISABLED') {
                    instanceCapability.set(instanceUrl, false);
                } else {
                    throw e;
                }
            }
        }

        return await this._fetchHTML(instanceUrl, query, { timeRange });
    },

    // ─── JSON API Fetch (preferred) ───────────────────────────────────────────

    async _fetchJSON(instanceUrl, query, { timeRange }) {
        const params = new URLSearchParams({
            q:          query,
            format:     'json',
            categories: 'general,science',
            language:   'en',
            engines:    ACADEMIC_ENGINES,
        });
        if (timeRange) params.set('time_range', timeRange);

        const { res, text } = await this._timedFetch(`${instanceUrl}/search?${params}`);

        if (res.status === 403) throw new Error('JSON_DISABLED');
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) throw new Error('JSON_DISABLED');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        let data;
        try { data = JSON.parse(text); } catch { throw new Error('JSON_DISABLED'); }
        if (!Array.isArray(data.results)) throw new Error('JSON_DISABLED');

        return data.results
            .filter(r => r.url && r.title)
            .map(r => ({
                title:   r.title,
                link:    r.url,
                snippet: r.content || r.snippet || '',
                engine:  r.engine || '',
                score:   r.score  || 0,
            }));
    },

    // ─── HTML Scrape Fetch (fallback) ─────────────────────────────────────────

    async _fetchHTML(instanceUrl, query, { timeRange }) {
        const params = new URLSearchParams({
            q:          query,
            categories: 'general,science',
            language:   'en',
        });
        if (timeRange) params.set('time_range', timeRange);

        const { text } = await this._timedFetch(`${instanceUrl}/search?${params}`);
        return this._parseHTML(text);
    },

    _parseHTML(html) {
        const results = [];
        const seen = new Set();
        const articleRe = /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let m;

        while ((m = articleRe.exec(html)) !== null) {
            const block = m[1];
            const urlM   = block.match(/href="(https?:\/\/[^"#?][^"]*?)"/);
            const titleM = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) ||
                           block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
            const snipM  = block.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/);

            if (urlM && titleM) {
                const link  = urlM[1];
                const title = this._clean(titleM[1]);
                if (title && !seen.has(link) && !link.includes('searx')) {
                    results.push({ title, link, snippet: snipM ? this._clean(snipM[1]) : '', engine: 'html' });
                    seen.add(link);
                }
            }
        }

        if (results.length < 3) {
            const divRe = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            while ((m = divRe.exec(html)) !== null) {
                const block  = m[1];
                const urlM   = block.match(/href="(https?:\/\/[^"]+)"/);
                const titleM = block.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/);
                if (urlM && titleM) {
                    const link  = urlM[1];
                    const title = this._clean(titleM[1]);
                    if (title && !seen.has(link) && !link.includes('searx')) {
                        results.push({ title, link, snippet: '', engine: 'html-fallback' });
                        seen.add(link);
                    }
                }
            }
        }

        return results.slice(0, 30);
    },

    // ─── Scoring & Dedup ──────────────────────────────────────────────────────

    _filterAndScore(results, entities = { anchors: [], concepts: [], exclude: [] }) {
        const seenUrls    = new Set();
        const domainCount = new Map();

        const scored = results
            .filter(r => {
                if (!r.title || !r.link) return false;
                const lower = r.link.toLowerCase();
                if (BANNED_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
                if (seenUrls.has(r.link)) return false;

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (BANNED_DOMAINS.has(domain)) return false;

                    const isTier1 = TIER1_DOMAINS.some(p => domain.includes(p));
                    const isTier2 = TIER2_DOMAINS.some(p => domain.includes(p));
                    const limit   = isTier1 ? 3 : isTier2 ? 2 : 1;
                    if ((domainCount.get(domain) || 0) >= limit) return false;

                    seenUrls.add(r.link);
                    domainCount.set(domain, (domainCount.get(domain) || 0) + 1);
                    return true;
                } catch { return false; }
            })
            .map(r => {
                let score = r.score || 0;
                const combined = `${r.title} ${r.snippet}`.toLowerCase();

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();

                    // Tier bonuses — large enough to actually matter
                    if (TIER1_DOMAINS.some(p => domain.includes(p)))      score += 10;
                    else if (TIER2_DOMAINS.some(p => domain.includes(p))) score += 6;
                    else if (domain.endsWith('.edu'))                      score += 8;
                    else if (domain.endsWith('.gov'))                      score += 7;
                    else if (domain.endsWith('.org'))                      score += 2;

                    // Blog / content farm penalties
                    if (BLOG_SIGNALS.some(s => domain.includes(s) || r.link.includes(s))) score -= 8;
                    if (domain.includes('news') || domain.includes('article'))             score -= 2;

                    // Quality signals
                    if (r.title.length < 10)   score -= 4;
                    if (r.snippet.length > 150) score += 1;
                    if (['semantic_scholar','crossref'].includes(r.engine)) score += 3;

                    // Anchor entity presence bonus (not a hard requirement)
                    const anchorHits = entities.anchors.filter(a =>
                        combined.includes(a.toLowerCase())
                    ).length;
                    score += anchorHits * 2;

                    // Off-scope topic penalty
            */
  async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
    if (!groqKey) {
      // Fallback: return empty array — let connector handle error
      console.warn('[Search] No Groq key — returning empty results');
      return [];
    }

    const { timeRange = null } = opts;

    try {
      // ── STEP 1: Generate 2-3 targeted search queries ─────────────────────
      const queries = await this._generateQueries(query, groqKey);
      console.log('[Search] Generated queries:', queries);

      // ── STEP 2: Fetch raw results from SearXNG ───────────────────────────
      const raw = await this._fetchAll(queries, { timeRange });
      console.log(`[Search] Fetched ${raw.length} raw results`);

      if (raw.length === 0) {
        throw new Error('No search results. The search service may be temporarily unavailable.');
      }

      // ── STEP 3: Add minimal structure ScraperAPI expects ─────────────────
      const structured = raw.map((r, i) => ({
        id: i + 1,
        title: r.title || 'Untitled',
        link: r.link,
        snippet: r.snippet || '',
        content: r.snippet || '', // Scraper will enrich if needed
        doi: this._extractDOI(r.link, r.snippet),
        meta: {
          author: null,
          year: 'n.d.',
          published: 'n.d.',
          siteName: this._getSiteName(r.link),
          isDOI: false,
        },
        engine: r.engine || '',
      }));

      // ── STEP 4: LLM filters to only relevant, citable sources ────────────
      const filtered = await this._llmFilter(structured, query, groqKey);

      console.log(`[Search] Returning ${filtered.length} filtered sources`);
      return filtered;

    } catch (err) {
      console.error('[Search] Pipeline error:', err.message);
      throw err; // Let citation.js handle the error response
    }
  },

  // ─── MODULE: Query Generation ────────────────────────────────────────────
  async _generateQueries(essay, groqKey) {
    const prompt = `You are an academic research assistant. Generate exactly 2-3 targeted search queries to find scholarly sources that directly support or inform the argument below.

ESSAY / LINE OF INQUIRY:
"""
${essay.substring(0, 1000)}
"""

RULES:
- Each query must be a complete, academic-style phrase (6-12 words)
- Focus on key claims, themes, literary devices, or evidence mentioned
- Do NOT generate generic queries like "research" or "analysis"
- Return ONLY a raw JSON array of strings: ["query one", "query two"]`;

    try {
      const res = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
      const match = res.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('Invalid JSON format');
      const queries = JSON.parse(match[0]);
      if (!Array.isArray(queries) || queries.length === 0) throw new Error('Empty array');
      return queries.slice(0, _CFG.maxQueries).map(q => q.trim().substring(0, 150));
    } catch (e) {
      console.warn('[Search] Query gen failed:', e.message);
      // Fallback: split essay into 2 sentences as queries
      const sentences = essay.match(/[^.!?]+[.!?]+/g) || [essay];
      return sentences.slice(0, 2).map(s => s.trim().substring(0, 120));
    }
  },

  // ─── MODULE: SearXNG Fetcher ─────────────────────────────────────────────
  async _fetchAll(queries, { timeRange }) {
    const all = [];
    const seen = new Set();

    for (const q of queries) {
      for (const instance of _CFG.instances) {
        try {
          const batch = await this._fetchInstance(instance, q, { timeRange });
          for (const r of batch) {
            if (r.link && !seen.has(r.link) && all.length < _CFG.maxTotalResults) {
              // Hard-block only truly toxic domains
              const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
              if (!_CFG.hardBlock.has(domain)) {
                all.push(r);
                seen.add(r.link);
              }
            }
          }
          if (batch.length >= 4) break; // Good instance found
        } catch { continue; }
      }
    }
    return all;
  },

  async _fetchInstance(instanceUrl, query, { timeRange }) {
    const params = new URLSearchParams({
      q: query, format: 'json', categories: 'general,science',
      language: 'en', engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
      ...(timeRange && { time_range: timeRange }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _CFG.timeout);

    try {
      const res = await fetch(`${instanceUrl}/search?${params}`, {
        signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Not JSON');

      const data = await res.json();
      if (!Array.isArray(data.results)) throw new Error('No results array');

      return data.results.slice(0, _CFG.maxResultsPerQuery)
        .filter(r => r.url && r.title)
        .map(r => ({
          title: r.title, link: r.url,
          snippet: r.content || r.snippet || '', engine: r.engine || ''
        }));
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },

  // ─── MODULE: DOI Extraction (lightweight) ────────────────────────────────
  _extractDOI(url, snippet = '') {
    const doiOrg = url.match(/doi\.org\/(10\.\d{4,}\/[^\s"'?#]+)/i);
    if (doiOrg) return doiOrg[1];
    const inSnippet = snippet?.match(/\b(10\.\d{4,}\/[^\s"'<>\]]+)\b/);
    return inSnippet ? inSnippet[1] : null;
  },

  _getSiteName(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      const part = host.split('.')[0];
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } catch { return 'Unknown'; }
  },

  // ─── MODULE: LLM Relevance Filter (Final Gate) ───────────────────────────
  async _llmFilter(sources, essay, groqKey) {
    // Format for LLM: concise but informative
    const list = sources.map((s, i) => 
      `[${s.id}] "${s.title}"\n    ${s.snippet.substring(0, 160)}\n    Source: ${new URL(s.link).hostname}${s.doi ? ` | DOI: ${s.doi}` : ''}`
    ).join('\n\n');

    const prompt = `You are an academic research librarian. Filter these search results to find only the most relevant, credible sources for the essay below.

ESSAY / ARGUMENT:
"""
${essay.substring(0, 800)}
"""

SEARCH RESULTS:
${list}

TASK: Return a JSON object where:
- "kept_ids" is an array of SOURCE IDs (numbers) to KEEP
- ONLY keep sources that directly support, analyze, or provide credible evidence for claims in the essay
- REJECT: generic summaries, non-academic blogs, essay mills, or tangentially related content
- Keep 5-12 sources total
- Return ONLY raw JSON: {"kept_ids": [1, 3, 7]}`;

    try {
      const res = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
      const match = res.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Invalid JSON format');
      const parsed = JSON.parse(match[0]);

      if (!Array.isArray(parsed.kept_ids) || parsed.kept_ids.length === 0) {
        throw new Error('LLM returned no kept sources');
      }

      const kept = sources.filter(s => parsed.kept_ids.includes(s.id));

      // Safety: if LLM over-filters, return top 5 by snippet length + DOI presence
      if (kept.length < 3) {
        console.warn('[Search] LLM filtered too aggressively, returning fallback');
        return sources
          .sort((a, b) => {
            const scoreA = (a.doi ? 10 : 0) + a.snippet.length;
            const scoreB = (b.doi ? 10 : 0) + b.snippet.length;
            return scoreB - scoreA;
          })
          .slice(0, 5);
      }

      return kept;
    } catch (e) {
      console.warn('[Search] LLM filter failed:', e.message);
      // Fail-open: return top 5 by quality signals
      return sources
        .sort((a, b) => {
          const scoreA = (a.doi ? 10 : 0) + (a.snippet.length > 100 ? 3 : 0) + (a.title.length > 15 ? 2 : 0);
          const scoreB = (b.doi ? 10 : 0) + (b.snippet.length > 100 ? 3 : 0) + (b.title.length > 15 ? 2 : 0);
          return scoreB - scoreA;
        })
        .slice(0, 5);
    }
  },
};
