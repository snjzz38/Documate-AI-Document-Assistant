// api/utils/googleSearch.js — SIMPLE v9
// Strategy: Run queries sequentially through instances
// For each query: try instance 1, if fails try instance 2, if fails try instance 3
// Simple, clean, minimal requests

import { GroqAPI } from './groqAPI.js';

const _CFG = {
  searxng: {
    // List of instances to try in order
    instances: [
      'https://search.ononoki.org',
      'https://baresearch.org',
      'https://searx.party',
      'https://search.2b9t.xyz',
      'https://grep.vim.wtf',
    ],
    timeout: 6000,
  },

  // Settings
  maxResultsPerQuery: 50,     // Extract 50 results per query
  maxQueriesGenerated: 3,      // 3 queries total
  
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

  /**
   * Main search: Generate queries, fetch from instances sequentially
   */
  async search(essay, _apiKey, _cx, groqKey = null, opts = {}) {
    if (!essay || typeof essay !== 'string' || essay.trim().length < 10) {
      console.error('[Search] Invalid essay');
      return [];
    }

    const essayText = essay.trim();

    try {
      // STEP 1: Generate 3 queries
      const queries = groqKey
        ? await this._generateSmartQueries(essayText, groqKey)
        : this._generateFallbackQueries(essayText);

      if (queries.length === 0) {
        console.warn('[Search] No queries generated');
        return [];
      }

      console.log('[Search] Generated queries:', queries);

      // STEP 2: Fetch using instance-first strategy
      const raw = await this._fetchAllSequential(queries);
      
      if (raw.length === 0) {
        console.warn('[Search] No results');
        return [];
      }

      console.log(`[Search] Got ${raw.length} raw results`);

      // STEP 3: Hard filter
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
      return this._structureForCitation(final);

    } catch (error) {
      console.error('[Search] Error:', error.message);
      return [];
    }
  },

  // ─── Query Generation ─────────────────────────────────────────────

  async _generateSmartQueries(essay, groqKey) {
    const prompt = `Generate 3 focused, scholarly search queries.

ESSAY (first 1200 chars):
"""
${essay.substring(0, 1200)}
"""

Requirements:
- 3 queries total
- 8-15 words each
- Different aspects of essay
- Academic focus
- Return JSON only: ["query 1", "query 2", "query 3"]`;

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

      return parsed
        .filter(q => typeof q === 'string' && q.trim().length >= 20)
        .map(q => q.trim())
        .slice(0, 3);

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
      if (q.length >= 20 && q !== queries[0]) queries.push(q);
    }

    return queries.filter(q => q && q.length >= 15).slice(0, 3);
  },

  // ─── SEQUENTIAL Fetch (Instance by Instance) ──────────────────────

  /**
   * For each query, try instances in order until one succeeds
   * 
   * Flow:
   * Query 1 → Try instance 1 → Success → Next query
   * Query 2 → Try instance 1 → Success → Next query
   * Query 3 → Try instance 1 → Success → Done
   * 
   * If instance 1 fails for a query:
   * Query 1 → Try instance 1 → Fails → Try instance 2 → Success → Next query
   * 
   * If all instances fail for a query:
   * Query 1 → Try all instances → All fail → Log and continue to next query
   */
  async _fetchAllSequential(queries) {
    const allResults = [];
    const seenUrls = new Set();

    for (const query of queries) {
      console.log(`[Search] Fetching: "${query.substring(0, 60)}..."`);

      let querySucceeded = false;

      // Try each instance in order until one works
      for (const instance of _CFG.searxng.instances) {
        if (querySucceeded) break; // Already got results for this query

        try {
          const results = await this._fetchFromInstance(instance, query);
          
          if (results.length > 0) {
            console.log(`[Search] ✓ ${results.length} results from ${instance}`);
            querySucceeded = true;

            // Add to results (dedup)
            for (const r of results) {
              if (r.link && !seenUrls.has(r.link)) {
                allResults.push(r);
                seenUrls.add(r.link);
              }
            }
          }
        } catch (error) {
          console.warn(`[Search] ✗ ${instance}: ${error.message}`);
          // Try next instance
        }
      }

      if (!querySucceeded) {
        console.warn(`[Search] ⚠️ No results for query: "${query.substring(0, 60)}..."`);
      }
    }

    return allResults;
  },

  /**
   * Fetch from single instance
   */
  async _fetchFromInstance(instanceUrl, query) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), _CFG.searxng.timeout);

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories: 'general,science',
        language: 'en',
        engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
      });

      const response = await fetch(`${instanceUrl}/search?${params}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        throw new Error('Not JSON');
      }

      const data = await response.json();
      if (!data.results || !Array.isArray(data.results)) {
        throw new Error('No results array');
      }

      // Extract up to 50 results
      return data.results
        .filter(r => r.url && r.title && r.title.length > 5)
        .slice(0, 50)
        .map(r => ({
          title: r.title.trim(),
          link: r.url,
          snippet: (r.content || r.snippet || '').trim(),
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
      .map((s, i) => `[${i + 1}] "${s.title}"\n    ${s.snippet.substring(0, 140)}`)
      .join('\n\n');

    const prompt = `Filter for relevance.

ESSAY (first 900 chars):
"""
${essay.substring(0, 900)}
"""

SOURCES:
${sourceList}

Return JSON: {"relevant_ids": [1, 3, 5]}
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
      engine: 'searxng',
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
