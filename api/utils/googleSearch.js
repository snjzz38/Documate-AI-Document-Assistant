// api/utils/googleSearch.js
// SearXNG Academic Search — Simplified v4
// Same API, cleaner logic, robust defaults

import { GroqAPI } from './groqAPI.js';

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  instances: [
    'https://priv.au', 'https://search.sapti.me', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://searx.be', 'https://search.ononoki.org',
    'https://searxng.site', 'https://paulgo.io',
  ],
  bannedDomains: new Set([
    'reddit.com','quora.com','stackoverflow.com','youtube.com','tiktok.com',
    'instagram.com','facebook.com','twitter.com','x.com','amazon.com','ebay.com',
    'petmd.com','dogster.com','rover.com','thesprucepets.com',
  ]),
  bannedExts: new Set(['.jpg','.jpeg','.png','.gif','.webp','.svg','.mp4','.mp3']),
  // Academic domains with score bonuses
  academicDomains: {
    tier1: ['pubmed','ncbi','arxiv','nature','science','cell','pnas','bmj','lancet',
            'springer','wiley','tandfonline','sagepub','oup','cambridge','jstor',
            'frontiersin','mdpi','plos','royalsociety','sciencedirect','scholar.google',
            'researchgate','semanticscholar','crossref','biorxiv'],
    tier2: ['nih.gov','cdc.gov','who.int','mayoclinic','clevelandclinic',
            'britannica','wikipedia','sciencedaily','physoc','avma'],
  },
  blogSignals: ['blog','wordpress','medium.com','substack','hubpages','wixsite'],
  academicEngines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
  // Simple term → academic expansion map
  conceptMap: [
    [/\bpanting\b/i, 'thermoregulation evaporative cooling'],
    [/\b(ear|hearing)\b/i, 'auditory physiology frequency detection'],
    [/\b(smell|nose|olfactory)\b/i, 'olfactory receptor neuroscience'],
    [/\b(polic|rescue)\b/i, 'working dog K9 training'],
    [/\b(smart|intelligen)\w*\b/i, 'canine cognition problem-solving'],
    [/\b(fur|coat)\b/i, 'thermoregulation morphology'],
    [/\bwolf\b/i, 'canis lupus evolutionary'],
    [/\bbreed\b/i, 'breed morphology genetic'],
  ],
};

// ─── Public API (unchanged signature for compatibility) ──────────────────────
export const GoogleSearchAPI = {

  /**
   * Main search entry point.
   * @param {string} query    - Essay text or search query
   * @param {string} _apiKey  - Unused (API compat)
   * @param {string} _cx      - Unused (API compat)  
   * @param {string} groqKey  - Optional Groq API key for LLM features
   * @param {object} opts     - { timeRange: 'day'|'month'|'year'|null }
   */
  async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
    try {
      const { timeRange = null } = opts;
      
      // 1. Extract key terms (LLM or fallback)
      const entities = groqKey 
        ? await this._extractEntities(query, groqKey) 
        : this._simpleExtract(query);
      
      // 2. Build search queries (LLM or fallback)
      const queries = groqKey
        ? await this._buildQueries(query, entities, groqKey)
        : [this._fallbackQuery(query, entities)];
      
      // 3. Fetch results from SearXNG instances
      const raw = await this._fetchAll(queries, { timeRange });
      
      // 4. Score, filter, deduplicate
      const results = this._rankResults(raw, entities);
      
      // 5. Optional LLM relevance filter
      return groqKey && results.length > 0
        ? await this._llmFilter(results, query, entities, groqKey)
        : results;
        
    } catch (err) {
      console.error('[Search] Fatal error:', err.message);
      return []; // Fail gracefully
    }
  },

  // ─── Entity Extraction ─────────────────────────────────────────────────────
  
  async _extractEntities(text, groqKey) {
    const prompt = `Extract key entities from this text. Return JSON:
{"anchors":[2-4 specific names/topics],"concepts":[3-6 academic terms],"exclude":[1-3 off-topic terms]}

Text: ${text.substring(0, 600)}`;

    try {
      const res = await GroqAPI.chat([{role:'user', content:prompt}], groqKey, false);
      const json = res.match(/\{[\s\S]*\}/)?.[0];
      const parsed = JSON.parse(json);
      return {
        anchors: Array.isArray(parsed.anchors) ? parsed.anchors.slice(0,4) : [],
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts.slice(0,6) : [],
        exclude: Array.isArray(parsed.exclude) ? parsed.exclude.slice(0,3) : [],
      };
    } catch {
      return this._simpleExtract(text);
    }
  },

  _simpleExtract(text) {
    // Fallback: grab capitalized proper nouns + key academic terms
    const anchors = [...new Set(
      (text.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\b/g) || [])
        .filter(w => !['The','This','That','However','Furthermore'].includes(w))
    )].slice(0, 3);
    
    const concepts = CONFIG.conceptMap
      .filter(([re]) => re.test(text))
      .map(([,term]) => term)
      .slice(0, 4);
      
    return { anchors, concepts, exclude: [] };
  },

  // ─── Query Generation ──────────────────────────────────────────────────────
  
  async _buildQueries(text, entities, groqKey) {
    // Expand text with academic synonyms
    let expanded = text.substring(0, 1200);
    for (const [re, term] of CONFIG.conceptMap) {
      expanded = expanded.replace(re, `$& [${term}]`);
    }

    const prompt = `Generate 4 academic search queries. Format: [entity] + [mechanism] + [context]
Entities: ${entities.anchors.join(', ') || 'general'}
Concepts: ${entities.concepts.join(', ') || 'research'}
Avoid: ${entities.exclude.join(', ') || 'nothing'}

Text: ${expanded}

Return JSON array of 4-6 queries, 5-9 words each. Example:
["German Shepherd thermoregulation panting physiology study"]`;

    try {
      const res = await GroqAPI.chat([{role:'user', content:prompt}], groqKey, false);
      const arr = res.match(/\[[\s\S]*\]/)?.[0];
      const queries = JSON.parse(arr);
      return queries
        .filter(q => typeof q === 'string' && q.split(/\s+/).length >= 4)
        .map(q => q.trim().slice(0, 120))
        .slice(0, 6);
    } catch {
      return [this._fallbackQuery(text, entities)];
    }
  },

  _fallbackQuery(text, entities) {
    const parts = [...(entities.anchors || []), ...(entities.concepts || [])].slice(0, 4);
    if (parts.length >= 2) return parts.join(' ') + ' research';
    
    const words = text.toLowerCase().match(/\b[a-z]{6,}\b/g) || [];
    const meaningful = [...new Set(words)].filter(w => 
      !['people','things','often','very','just','make','take','get','used'].includes(w)
    ).slice(0, 4);
    
    return (meaningful.join(' ') || text.slice(0, 40)) + ' academic study';
  },

  // ─── Fetching ──────────────────────────────────────────────────────────────
  
  async _fetchAll(queries, opts) {
    const results = [];
    const seen = new Set();
    
    for (const query of queries) {
      for (const instance of CONFIG.instances) {
        try {
          const batch = await this._fetchInstance(instance, query, opts);
          for (const r of batch) {
            if (!seen.has(r.link) && this._isValidResult(r)) {
              results.push(r);
              seen.add(r.link);
            }
          }
          if (batch.length > 0) break; // Stop after first working instance
        } catch (e) {
          continue; // Try next instance
        }
      }
    }
    return results;
  },

  async _fetchInstance(url, query, { timeRange }) {
    // Try JSON API first
    const params = new URLSearchParams({
      q: query, format: 'json', categories: 'general,science',
      language: 'en', engines: CONFIG.academicEngines,
      ...(timeRange && { time_range: timeRange }),
    });
    
    try {
      const res = await fetch(`${url}/search?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      
      if (res.ok && res.headers.get('content-type')?.includes('json')) {
        const data = await res.json();
        return (data.results || []).map(r => ({
          title: r.title || '', link: r.url || '', 
          snippet: r.content || r.snippet || '', engine: r.engine || '',
        })).filter(r => r.title && r.link);
      }
    } catch {}
    
    // Fallback: minimal HTML parse (simplified)
    try {
      const res = await fetch(`${url}/search?${new URLSearchParams({q:query, language:'en'})}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      const html = await res.text();
      return this._parseMinimal(html);
    } catch {
      return [];
    }
  },

  _parseMinimal(html) {
    // Ultra-simple regex extraction for fallback
    const results = [];
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,300}?<p[^>]*>([^<]*)/gi;
    let m;
    while ((m = re.exec(html)) && results.length < 20) {
      const [, link, title, snippet] = m;
      if (title && !link.includes('searx')) {
        results.push({
          title: title.replace(/<[^>]+>/g, '').trim(),
          link, snippet: (snippet || '').replace(/<[^>]+>/g, '').trim(),
          engine: 'html',
        });
      }
    }
    return results;
  },

  _isValidResult(r) {
    if (!r.title || !r.link) return false;
    const link = r.link.toLowerCase();
    if (CONFIG.bannedExts.has(link.match(/\.[^.]+$/)?.[0])) return false;
    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
    if (CONFIG.bannedDomains.has(domain)) return false;
    return true;
  },

  // ─── Scoring & Ranking ─────────────────────────────────────────────────────
  
  _rankResults(results, entities) {
    const domainCounts = new Map();
    
    return results
      .map(r => {
        let score = 0;
        const text = `${r.title} ${r.snippet}`.toLowerCase();
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        
        // Domain tier bonuses
        if (CONFIG.academicDomains.tier1.some(p => domain.includes(p))) score += 12;
        else if (CONFIG.academicDomains.tier2.some(p => domain.includes(p))) score += 7;
        else if (domain.endsWith('.edu')) score += 8;
        else if (domain.endsWith('.gov')) score += 6;
        else if (domain.endsWith('.org')) score += 2;
        
        // Penalties
        if (CONFIG.blogSignals.some(s => domain.includes(s))) score -= 6;
        if (r.title.length < 8) score -= 3;
        
        // Entity matching bonus
        const anchorMatches = entities.anchors?.filter(a => 
          text.includes(a.toLowerCase())
        ).length || 0;
        score += anchorMatches * 3;
        
        // Off-topic penalty
        const excludeMatches = entities.exclude?.filter(e => 
          text.includes(e.toLowerCase())
        ).length || 0;
        score -= excludeMatches * 4;
        
        return { ...r, _score: score + (r.score || 0) };
      })
      // Dedupe by domain limits
      .filter(r => {
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        const isTier1 = CONFIG.academicDomains.tier1.some(p => domain.includes(p));
        const isTier2 = CONFIG.academicDomains.tier2.some(p => domain.includes(p));
        const limit = isTier1 ? 3 : isTier2 ? 2 : 1;
        const count = domainCounts.get(domain) || 0;
        if (count >= limit) return false;
        domainCounts.set(domain, count + 1);
        return true;
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 15) // Return top 15
      .map(({ _score, ...r }) => r); // Remove internal score
  },

  // ─── Optional LLM Relevance Filter ─────────────────────────────────────────
  
  async _llmFilter(results, query, entities, groqKey) {
    if (!groqKey || results.length === 0) return results;
    
    const list = results.map((r, i) => 
      `[${i}] ${r.title}\n    ${(r.snippet||'').slice(0,150)}`
    ).join('\n');
    
    const prompt = `Filter these results for relevance to the essay.
Essay: ${query.slice(0, 400)}
Key terms: ${[...(entities.anchors||[]), ...(entities.concepts||[])].join(', ')}
Avoid: ${entities.exclude?.join(', ') || 'nothing'}

Results:
${list}

Return JSON array of indices to KEEP. Only keep results that:
- Directly support a claim or entity in the essay
- Are academic/authoritative sources
- Are not generic content or off-topic

Return: [0, 2, 4]`;

    try {
      const res = await GroqAPI.chat([{role:'user', content:prompt}], groqKey, false);
      const arr = res.match(/\[[\s\S]*\]/)?.[0];
      const indices = JSON.parse(arr);
      
      const kept = indices.filter(i => Number.isInteger(i) && results[i])
        .map(i => results[i]);
      
      // Safety: never return fewer than 3 results
      return kept.length >= 3 ? kept : results.slice(0, Math.max(kept.length, 3));
    } catch {
      return results; // Fail open
    }
  },

  // ─── Utilities ─────────────────────────────────────────────────────────────
  
  getInstanceStatus() {
    // Simple diagnostic: return instance list
    return { instances: CONFIG.instances.length, available: 'dynamic' };
  },
};
