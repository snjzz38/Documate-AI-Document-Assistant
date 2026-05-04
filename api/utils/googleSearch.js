// api/utils/googleSearch.js
// Academic Source Search — Pipeline v6 (Compatible with citation.js)
// Signature: search(query, _apiKey, _cx, groqKey, opts) → Array<source>
// Pipeline: LLM Query Gen → SearXNG Fetch → LLM Relevance Filter → Return

import { GroqAPI } from './groqAPI.js';

// ─── Internal Config (not hardcoded filtering) ──────────────────────────────
const _CFG = {
  instances: [
    'https://priv.au', 'https://search.sapti.me', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://searx.be', 'https://search.ononoki.org',
    'https://searxng.site', 'https://paulgo.io',
  ],
  timeout: 8000,
  maxQueries: 3,
  maxResultsPerQuery: 12,
  maxTotalResults: 35,
  // Only truly toxic domains blocked at fetch level — everything else judged by LLM
  hardBlock: new Set([
    'reddit.com','quora.com','youtube.com','tiktok.com','instagram.com',
    'facebook.com','twitter.com','x.com','amazon.com','ebay.com',
    '123helpme.com','scribd.com','ukessays.com','kibin.com','studycorgi.com',
    'coursehero.com','chegg.com','essaypro.com','aithor.com',
  ]),
};

export const GoogleSearchAPI = {
  /**
   * Main entry point — matches citation.js connector exactly.
   * @param {string} query - Essay text or line of inquiry
   * @param {string} _apiKey - Unused (compat)
   * @param {string} _cx - Unused (compat)
   * @param {string} groqKey - Required for LLM pipeline steps
   * @param {object} opts - { timeRange?: 'day'|'month'|'year' }
   * @returns {Promise<Array>} Sources with: id, title, link, snippet, content, meta, doi
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
