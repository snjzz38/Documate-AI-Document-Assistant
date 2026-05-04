// api/utils/googleSearch.js
// Academic Search — Humanities/Literature Optimized (v4.1)
// Same API. Fixed for literary analysis queries.

import { GroqAPI } from './groqAPI.js';

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  instances: [
    'https://priv.au', 'https://search.sapti.me', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://searx.be', 'https://search.ononoki.org',
    'https://searxng.site', 'https://paulgo.io',
  ],
  
  // ❌ BAN essay mills & low-quality sources
  bannedDomains: new Set([
    'reddit.com','quora.com','stackoverflow.com','youtube.com','tiktok.com',
    'instagram.com','facebook.com','twitter.com','x.com','amazon.com','ebay.com',
    // Essay mills & student paper sites
    '123helpme.com','scribd.com','ukessays.com','kibin.com','studycorgi.com',
    'coursehero.com','chegg.com','bartleby.com','ipl.org','prezi.com',
    'aithor.com','essaypro.com','paperdue.com','studymode.com',
  ]),
  
  bannedExts: new Set(['.jpg','.jpeg','.png','.gif','.webp','.svg','.mp4','.mp3','.pdf']),
  
  // ✅ ACADEMIC DOMAINS — Humanities-focused
  academicDomains: {
    tier1: [
      // Literary/Humanities databases
      'jstor.org','projectmuse.edu','mla.org','cambridge.org','oup.com',
      'tandfonline.com','sagepub.com','wiley.com','springer.com','palgrave.com',
      // University presses
      'upenn.edu','press.uchicago.edu','hup.harvard.edu','yalebooks.yale.edu',
      // Literature-specific
      'literature.org','poetryfoundation.org','modernlanguages.org',
      // General academic (keep some science for cross-disciplinary)
      'arxiv.org','semanticscholar.org','crossref.org','researchgate.net',
    ],
    tier2: [
      'wikipedia.org','britannica.com','plato.stanford.edu','iep.utm.edu',
      'poets.org','theparisreview.org','newyorker.com','lrb.co.uk',
    ],
  },
  
  blogSignals: ['blog','wordpress','medium.com','substack','wixsite'],
  academicEngines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
  
  // ✅ LITERARY CONCEPT MAP — maps surface terms → academic literary terms
  conceptMap: [
    [/\btension\b|\bconflict\b/i, 'dramatic tension character conflict'],
    [/\bcontempt\b|\bdegrading\b/i, 'power dynamics patriarchal critique'],
    [/\bmetaphor\b|\bsymbolism\b/i, 'literary symbolism thematic imagery'],
    [/\birony\b|\bdramatic irony\b/i, 'dramatic irony theatrical device'],
    [/\bdiction\b|\bword choice\b/i, 'linguistic register stylistic diction'],
    [/\bfreedom\b|\bautonomy\b/i, 'female agency self-determination'],
    [/\bdomestic\b|\bhousehold\b/i, 'domestic sphere gender roles'],
    [/\babandon\b|\bdeparture\b/i, 'narrative resolution character arc'],
    [/\bconstruct\b|\bportray\b/i, 'authorial technique narrative strategy'],
  ],
};

// ─── Public API (unchanged) ──────────────────────────────────────────────────
export const GoogleSearchAPI = {

  async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
    try {
      const { timeRange = null } = opts;
      
      // 1. Extract entities (LLM or fallback)
      const entities = groqKey 
        ? await this._extractEntities(query, groqKey) 
        : this._simpleExtract(query);
      
      // 2. Build queries tuned for literary analysis
      const queries = groqKey
        ? await this._buildQueries(query, entities, groqKey)
        : [this._fallbackQuery(query, entities)];
      
      // 3. Fetch results
      const raw = await this._fetchAll(queries, { timeRange });
      
      // 4. Score & filter with humanities-aware ranking
      return this._rankResults(raw, entities);
      
    } catch (err) {
      console.error('[Search] Error:', err.message);
      return [];
    }
  },

  // ─── Entity Extraction (simplified for literary text) ──────────────────────
  
  async _extractEntities(text, groqKey) {
    const prompt = `Extract key literary analysis entities. Return JSON:
{"anchors":[2-4: character names, author, play title, key themes],
 "concepts":[3-6: literary devices, critical frameworks],
 "exclude":[1-2: off-topic terms]}

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
    // Extract: capitalized proper nouns (characters, authors) + literary terms
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

  // ─── Query Generation for Literary Analysis ────────────────────────────────
  
  async _buildQueries(text, entities, groqKey) {
    // Expand with academic literary terms
    let expanded = text.substring(0, 1200);
    for (const [re, term] of CONFIG.conceptMap) {
      expanded = expanded.replace(re, `$& [${term}]`);
    }

    const prompt = `Generate 4 academic search queries for literary analysis.
Format: [work/author] + [literary device/theme] + [critical framework]

Key terms: ${[...entities.anchors, ...entities.concepts].join(', ') || 'literary analysis'}
Avoid: ${entities.exclude.join(', ') || 'nothing'}

Text: ${expanded}

Return JSON array of 4 queries, 5-8 words each. Examples:
["Ibsen Doll's House dramatic irony feminist reading",
 "Nora Helmer agency domestic sphere criticism",
 "A Doll's House diction power dynamics analysis"]`;

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
    // Build query from anchors + concepts
    const parts = [...(entities.anchors || []), ...(entities.concepts || [])]
      .filter(p => p && p.length > 2)
      .slice(0, 5);
    
    if (parts.length >= 2) return parts.join(' ') + ' literary criticism';
    
    // Fallback: grab key terms from text
    const words = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
    const meaningful = [...new Set(words)].filter(w => 
      !['people','things','often','very','just','make','take','get','used','house','play'].includes(w)
    ).slice(0, 4);
    
    return (meaningful.join(' ') || text.slice(0, 40)) + ' academic analysis';
  },

  // ─── Fetching (unchanged from simplified version) ──────────────────────────
  
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
          if (batch.length > 2) break; // Stop after first good instance
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
    
    // Bonus: prefer .edu, .ac.uk, known academic TLDs
    return true;
  },

  // ─── Humanities-Aware Scoring ──────────────────────────────────────────────
  
  _rankResults(results, entities) {
    const domainCounts = new Map();
    
    return results
      .map(r => {
        let score = 0;
        const text = `${r.title} ${r.snippet}`.toLowerCase();
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        
        // Domain bonuses — humanities-focused
        if (CONFIG.academicDomains.tier1.some(p => domain.includes(p))) score += 12;
        else if (CONFIG.academicDomains.tier2.some(p => domain.includes(p))) score += 7;
        else if (/\.(edu|ac\.uk|edu\.au|edu\.ca)$/i.test(domain)) score += 9;
        else if (domain.endsWith('.org')) score += 3;
        
        // Penalties
        if (CONFIG.blogSignals.some(s => domain.includes(s))) score -= 5;
        if (r.title.toLowerCase().includes('essay') || r.title.toLowerCase().includes('help')) score -= 4;
        if (r.title.length < 10) score -= 3;
        
        // Entity matching (critical for literary queries)
        const anchorMatches = entities.anchors?.filter(a => 
          text.includes(a.toLowerCase())
        ).length || 0;
        score += anchorMatches * 4; // Higher weight for literary precision
        
        // Off-topic penalty
        const excludeMatches = entities.exclude?.filter(e => 
          text.includes(e.toLowerCase())
        ).length || 0;
        score -= excludeMatches * 5;
        
        return { ...r, _score: score + (r.score || 0) };
      })
      // Dedupe with domain limits
      .filter(r => {
        const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
        const isTier1 = CONFIG.academicDomains.tier1.some(p => domain.includes(p));
        const limit = isTier1 ? 4 : 2;
        const count = domainCounts.get(domain) || 0;
        if (count >= limit) return false;
        domainCounts.set(domain, count + 1);
        return true;
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 12)
      .map(({ _score, ...r }) => r);
  },
};
