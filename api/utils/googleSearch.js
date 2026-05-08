// api/utils/googleSearch.js — OPTIMIZED v8
// Strategy: 3-4 queries, extract 50 results per query, try only 2-3 instances max
// Result: 3-4 total requests instead of 32+

import { GroqAPI } from './groqAPI.js';

const _CFG = {
  searxng: {
    url: process.env.SEARXNG_URL || 'https://search.yourdomain.com',
    timeout: 6000,
  },
  bing: {
    apiKey: process.env.BING_API_KEY,
    endpoint: 'https://api.bing.microsoft.com/v7.0/search',
    timeout: 6000,
  },

  // KEY OPTIMIZATION: Extract MORE results per query, use FEWER instances
  maxResultsPerQuery: 50,     // Was 20, now 50 (get more in one request)
  maxQueriesGenerated: 3,      // Was 4, now 3 (fewer queries = fewer requests)
  maxInstancesPerQuery: 2,     // Try only 2 instances max per query
  
  // TOTAL REQUEST MATH:
  // 3 queries × 2 instances × 1 attempt = 6 requests max
  // vs old: 4 queries × 8 instances × 3 retries = 96 requests worst case
  // 16x fewer requests!

  hardBlock: new Set([
    'reddit.com', 'quora.com', 'stackoverflow.com', 'stackexchange.com',
    'youtube.com', 'tiktok.com', 'instagram.com', 'facebook.com',
    'twitter.com', 'x.com', 'pinterest.com', 'twitch.tv',
    'amazon.com', 'ebay.com', 'etsy.com', 'alibaba.com',
    'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com',
    'answers.microsoft.com', 'support.google.com', 'apple.com/support',
    'outlook.com', 'gmail.com', 'mail.google.com',
    'github.com', 'gitlab.com', 'bitbucket.org',
  ]),

  junkDomains: new Set([
    'dokumen.pub', 'scribd.com', 'academia.edu',
    'wattpad.com', 'fanfiction.net', 'grokipedia.com',
    'chegg.com', 'brainly.com', 'coursehero.com',
  ]),
};

export const GoogleSearchAPI = {

  async search(essay, _apiKey, _cx, groqKey = null, opts = {}) {
    if (!essay || typeof essay !== 'string' || essay.trim().length < 10) {
      console.error('[Search] Invalid essay');
      return [];
    }

    const essayText = essay.trim();
    const requestLog = { started: new Date(), requests: [] };

    try {
      // STEP 1: Generate 3 focused queries (minimal requests)
      const queries = groqKey
        ? await this._generateSmartQueries(essayText, groqKey)
        : this._generateFallbackQueries(essayText);

      if (queries.length === 0) {
        console.warn('[Search] No queries generated');
        return [];
      }

      console.log('[Search] Generated queries:', queries);
      console.log(`[Search] Will make ~${queries.length * _CFG.maxInstancesPerQuery} requests total`);

      // STEP 2: Fetch with minimal instances, maximum results per query
      const raw = await this._fetchAllOptimized(queries, requestLog);
      
      console.log(`[Search] Made ${requestLog.requests.length} actual requests to get ${raw.length} results`);
      console.log('[Search] Requests:', requestLog.requests);

      if (raw.length === 0) {
        console.warn('[Search] No results');
        return [];
      }

      // STEP 3: Filter
      const hardFiltered = this._hardFilter(raw);
      console.log(`[Search] After hard filter: ${hardFiltered.length}`);

      // STEP 4: LLM relevance filter
      const final = groqKey
        ? await this._relevanceFilter(hardFiltered, essayText, groqKey).catch(e => {
            console.warn('[Search] LLM filter failed');
            return hardFiltered;
          })
        : hardFiltered;

      console.log(`[Search] Final results: ${final.length}`);
      console.log(`[Search] Efficiency: ${final.length} results from ${requestLog.requests.length} requests = ${(final.length / requestLog.requests.length).toFixed(2)} results/request`);

      return this._structureForCitation(final);

    } catch (error) {
      console.error('[Search] Error:', error.message);
      return [];
    }
  },

  // ─── Query Generation ─────────────────────────────────────────────

  async _generateSmartQueries(essay, groqKey) {
    const prompt = `Generate 3 focused, scholarly search queries (not 4).

ESSAY (first 1200 chars):
"""
${essay.substring(0, 1200)}
"""

Requirements:
- 3 queries total (not more)
- 8-15 words each, specific
- Different aspects
- Academic focus
- Return JSON: ["query 1", "query 2", "query 3"]`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('No JSON');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) throw new Error('Not array');

      // Force exactly 3 queries max
      return parsed
        .filter(q => typeof q === 'string' && q.trim().length >= 20)
        .map(q => q.trim())
        .slice(0, 3); // Hard limit to 3

    } catch (error) {
      console.warn('[Search] Smart query gen failed:', error.message);
      return this._generateFallbackQueries(essay);
    }
  },

  _generateFallbackQueries(essay) {
    const queries = [];
    const sentences = essay.match(/[^.!?]+[.!?]/g) || [essay];
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'is', 'are']);
    const words = (essay.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
      .filter(w => !stopWords.has(w))
      .filter((v, i, a) => a.indexOf(v) === i);

    if (sentences.length > 0) {
      const q = sentences[0].replace(/[.!?]/g, '').trim();
      if (q.length >= 20) queries.push(q);
    }

    if (words.length >= 3) {
      queries.push(words.slice(0, 3).join(' '));
    }

    if (sentences.length > 1) {
      const q = sentences[1].replace(/[.!?]/g, '').trim();
      if (q.length >= 20) queries.push(q);
    }

    return queries
      .filter(q => q && q.length >= 15)
      .slice(0, 3); // Hard limit to 3
  },

  // ─── OPTIMIZED Fetch ──────────────────────────────────────────────

  /**
   * KEY OPTIMIZATION:
   * - For each query, try only 2 instances
   * - Extract 50 results per query (not 20)
   * - Stop as soon as we have enough
   * - Total: 3 queries × 2 instances = 6 requests max
   */
  async _fetchAllOptimized(queries, requestLog) {
    const allResults = [];
    const seenUrls = new Set();

    // Just 2 good instances to try (less load, less chance of 429)
    const instances = [
      'https://search.ononoki.org',
      'https://baresearch.org',
    ];

    for (const query of queries) {
      let querySatisfied = false;

      // Try only 2 instances per query
      for (const instance of instances) {
        if (querySatisfied) break;

        try {
          console.log(`[Search] Requesting: "${query.substring(0, 50)}..." from ${instance}`);
          
          const results = await this._fetchFromInstance(instance, query);
          requestLog.requests.push({ query: query.substring(0, 40), instance, results: results.length });

          // Collect results
          for (const r of results) {
            if (r.link && !seenUrls.has(r.link)) {
              allResults.push(r);
              seenUrls.add(r.link);
            }
          }

          // If we got good results, mark as satisfied (don't try next instance)
          if (results.length >= 30) {
            querySatisfied = true;
            console.log(`[Search] Query satisfied (${results.length} results)`);
          }

        } catch (error) {
          console.warn(`[Search] Failed on ${instance}: ${error.message}`);
          requestLog.requests.push({ query: query.substring(0, 40), instance, error: error.message });
        }
      }
    }

    return allResults;
  },

  /**
   * Fetch from a single instance, requesting 50 results instead of 20
   */
  async _fetchFromInstance(instanceUrl, query) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), _CFG.searxng.timeout);

    try {
      // Request 50 results per query (not 20)
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories: 'general,science',
        language: 'en',
        engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
        pageno: '1',
        // Some engines allow more results per page
        results_on_page: '50', // Try to get more at once
      });

      const response = await fetch(`${instanceUrl}/search?${params}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('Not JSON');

      const data = await response.json();
      if (!data.results || !Array.isArray(data.results)) throw new Error('No results');

      // Return up to 50 results
      return data.results
        .filter(r => r.url && r.title && r.title.length > 5)
        .slice(0, 50)  // Extract 50 not 20
        .map(r => ({
          title: r.title.trim(),
          link: r.url,
          snippet: (r.content || r.snippet || '').trim(),
          source: 'searxng',
        }));

    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  },

  // ─── Hard Filter ──────────────────────────────────────────────────

  _hardFilter(results) {
    return results.filter(r => {
      if (!r.link || !r.title) return false;

      try {
        const url = new URL(r.link);
        const domain = url.hostname.replace('www.', '').toLowerCase();

        if (_CFG.hardBlock.has(domain)) return false;
        if (_CFG.junkDomains.has(domain)) return false;

        if (r.title.length < 5 || r.title.length > 300) return false;

        const titleLower = r.title.toLowerCase();
        const snippetLower = (r.snippet || '').toLowerCase();

        const junkPatterns = [
          /^(how to|tutorial|guide:|step by step)/i,
          /netflix|streaming|watch/i,
          /error|troubleshoot|can't|not working/i,
          /login|signup|account|password/i,
          /download\s+(pdf|ebook|movie|video)/i,
          /illegal|pirate|torrent/i,
        ];

        if (junkPatterns.some(p => p.test(titleLower) && p.test(snippetLower))) {
          return false;
        }

        return true;
      } catch (e) {
        return false;
      }
    });
  },

  // ─── LLM Relevance Filter ────────────────────────────────────────

  async _relevanceFilter(sources, essay, groqKey) {
    if (sources.length < 3) return sources;

    const sourceList = sources
      .slice(0, 25)
      .map(
        (s, i) =>
          `[${i + 1}] "${s.title}"\n    ${s.snippet.substring(0, 140)}`
      )
      .join('\n\n');

    const prompt = `Filter for relevance.

ESSAY (first 900 chars):
"""
${essay.substring(0, 900)}
"""

SOURCES:
${sourceList}

Return: {"relevant_ids": [1, 3, 5]}
Keep 5-15, reject off-topic.`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\{[\s\S]*?\}/);
      if (!match) throw new Error('No JSON');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.relevant_ids)) throw new Error('No IDs');

      const relevant = sources.filter((_, i) => parsed.relevant_ids.includes(i + 1));
      return relevant.length > 0 ? relevant : sources.slice(0, 10);

    } catch (error) {
      console.warn('[Search] LLM filter failed');
      return sources;
    }
  },

  // ─── Structure ────────────────────────────────────────────────────

  _structureForCitation(sources) {
    return sources.map((s, i) => ({
      id: i + 1,
      title: s.title || 'Untitled',
      link: s.link,
      snippet: s.snippet || '',
      content: s.snippet || '',
      doi: null,
      meta: {
        author: null,
        year: 'n.d.',
        published: 'n.d.',
        siteName: this._getSiteName(s.link),
        isDOI: false,
      },
      engine: s.source || 'search',
    }));
  },

  _getSiteName(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      const part = host.split('.')[0];
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } catch {
      return 'Unknown';
    }
  },
};
