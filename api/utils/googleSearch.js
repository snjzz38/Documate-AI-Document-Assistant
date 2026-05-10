// api/utils/googleSearch.js — v9 FINAL
// Simple: try instances sequentially, wait between retries, let scraper do its best

import { GroqAPI } from './groqAPI.js';

const _CFG = {
  searxng: {
    // Instances that actually return good sources when tested
    instances: [
      'https://searx.party',
      'https://search.2b9t.xyz',
      'https://grep.vim.wtf',
      'https://baresearch.org',
      'https://search.chocolate53.com',
      'https://searx.oloke.xyz',
    ],
    timeout: 6000,
    // Wait between retries (prevents 429)
    retryWaitMs: 2000,
  },

  maxResultsPerQuery: 50,
  maxQueriesGenerated: 3,

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

    try {
      // STEP 1: Generate queries
      const queries = groqKey
        ? await this._generateSmartQueries(essayText, groqKey)
        : this._generateFallbackQueries(essayText);

      if (queries.length === 0) {
        console.warn('[Search] No queries generated');
        return [];
      }

      console.log('[Search] Generated queries:', queries);

      // STEP 2: Fetch sequentially through instances
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
    const prompt = `You are generating 3 academic search queries from this text.

TEXT (first 1500 chars):
"""
${essay.substring(0, 1500)}
"""

Generate 3 different search queries. Each query should:
- Be 5-12 words long
- Focus on a different key topic from the text
- Be specific enough to find relevant sources
- Use academic/research terms

Return ONLY a JSON array with exactly 3 strings, nothing else:
["query one", "query two", "query three"]`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) {
        console.warn('[Search] No JSON array found in response');
        throw new Error('No JSON');
      }

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Not valid array');
      }

      // Validate and clean queries
      const queries = parsed
        .filter(q => typeof q === 'string')
        .map(q => q.trim())
        .filter(q => q.length >= 10 && q.length <= 150)
        .slice(0, 3);

      if (queries.length < 2) {
        console.warn('[Search] Not enough valid queries from LLM');
        throw new Error('Not enough queries');
      }

      console.log('[Search] Generated', queries.length, 'queries from LLM');
      return queries;

    } catch (error) {
      console.warn('[Search] Smart query gen failed:', error.message);
      return this._generateFallbackQueries(essay);
    }
  },

  _generateFallbackQueries(essay) {
    const queries = [];
    
    // Extract key phrases and sentences
    const sentences = essay.match(/[^.!?]+[.!?]/g) || [essay];
    
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'is', 'are', 'was', 'were',
      'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'it', 'its'
    ]);
    
    // Get meaningful words
    const words = (essay.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
      .filter(w => !stopWords.has(w))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 20);

    // Query 1: First substantive sentence
    if (sentences.length > 0) {
      const firstSentence = sentences[0].replace(/[.!?]/g, '').trim();
      if (firstSentence.length >= 20 && firstSentence.length <= 120) {
        queries.push(firstSentence);
      }
    }

    // Query 2: Key words combination
    if (words.length >= 4) {
      const keyWords = [words[0], words[1], words[2], words[3]];
      const q = keyWords.join(' ');
      if (q.length >= 15) queries.push(q);
    }

    // Query 3: Different aspect (second sentence or different keywords)
    if (sentences.length > 1) {
      const secondSentence = sentences[1].replace(/[.!?]/g, '').trim();
      if (secondSentence.length >= 20 && secondSentence.length <= 120 && secondSentence !== queries[0]) {
        queries.push(secondSentence);
      }
    } else if (words.length >= 8 && queries.length < 3) {
      const q = words.slice(4, 8).join(' ');
      if (q.length >= 15) queries.push(q);
    }

    // Ensure we have at least 2-3 queries
    const validQueries = queries
      .filter(q => q && q.length >= 12 && q.length <= 150)
      .slice(0, 3);

    console.log('[Search] Fallback generated', validQueries.length, 'queries from text extraction');
    return validQueries;
  },

  // ─── SEQUENTIAL Fetch ─────────────────────────────────────────────

  /**
   * For each query, try instances in order until one succeeds
   * If instance fails, wait a bit and try next instance
   */
  async _fetchAllSequential(queries) {
    const allResults = [];
    const seenUrls = new Set();

    for (const query of queries) {
      console.log(`[Search] Fetching: "${query.substring(0, 60)}..."`);

      let querySucceeded = false;

      // Try each instance in order
      for (let i = 0; i < _CFG.searxng.instances.length; i++) {
        if (querySucceeded) break;

        const instance = _CFG.searxng.instances[i];

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
          
          // Wait before trying next instance (prevents hammering)
          if (i < _CFG.searxng.instances.length - 1) {
            console.log(`[Search] Waiting ${_CFG.searxng.timeout / 1000}s before next instance...`);
            await new Promise(resolve => setTimeout(resolve, _CFG.searxng.timeout / 1000));
          }
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

  /**
   * Two-stage LLM filtering:
   * 1. Filter by relevance to essay topic
   * 2. Remove obvious irrelevant sources (satellite imagery, machine learning, etc.)
   */
  async _relevanceFilter(sources, essay, groqKey) {
    if (sources.length < 3) return sources;

    const sourceList = sources
      .slice(0, 25)
      .map((s, i) => `[${i + 1}] "${s.title}"\n    ${s.snippet.substring(0, 140)}\n    Domain: ${new URL(s.link).hostname}`)
      .join('\n\n');

    const prompt = `You are filtering academic sources. Remove OBVIOUSLY IRRELEVANT sources.

ESSAY TOPIC (first 900 chars):
"""
${essay.substring(0, 900)}
"""

SOURCES TO FILTER:
${sourceList}

TASK: Return a JSON array of source IDs to REMOVE (not keep).

Remove sources that are:
- About satellite imagery, machine learning, or computer vision
- About power systems, physics, or chaos theory
- Completely unrelated to the topic
- Generic study guides with no depth

Keep sources about:
- Anna Akhmatova and Requiem
- Russian poetry, literature, or history
- Elegiac poetry and themes
- Women in literature
- Yezhovshchina or Soviet repression
- Literary analysis of Requiem

Return ONLY JSON (no markdown, no explanation):
{"remove_ids": [8, 10, 12, 13, 14, 15, 18, 19, 20]}`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\{[\s\S]*?\}/);
      if (!match) throw new Error('No JSON');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.remove_ids)) throw new Error('No IDs');

      console.log(`[Search] LLM removing ${parsed.remove_ids.length} irrelevant sources:`, parsed.remove_ids);

      const relevant = sources.filter((_, i) => !parsed.remove_ids.includes(i + 1));
      return relevant.length > 0 ? relevant : sources.slice(0, 10);

    } catch (error) {
      console.warn('[Search] LLM filter failed:', error.message);
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
