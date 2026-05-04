// api/utils/googleSearch.js
// Academic Search — Flexible Relevance Architecture (v5)
// Same API. No hardcoded domain lists. LLM-driven relevance when available.

import { GroqAPI } from './groqAPI.js';

const CONFIG = {
  instances: [
    'https://priv.au', 'https://search.sapti.me', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://searx.be', 'https://search.ononoki.org',
    'https://searxng.site', 'https://paulgo.io',
  ],
  
  // 🚫 ONLY ban truly toxic sources (not "non-preferred")
  bannedDomains: new Set([
    'reddit.com','quora.com','youtube.com','tiktok.com','instagram.com',
    'facebook.com','twitter.com','x.com','amazon.com','ebay.com',
    // Essay mills & student paper resellers
    '123helpme.com','scribd.com','ukessays.com','kibin.com','studycorgi.com',
    'coursehero.com','chegg.com','bartleby.com','essaypro.com','aithor.com',
  ]),
  
  bannedExts: new Set(['.jpg','.jpeg','.png','.gif','.webp','.svg','.mp4','.mp3']),
  
  // ✅ SOFT domain signals (bonus, not requirement)
  academicSignals: [
    'jstor.org','projectmuse','cambridge.org','oup.com','tandfonline.com',
    'sagepub.com','wiley.com','springer.com','arxiv.org','semanticscholar.org',
    'crossref.org','researchgate.net','academia.edu','mla.org',
  ],
  
  blogSignals: ['blog','wordpress','medium.com','substack','wixsite'],
  academicEngines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
  
  // 🎭 Context-agnostic concept expansion (works for any subject)
  conceptMap: [
    [/\b(tension|conflict)\b/i, 'dramatic tension thematic conflict'],
    [/\b(contempt|degrading)\b/i, 'power dynamics critical perspective'],
    [/\b(metaphor|symbolism)\b/i, 'literary symbolism figurative language'],
    [/\b(irony|dramatic)\b/i, 'dramatic irony narrative technique'],
    [/\b(diction|word choice)\b/i, 'linguistic register stylistic choice'],
    [/\b(freedom|autonomy)\b/i, 'agency self-determination thematic'],
    [/\b(domestic|household)\b/i, 'domestic sphere social context'],
    [/\b(construct|portray)\b/i, 'authorial technique narrative strategy'],
  ],
};

export const GoogleSearchAPI = {

  async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
    try {
      const { timeRange = null } = opts;
      
      // 1. Extract entities (LLM or fallback)
      const entities = groqKey 
        ? await this._extractEntities(query, groqKey) 
        : this._simpleExtract(query);
      
      // 2. Build queries (LLM or fallback)
      const queries = groqKey
        ? await this._buildQueries(query, entities, groqKey)
        : [this._fallbackQuery(query, entities)];
      
      // 3. Fetch broadly from SearXNG
      const raw = await this._fetchAll(queries, { timeRange });
      
      // 4. Score with lightweight heuristics (always runs)
      const scored = this._scoreResults(raw, entities);
      
      // 5. OPTIONAL: LLM relevance pass (only if groqKey + enough results)
      if (groqKey && scored.length >= 5) {
        const filtered = await this._llmRelevance(scored, query, entities, groqKey);
        // Safety: never return fewer than 3
        return filtered.length >= 3 ? filtered : scored.slice(0, Math.max(filtered.length, 3));
      }
      
      // 6. Return heuristic-scored results (fallback path)
      return scored.slice(0, 12);
      
    } catch (err) {
      console.error('[Search] Fatal:', err.message);
      return []; // Always return valid array
    }
  },

  // ─── Entity Extraction (context-agnostic) ─────────────────────────────────
  
  async _extractEntities(text, groqKey) {
    const prompt = `Extract key entities for academic search. Return JSON:
{"anchors":[2-4: specific names, works, concepts],"concepts":[3-6: analytical terms],"exclude":[1-2: off-topic]}

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
    const anchors = [...new Set(
      (text.match(/\b[A-Z][a-z]+(?:\s+[A-Z]?[a-z]+)*\b/g) || [])
        .filter(w => !['The','This','That','However','In','By','And'].includes(w))
        .filter(w => w.length > 3)
    )].slice(0, 4);
    
    const concepts = CONFIG.conceptMap
      .filter(([re]) => re.test(text))
      .map(([,term]) => term)
      .slice(0, 5);
      
    return { anchors, concepts, exclude: [] };
  },

  // ─── Query Generation (flexible structure) ────────────────────────────────
  
  async _buildQueries(text, entities, groqKey) {
    let expanded = text.substring(0, 1200);
    for (const [re, term] of CONFIG.conceptMap) {
      expanded = expanded.replace(re, `$& [${term}]`);
    }

    const prompt = `Generate 4 academic search queries. Format: [topic] + [analytical lens] + [context]

Key terms: ${[...entities.anchors, ...entities.concepts].join(', ') || 'academic analysis'}
Avoid: ${entities.exclude.join(', ') || 'nothing'}

Text: ${expanded}

Return JSON array of 4 queries, 5-8 words each. Examples:
["Ibsen Doll's House dramatic irony feminist reading",
 "Nora Helmer agency domestic sphere criticism"]`;

    try {
      const res = await GroqAPI.chat([{role:'user', content:prompt}], groqKey, false);
      const arr = res.match(/\[[\s\S]*\]/)?.[0];
      const queries = JSON.parse(arr);
      return queries
        .filter(q => typeof q === 'string' && q.split(/\s+/).length >= 4)
        .map(q => q.trim().slice(0, 120))
        .slice(0, 5);
    } catch {
      return [this._fallbackQuery(text, entities)];
    }
  },

  _fallbackQuery(text, entities) {
    const parts = [...(entities.anchors || []), ...(entities.concepts || [])]
      .filter(p => p && p.length > 2)
      .slice(0, 5);
    
    if (parts.length >= 2) return parts.join(' ') + ' academic analysis';
    
    const words = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
    const meaningful = [...new Set(words)].filter(w => 
      !['people','things','often','very','just','make','take','get','used'].includes(w)
    ).slice(0, 4);
    
    return (meaningful.join(' ') || text.slice(0, 40)) + ' scholarly source';
  },

  // ─── Fetching (minimal filtering) ─────────────────────────────────────────
  
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
          if (batch.length >= 3) break; // Stop after first decent instance
        } catch { continue; }
      }
    }
    return results;
  },

  async _fetchInstance(url, query, { timeRange }) {
    const params = new URLSearchParams({
      q: query, format: 'json', categories: 'general,science',
      language: 'en', engines: CONFIG.academicEngines,
      ...(timeRange && { time_range: timeRange }),
    });
    
    try {
      const res = await fetch(`${url}/search?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
      });
      
      if (res.ok && res.headers.get('content-type')?.includes('json')) {
        const data = await res.json();
        return (data.results || []).map(r => ({
          title: r.title || '', link: r.url || '', 
          snippet: r.content || r.snippet || '', engine: r.engine || '',
        })).filter(r => r.title && r.link);
      }
    } catch {}
    return [];
  },

  _isValidResult(r) {
    if (!r.title || !r.link) return false;
    const link = r.link.toLowerCase();
    if (CONFIG.bannedExts.has(link.match(/\.[^.]+$/)?.[0])) return false;
    
    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
    if (CONFIG.bannedDomains.has(domain)) return false;
    
    return true; // Allow everything else through — LLM will filter
  },

  // ─── Lightweight Heuristic Scoring (no LLM) ───────────────────────────────
  
  _scoreResults(results, entities) {
    const domainCounts = new Map();
    
    return results
      .map(r => {
        let score = 0;
        const text = `${r.title} ${r.snippet}`.toLowerCase();
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        
        // 🎯 SOFT academic bonus (not requirement)
        if (CONFIG.academicSignals.some(p => domain.includes(p))) score += 8;
        else if (/\.(edu|ac\.uk|edu\.au|edu\.ca)$/i.test(domain)) score += 6;
        else if (domain.endsWith('.org')) score += 2;
        
        // 🚫 Penalties for low-quality signals
        if (CONFIG.blogSignals.some(s => domain.includes(s))) score -= 4;
        if (/\b(essay|help|free|sample|download)\b/i.test(r.title)) score -= 3;
        if (r.title.length < 8) score -= 2;
        
        // 🎯 Entity matching (critical for relevance)
        const anchorMatches = entities.anchors?.filter(a => 
          text.includes(a.toLowerCase())
        ).length || 0;
        score += anchorMatches * 3;
        
        // 🎯 Concept alignment bonus
        const conceptMatches = entities.concepts?.filter(c => 
          text.includes(c.split(' ')[0]) // Check first word of concept
        ).length || 0;
        score += conceptMatches * 2;
        
        // 🚫 Off-topic penalty
        const excludeMatches = entities.exclude?.filter(e => 
          text.includes(e.toLowerCase())
        ).length || 0;
        score -= excludeMatches * 4;
        
        return { ...r, _score: score + (r.score || 0) };
      })
      // Dedupe with soft domain limits
      .filter(r => {
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        const isAcademic = CONFIG.academicSignals.some(p => domain.includes(p)) || 
                          /\.(edu|ac\.uk)$/i.test(domain);
        const limit = isAcademic ? 3 : 1;
        const count = domainCounts.get(domain) || 0;
        if (count >= limit) return false;
        domainCounts.set(domain, count + 1);
        return true;
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 15) // Keep top 15 for potential LLM filtering
      .map(({ _score, ...r }) => r);
  },

  // ─── LLM Relevance Pass (the smart filter) ────────────────────────────────
  
  async _llmRelevance(results, query, entities, groqKey) {
    if (!groqKey || results.length === 0) return results;
    
    // Format results for LLM: concise but informative
    const summaries = results.map((r, i) => 
      `[${i}] "${r.title}"\n    ${(r.snippet||'').slice(0,160)}\n    Source: ${new URL(r.link).hostname}`
    ).join('\n\n');
    
    const prompt = `You are an academic research assistant. Filter these search results for relevance to the essay query.

ESSAY QUERY:
"""
${query.substring(0, 500)}
"""

KEY ENTITIES: ${entities.anchors.join(', ') || 'N/A'}
ANALYTICAL CONCEPTS: ${entities.concepts.join(', ') || 'N/A'}
OFF-TOPIC: ${entities.exclude.join(', ') || 'N/A'}

SEARCH RESULTS:
${summaries}

INSTRUCTIONS:
Return a JSON array of indices to KEEP. Keep a result ONLY if:
✓ It directly addresses a claim, entity, or analytical concept from the query
✓ It could plausibly be cited as an academic source for this essay
✓ It provides substantive analysis, not just summary or opinion

Reject if:
✗ It matches keywords but misses the analytical focus
✗ It covers a different work, author, or context
✗ It is generic study help, essay mill content, or non-academic commentary
✗ The anchor entities appear only in acronyms or unrelated contexts

Return ONLY a raw JSON array of indices, e.g. [0, 2, 4]:`;

    try {
      const res = await GroqAPI.chat([{role:'user', content:prompt}], groqKey, false);
      const arr = res.match(/\[[\s\S]*\]/)?.[0];
      const indices = JSON.parse(arr);
      
      if (!Array.isArray(indices)) throw new Error('Invalid response');
      
      const kept = indices
        .filter(i => Number.isInteger(i) && i >= 0 && i < results.length)
        .map(i => results[i]);
      
      // Safety: never return fewer than 3 results
      return kept.length >= 3 ? kept : results.slice(0, Math.max(kept.length, 3));
      
    } catch (e) {
      console.warn('[Search] LLM filter failed:', e.message);
      return results; // Fail open to heuristic results
    }
  },
};
