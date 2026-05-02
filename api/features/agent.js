// api/features/agent.js
import { GeminiAPI } from '../utils/geminiAPI.js';
import { GroqAPI } from '../utils/groqAPI.js';
import { SourceFinderAPI } from '../utils/sourceFinder.js';
import { GoogleSearchAPI } from '../utils/googleSearch.js';
import { Coordinator } from '../utils/coordinator.js'; // ← NEW
import humanizerHandler from './humanizer.js';
import graderHandler from './grader.js';

// ============================================================================
// IMPROVED HELPER FUNCTIONS (more robust, better edge-case handling)
// ============================================================================

const stripMarkdown = t => {
  if (!t) return '';
  return t
    // Handle nested bold/italic more safely
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // Headers → plain text (preserve content)
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')
    // Code blocks → inline code markers removed
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Links: keep text, drop URL
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Images: remove entirely
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Blockquotes
    .replace(/^>\s*/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Clean up extra whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const stripRefs = t => {
  if (!t) return '';
  return t
    // Remove bibliography sections with various headers
    .replace(/\n\n\*?\*?(?:References|Works Cited|Bibliography|Sources|Citations)\*?\*?[\s\S]*$/i, '')
    // Remove "Retrieved from" lines
    .replace(/\n\s*Retrieved from\s+https?:\/\/[^\s\n]+/gi, '')
    // Remove DOI-only lines
    .replace(/\n\s*https?:\/\/doi\.org\/[^\s\n]+/gi, '')
    .trim();
};

const extractTopic = text => {
  if (!text) return '';
  
  // First: try to extract quoted topic
  const quotedMatch = text.match(/(?:about|essay on|write about|discuss|analyze)[:\s]+["']([^"']{10,120})["']/i);
  if (quotedMatch) return quotedMatch[1].trim();
  
  // Second: try pattern-based extraction
  const patternMatch = text.match(/(?:about|essay on|write about|discuss|analyze)[:\s]+([^"'\n.!?]{15,100})/i);
  if (patternMatch) {
    const candidate = patternMatch[1].trim();
    // Reject if it's just generic words
    if (!/^(the|a|an|my|your|this|that)$/i.test(candidate.split(' ')[0])) {
      return candidate;
    }
  }
  
  // Fallback: extract meaningful words
  const skip = new Set([
    'write','essay','paragraph','summary','discuss','explain','please','about',
    'using','citations','help','me','i','need','want','can','you','make','create'
  ]);
  
  const words = (text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
    .filter(w => !skip.has(w) && !/^(the|this|that|with|from|have|will|would|could|should)/.test(w));
  
  const unique = [...new Set(words)];
  const topic = unique.slice(0, 6).join(' ');
  
  return topic || text.substring(0, 100).replace(/[^\w\s]/g, '').trim();
};

const fmtAuthor = (s, style = 'apa') => {
  if (!s) return 'Unknown';
  
  const authors = s.authors?.filter(a => a?.family?.length > 1) || [];
  
  if (authors.length === 0) {
    return s.author || s.displayName || 'Unknown';
  }
  
  const formatName = (a, isMla) => {
    if (!a?.family) return '';
    return isMla && a.given 
      ? `${a.family}, ${a.given}` 
      : a.family;
  };
  
  const isMla = style.includes('mla');
  
  if (authors.length === 1) {
    return formatName(authors[0], isMla) || s.author || 'Unknown';
  } else if (authors.length === 2) {
    const sep = isMla ? ' and ' : ' & ';
    return `${formatName(authors[0], isMla)}${sep}${formatName(authors[1], isMla)}`;
  } else {
    // 3+ authors: first + et al.
    return `${formatName(authors[0], isMla)} et al.`;
  }
};

// ============================================================================
// HTML RENDERING (with better sanitization)
// ============================================================================

const renderEntry = (plainCitation, source) => {
  if (!plainCitation) return '';
  
  const journal = source.venue || '';
  const doiUrl = source.doi ? `https://doi.org/${source.doi}` : '';
  
  let text = plainCitation;
  
  // Mark journal for italics (before escaping)
  if (journal) {
    const escaped = journal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b(${escaped})\\b`, 'i'), '\x00I\x00$1\x00/I\x00');
  }
  
  // Mark DOI URL for linking
  if (doiUrl) {
    const escaped = doiUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'g'), '\x00A\x00' + doiUrl + '\x00/A\x00');
  }
  
  // Escape HTML entities FIRST
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  
  // Restore our custom tags
  text = text
    .replace(/\x00I\x00/g, '<i>')
    .replace(/\x00\/I\x00/g, '</i>')
    .replace(/\x00A\x00/g, `<a href="${doiUrl}" target="_blank" rel="noopener">`)
    .replace(/\x00\/A\x00/g, '</a>');
  
  return text;
};

const buildBibliographyHTML = (sources, style, type, insertionOrder = null) => {
  if (!sources?.length) return { html: '', plain: '' };
  
  const isApa = style.includes('apa');
  const isMla = style.includes('mla');
  const title = type === 'footnotes' 
    ? 'Notes' 
    : isMla ? 'Works Cited' : isApa ? 'References' : 'Bibliography';
  
  // Sort: footnotes keep insertion order, others alphabetize by author
  const sorted = type === 'footnotes'
    ? (insertionOrder || sources)
    : [...sources].sort((a, b) => {
        const ka = (a.authors?.[0]?.family || a.author || 'zzz').toLowerCase();
        const kb = (b.authors?.[0]?.family || b.author || 'zzz').toLowerCase();
        return ka.localeCompare(kb);
      });
  
  // CSS styles (could be externalized later)
  const wrapStyle = "font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 2; color: #000; background: #fff; padding: 20px;";
  const titleStyle = "text-align: center; margin-bottom: 24px; font-weight: 600; font-family: 'Times New Roman', Times, serif; font-size: 12pt;";
  const entryStyle = "text-indent: -36px; padding-left: 36px; margin: 0 0 24px 0; line-height: 2; font-family: 'Times New Roman', Times, serif; font-size: 12pt; color: #000;";
  
  let html = `<div class="bibliography" style="${wrapStyle}">`;
  html += `<p style="${titleStyle}">${title}</p>`;
  let plain = `${title}\n\n`;
  
  sorted.forEach((s, i) => {
    const citationPlain = s.citation || `${fmtAuthor(s, style)} (${s.year || 'n.d.'}). ${s.title || 'Untitled'}.`;
    const citationHtml = renderEntry(citationPlain, s);
    const num = i + 1;
    
    if (type === 'footnotes') {
      html += `<p style="${entryStyle}">${num}. ${citationHtml}</p>`;
      plain += `${num}. ${citationPlain}\n\n`;
    } else {
      html += `<p style="${entryStyle}">${citationHtml}</p>`;
      plain += `${citationPlain}\n\n`;
    }
  });
  
  html += `</div>`;
  return { html, plain };
};

const buildEssayHTML = text => {
  if (!text) return '<i>No output.</i>';
  
  // Check if text already contains HTML tags from prior processing
  const hasHtml = /<(sup|em|strong|i|b|a\s+href)[^>]*>/i.test(text);
  
  const wrapOpen = `<div style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 2; color: #000;">`;
  const wrapClose = `</div>`;
  const paragraphStyle = 'margin:0 0 0 0; text-indent:36px;';
  
  if (hasHtml) {
    // Already has HTML — wrap paragraphs without re-escaping
    return wrapOpen +
      text.split(/\n\n+/).filter(p => p.trim()).map(p =>
        `<p style="${paragraphStyle}">${p.replace(/\n/g, '<br>')}</p>`
      ).join('\n') +
      wrapClose;
  }
  
  // Plain text — escape safely then wrap
  return wrapOpen +
    text.split(/\n\n+/).filter(p => p.trim()).map(p => {
      const escaped = p
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      return `<p style="${paragraphStyle}">${escaped}</p>`;
    }).join('\n') +
    wrapClose;
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  try {
    const { action, task, options = {} } = req.body;
    const GEMINI = process.env.GEMINI_API_KEY;
    const GROQ = process.env.GROQ_API_KEY; // ← Prefer Groq for coordination
    
    // ========================================================================
    // ACTION: PLAN
    // ========================================================================
    if (action === 'plan') {
      const steps = [{ tool: 'RESEARCH', action: 'Find academic sources' }];
      
      if (options.enableWrite !== false) {
        steps.push({ tool: 'WRITE', action: 'Write essay' });
        steps.push({ tool: 'REFINE', action: 'Strengthen argument' });
      }
      if (options.enableHumanize) steps.push({ tool: 'HUMANIZE', action: 'Humanize text' });
      if (options.enableCite) steps.push({ tool: 'CITE', action: `Add ${options.citationType || 'in-text'} citations` });
      if (options.enableQuotes) steps.push({ tool: 'QUOTES', action: 'Insert quotes with transitions' });
      steps.push({ tool: 'PROOFREAD', action: 'Polish and improve' });
      if (options.enableGrade) steps.push({ tool: 'GRADE', action: 'Grade work' });
      
      return res.status(200).json({ success: true, plan: { steps } });
    }
    
    // ========================================================================
    // ACTION: EXECUTE_STEP
    // ========================================================================
    if (action === 'execute_step') {
      const { step, context = {}, options = {} } = req.body;
      const result = { success: true, output: '', type: 'text' };
      
      // ← NEW: Initialize Coordinator for this request
      const userTask = context.task || task || '';
      const coord = new Coordinator(userTask, {
        apiKey: GEMINI,
        groqKey: GROQ // ← Use cheaper Groq for coordination
      });
      
      // Run coordination phases if not already done
      if (!context.coordinatorInitialized) {
        await coord.refineInstructions(); // Clarify ambiguous tasks
        
        // If we have research sources, extract structured facts
        if (context.researchSources?.length > 0) {
          await coord.extractSourceFacts(context.researchSources);
        }
        
        context.coordinatorInitialized = true;
      }
      
      // Merge coordinator context into step context
      const enrichedContext = {
        ...context,
        ...coord.getContext(), // Adds: refinedTask, extractedFacts, keyEntities, etc.
      };
      
      // ======================================================================
      // STEP: RESEARCH
      // ======================================================================
      if (step.tool?.toUpperCase() === 'RESEARCH') {
        const topic = extractTopic(enrichedContext.refinedTask || enrichedContext.task || '');
        const style = options.citationStyle || 'apa7';
        const searchMode = options.searchMode || 'hybrid'; // academic | web | hybrid
        
        console.log('[Agent] Research:', { topic, style, mode: searchMode });
        
        let papers = [];
        
        // Hybrid search: combine academic + web sources
        if (searchMode === 'academic') {
          papers = await SourceFinderAPI.searchTopic(topic, 12, style);
        } else if (searchMode === 'web') {
          const webResults = await GoogleSearchAPI.search(topic, null, null, GROQ);
          papers = webResults.map((w, i) => ({
            id: `web-${i}`,
            title: w.title, url: w.link, doi: null,
            venue: w.link.match(/https?:\/\/(?:www\.)?([^/]+)/)?.[1] || 'Web Source',
            author: 'Unknown', authors: [],
            year: w.snippet?.match(/\b(19|20)\d{2}\b/)?.[0] || 'n.d.',
            displayName: 'Web Source',
            text: w.snippet || '', abstract: w.snippet || '',
            citation: `${w.title}. (${w.snippet?.match(/\b(19|20)\d{2}\b/)?.[0] || 'n.d.'}). Retrieved from ${w.link}`,
            citationSource: 'web', sourceType: 'web'
          }));
        } else {
          // Hybrid: fetch both, merge, dedupe
          const [academic, web] = await Promise.all([
            SourceFinderAPI.searchTopic(topic, 8, style).catch(() => []),
            GoogleSearchAPI.search(topic, null, null, GROQ).catch(() => [])
          ]);
          
          const webNormalized = web.slice(0, 4).map((w, i) => ({
            id: `web-${i}`, title: w.title, url: w.link, doi: null,
            venue: w.link.match(/https?:\/\/(?:www\.)?([^/]+)/)?.[1] || 'Web Source',
            author: 'Unknown', authors: [], year: 'n.d.',
            displayName: 'Web Source', text: w.snippet || '', abstract: w.snippet || '',
            citation: `${w.title}. Retrieved from ${w.link}`,
            citationSource: 'web', sourceType: 'web'
          }));
          
          // Dedupe by URL/DOI
          const seen = new Set();
          papers = [...academic, ...webNormalized].filter(p => {
            const key = p.doi || p.url;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        
        // ← NEW: Extract structured facts from research results using Groq
        if (papers?.length > 0) {
          await coord.extractSourceFacts(papers);
        }
        
        if (!papers?.length) {
          result.output = { sources: [], message: 'No relevant sources found. Try broadening your search terms.' };
          result.type = 'research';
          coord.recordStepOutput('RESEARCH', { count: 0, status: 'empty' });
          return res.status(200).json(result);
        }
        
        // Map to expected format
        const sources = papers.map((p, i) => ({
          id: i + 1,
          title: p.title || 'Untitled',
          url: p.url,
          doi: p.doi,
          venue: p.venue,
          author: p.author,
          authors: p.authors || [],
          year: p.year || 'n.d.',
          displayName: p.author || p.displayName || 'Unknown',
          text: p.abstract || p.text || '',
          citation: p.citation || null,
          citationSource: p.citationSource || 'unknown',
          sourceType: p.sourceType || 'academic',
          volume: p.volume || null,
          issue: p.issue || null,
          pages: p.pages || null
        }));
        
        console.log('[Agent] RESEARCH complete:', sources.length, 'sources');
        
        result.output = { sources };
        result.type = 'research';
        
        // Record completion
        coord.recordStepOutput('RESEARCH', { 
          count: sources.length, 
          academic: sources.filter(s => s.sourceType === 'academic').length,
          status: 'success'
        });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: WRITE
      // ======================================================================
      if (step.tool?.toUpperCase() === 'WRITE') {
        const { researchSources = [], uploadedFiles = [] } = enrichedContext;
        const userTask = enrichedContext.refinedTask || enrichedContext.task || '';
        
        // Prepare source context (limit to avoid token overflow)
        const sourceInfo = researchSources.slice(0, 8).map((s, i) =>
          `SOURCE ${i+1} [${s.sourceType?.toUpperCase()}]:\nTitle: "${s.title}"\nKey: ${s.text?.substring(0, 400) || 'N/A'}`
        ).join('\n\n');
        
        // Handle uploaded files
        const pdfFiles = uploadedFiles.filter(f => f.type === 'application/pdf');
        const imageFiles = uploadedFiles.filter(f => f.type?.startsWith('image/'));
        
        let pdfContext = '';
        for (const pdf of pdfFiles.slice(0, 2)) { // Limit to 2 PDFs
          try {
            const pdfText = await GeminiAPI.vision(
              `Extract key arguments, data, and quotes from this PDF. Return plain text only.`,
              GEMINI, [pdf]
            );
            pdfContext += `\nUPLOADED PDF (${pdf.name}):\n${pdfText.substring(0, 1500)}\n`;
          } catch (e) {
            console.error('[Agent] PDF extraction failed:', e.message);
          }
        }
        
        // ← NEW: Include extracted facts from coordinator
        const factsContext = enrichedContext.extractedFacts?.length > 0
          ? `\nEXTRACTED FACTS FROM RESEARCH (use these to support your arguments):
${enrichedContext.extractedFacts.map(f => 
  `[${f.type.toUpperCase()}] ${f.content} (Source #${f.sourceId}) — ${f.explanation}`
).join('\n')}`
          : '';
        
        // Detect task type for formatting
        const taskLower = userTask.toLowerCase();
        const isQuestions = /\?\s*$|\?\s*\n|questions?|answer|part\s*[a-z]|a\)|b\)|1\.|2\./i.test(userTask);
        const isEssay = /essay|argue|argument|thesis|discuss at length|persuade/i.test(taskLower);
        
        let formatInstructions = '';
        if (isQuestions) {
          formatInstructions = `FORMAT: Answer each question directly. Keep original numbering. Plain text only — no markdown.`;
        } else if (isEssay) {
          formatInstructions = `FORMAT: Argumentative essay. Thesis statement in intro. Each body paragraph: one claim + evidence + explanation. Plain text only — no markdown.`;
        } else {
          formatInstructions = `FORMAT: Follow the task's natural structure. Plain text only — no markdown.`;
        }
        
        const prompt = `Complete this task accurately.

TASK:
${userTask}
${pdfContext}
${researchSources.length > 0 ? `\nRESEARCH SOURCES (for ideas — do NOT cite directly yet):\n${sourceInfo}` : ''}
${factsContext}
${enrichedContext.keyEntities?.length > 0 ? `\nKEY ENTITIES TO ADDRESS: ${enrichedContext.keyEntities.slice(0, 10).join(', ')}` : ''}

${formatInstructions}

IMPORTANT:
- Do NOT include citations, bibliography, or source references yet
- Plain text only — no markdown, no bold, no headers unless task requires
- Be concise and direct — avoid filler phrases
${imageFiles.length > 0 ? '- Analyze uploaded image(s) and incorporate relevant observations.' : ''}

Begin:`;
        
        const rawText = imageFiles.length > 0 && GROQ
          ? await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, false)
          : await GeminiAPI.chat(prompt, GEMINI);
        
        const plainText = stripMarkdown(stripRefs(rawText));
        
        result.output = plainText;
        result.outputHtml = buildEssayHTML(plainText);
        result.type = 'text';
        
        coord.recordStepOutput('WRITE', { length: plainText.length, status: 'success' });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: REFINE
      // ======================================================================
      if (step.tool?.toUpperCase() === 'REFINE') {
        const input = enrichedContext.previousOutput || '';
        if (!input) {
          result.output = '';
          result.outputHtml = '';
          return res.status(200).json(result);
        }
        
        const taskLower = (enrichedContext.task || '').toLowerCase();
        const isQuestions = /\?\s*$|questions?|answer|part\s*[a-z]/i.test(enrichedContext.task || '');
        
        const refinePrompt = isQuestions
          ? `Improve these answers for completeness and clarity.

ANSWERS:
${input}

FOCUS:
1. Make each answer more specific and complete
2. Ensure all sub-questions (a, b, c) are addressed
3. Add relevant detail where answers are thin
4. Keep question structure and labels
5. Plain text only — no markdown

Return improved answers:`
          : `Strengthen this academic writing's argument quality.

ESSAY:
${input}

FOCUS:
1. Thesis: clear, strong position (not neutral description)
2. Each paragraph: ONE main argument with evidence + explanation of WHY it matters
3. Replace vague phrases ("this shows") with specific analysis
4. Every piece of evidence must explicitly connect to the thesis
5. Conclusion: synthesize, don't just restate
6. Keep ALL original content — only sharpen logic and language
7. Plain text only — no markdown

Return improved writing:`;
        
        const refined = stripMarkdown(stripRefs(
          await GeminiAPI.chat(refinePrompt, GEMINI)
        ));
        
        result.output = refined;
        result.outputHtml = buildEssayHTML(refined);
        result.type = 'text';
        
        coord.recordStepOutput('REFINE', { status: 'success' });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: HUMANIZE
      // ======================================================================
      if (step.tool?.toUpperCase() === 'HUMANIZE') {
        const input = enrichedContext.previousOutput || '';
        if (!input) {
          result.output = '';
          result.outputHtml = '';
          return res.status(200).json(result);
        }
        
        // Call existing humanizer handler
        const mockReq = { method: 'POST', body: { text: input, tone: 'Academic' } };
        let humanizedResult = '';
        const mockRes = { 
          setHeader: () => {}, 
          status: () => ({ end: () => {}, json: d => { humanizedResult = d; } }) 
        };
        await humanizerHandler(mockReq, mockRes);
        
        const humanized = (humanizedResult.success && humanizedResult.result)
          ? humanizedResult.result
          : stripMarkdown(await GeminiAPI.chat(
              `Rewrite naturally while keeping academic quality. Plain text only.\n\n${input}`, 
              GEMINI
            ));
        
        result.output = humanized;
        result.outputHtml = buildEssayHTML(humanized);
        result.type = 'text';
        
        coord.recordStepOutput('HUMANIZE', { status: 'success' });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: CITE
      // ======================================================================
      if (step.tool?.toUpperCase() === 'CITE') {
        const input = enrichedContext.previousOutput || '';
        const sources = enrichedContext.researchSources || [];
        const style = options.citationStyle || 'apa7';
        const type = options.citationType || 'in-text';
        
        // Handle empty cases
        if (!sources.length) {
          result.output = input;
          result.outputHtml = buildEssayHTML(input);
          result.citedSources = [];
          result.bibliographyHtml = '';
          result.type = 'cited';
          return res.status(200).json(result);
        }
        
        if (!input) {
          const earlyBib = buildBibliographyHTML(sources, style, type);
          result.output = '';
          result.outputHtml = '';
          result.citedSources = sources;
          result.bibliographyHtml = earlyBib.html;
          result.bibliographyPlain = earlyBib.plain;
          result.type = 'cited';
          return res.status(200).json(result);
        }
        
        const isApa = style.includes('apa');
        const isMla = style.includes('mla');
        
        // Fetch missing citations from Crossref if needed
        const needsCitation = sources.filter(s => s.doi && s.citationSource !== 'crossref');
        if (needsCitation.length > 0) {
          const updated = await SourceFinderAPI.fetchAllCitations(needsCitation, style);
          updated.forEach(u => {
            if (u.citationSource !== 'crossref') return;
            const orig = sources.find(s => s.doi === u.doi);
            if (orig) {
              orig.citation = u.citation;
              orig.citationSource = 'crossref';
              orig.volume = u.volume;
              orig.issue = u.issue;
              orig.pages = u.pages;
              if (u.authors?.length) orig.authors = u.authors;
            }
          });
        }
        
        // ← NEW: Include source type badges in prompt
        const sourceList = sources.slice(0, 12).map((s, i) => {
          const author = fmtAuthor(s, isMla ? 'mla' : 'apa');
          const badge = s.sourceType === 'web' ? '[WEB]' : '[ACADEMIC]';
          return `[${i+1}] ${badge} ${author} (${s.year})
   Title: "${s.title}"
   ${s.sourceType === 'web' ? `Source: ${s.venue || s.url}` : `Journal: ${s.venue || 'N/A'}`}
   Key: ${s.text?.substring(0, 250) || 'N/A'}`;
        }).join('\n\n');
        
        let citationFormat = '';
        if (type === 'in-text') {
          citationFormat = isApa 
            ? `APA 7th: (Author, Year) or Author (Year)` 
            : isMla 
              ? `MLA 9th: (Author) — no year` 
              : `Chicago: (Author Year)`;
        } else if (type === 'footnotes') {
          citationFormat = `Use superscript numbers at end of cited sentences. Each citation gets its OWN sequential number (even repeats). Number from 1 upward.`;
        }
        
        const prompt = `Add scholarly citations to this essay with strong signposting.

ESSAY:
${input}

AVAILABLE SOURCES:
${sourceList}

CITATION FORMAT: ${citationFormat}

INSTRUCTIONS:
1. Add citations ONLY where claims genuinely need evidence
2. Each citation must directly support the SPECIFIC claim it follows
3. After each citation, add ONE sentence explaining HOW this source proves your point
4. NEVER mention an author's name without immediately adding a citation
5. Prefer [ACADEMIC] sources for factual claims; use [WEB] for current events or opinions
6. Do NOT add a bibliography section
7. Plain text only — no markdown

Return ONLY the essay with citations inserted:`;
        
        let citedText = stripMarkdown(stripRefs(
          await GeminiAPI.chat(prompt, GEMINI)
        ));
        
        // ← NEW: Second pass to fix missing superscripts for footnotes
        if (type === 'footnotes') {
          const fixPrompt = `Fix any author mentions missing footnote numbers.

ESSAY:
${citedText}

SOURCES:
${sourceList}

RULES:
1. Every author mention (e.g. "Smith argues") MUST have a superscript after the sentence
2. Add missing superscripts based on existing numbering
3. Do NOT change existing superscripts or other text
4. Do NOT add bibliography

Return corrected essay only:`;
          
          citedText = stripMarkdown(stripRefs(
            await GeminiAPI.chat(fixPrompt, GEMINI)
          ));
        }
        
        // Handle footnote renumbering (simplified version)
        let finalText = citedText;
        let insertionOrder = null;
        
        if (type === 'footnotes') {
          // Extract citation order for bibliography
          const superRegex = /[¹²³⁴⁵⁶⁷⁸⁹⁰]+/g;
          const matches = [...citedText.matchAll(superRegex)];
          const superToNum = {'¹':1,'²':2,'³':3,'⁴':4,'⁵':5,'⁶':6,'⁷':7,'⁸':8,'⁹':9,'⁰':0};
          
          insertionOrder = [];
          const seen = new Set();
          
          for (const match of matches) {
            for (const char of match[0]) {
              const num = superToNum[char];
              if (num && num <= sources.length && !seen.has(num)) {
                insertionOrder.push(sources[num - 1]);
                seen.add(num);
              }
            }
          }
        }
        
        result.output = finalText;
        result.outputHtml = buildEssayHTML(finalText);
        result.citedSources = sources;
        
        const bib = buildBibliographyHTML(sources, style, type, insertionOrder);
        result.bibliographyHtml = bib.html;
        result.bibliographyPlain = bib.plain;
        result.type = 'cited';
        
        coord.recordStepOutput('CITE', { 
          count: sources.length, 
          type, 
          status: 'success' 
        });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: QUOTES
      // ======================================================================
      if (step.tool?.toUpperCase() === 'QUOTES') {
        const input = enrichedContext.previousOutput || '';
        const sources = enrichedContext.researchSources || [];
        
        if (!input || !sources.length) {
          result.output = input;
          result.outputHtml = buildEssayHTML(input);
          result.type = 'text';
          return res.status(200).json(result);
        }
        
        // Extract quotable sentences from sources
        const quotesFromSources = sources.slice(0, 8).map(s => {
          const author = fmtAuthor(s);
          const sentences = (s.text || '').match(/[^.!?]+[.!?]+/g) || [];
          const goodSentence = sentences.find(sent =>
            sent.length > 40 && sent.length < 250 &&
            /show|found|suggest|demonstrate|indicate|reveal|important|significant|evidence|argue|claim/i.test(sent)
          ) || sentences.find(sent => sent.length > 50 && sent.length < 200) || sentences[0] || '';
          
          return { 
            author, 
            year: s.year, 
            title: s.title, 
            quote: goodSentence.trim(),
            sourceId: s.id 
          };
        }).filter(q => q.quote?.length > 30);
        
        const quotesList = quotesFromSources.map((q, i) =>
          `[${i+1}] ${q.author} (${q.year}):\n   "${q.quote}"\n   From: "${q.title}"`
        ).join('\n\n');
        
        const prompt = `Insert 3-5 direct quotes into this essay with analytical transitions.

ESSAY:
${input}

QUOTES TO INSERT:
${quotesList}

INSTRUCTIONS:
1. Find best places for quotes to strengthen arguments
2. Use analytical transitions: "As X argues,", "X's research confirms that,"
3. After each quote, add 1-2 sentences explaining WHY it matters
4. Keep ALL existing text and citations
5. Do NOT add bibliography
6. Plain text only — no markdown

Return essay with quotes inserted:`;
        
        const withQuotes = stripMarkdown(
          await GeminiAPI.chat(prompt, GEMINI)
        );
        
        result.output = withQuotes;
        result.outputHtml = buildEssayHTML(withQuotes);
        result.type = 'text';
        
        coord.recordStepOutput('QUOTES', { status: 'success' });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: PROOFREAD
      // ======================================================================
      if (step.tool?.toUpperCase() === 'PROOFREAD') {
        const input = enrichedContext.previousOutput || '';
        if (!input) {
          result.output = '';
          result.outputHtml = '';
          return res.status(200).json(result);
        }
        
        const prompt = `Proofread and polish this academic text. Fix grammar, spelling, punctuation. Improve awkward phrasing. Keep ALL existing content, citations, and quotes. Plain text only — no markdown.

TEXT:
${input}

Return polished text:`;
        
        const polished = stripMarkdown(stripRefs(
          await GeminiAPI.chat(prompt, GEMINI)
        ));
        
        result.output = polished;
        result.outputHtml = buildEssayHTML(polished);
        result.type = 'text';
        
        coord.recordStepOutput('PROOFREAD', { status: 'success' });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // STEP: GRADE
      // ======================================================================
      if (step.tool?.toUpperCase() === 'GRADE') {
        const text = enrichedContext.previousOutput || '';
        
        if (!text) {
          result.output = { grade: 'N/A', feedback: 'No text to grade.' };
          result.type = 'grade';
          return res.status(200).json(result);
        }
        
        const mockReq = {
          method: 'POST',
          body: {
            text,
            instructions: enrichedContext.task || '',
            rubric: enrichedContext.rubric || '',
            files: enrichedContext.uploadedFiles?.map(f => ({
              name: f.name, type: f.type, content: f.data, isBase64: true
            })) || []
          }
        };
        
        let gradeResult = null;
        const mockRes = {
          setHeader: () => {},
          status: () => ({ end: () => {}, json: d => { gradeResult = d; } })
        };
        await graderHandler(mockReq, mockRes);
        
        const feedback = gradeResult?.result || 'Grading completed.';
        const gradeMatch = feedback.match(/(?:Overall\s+)?Grade[:\s]*([A-F][+-]?|\d+[\/.]\d+)/i)
          || feedback.match(/([A-F][+-]?)\s*(?:\/|out of|\()/i);
        
        result.output = {
          grade: gradeMatch ? gradeMatch[1].toUpperCase() : '—',
          feedback
        };
        result.type = 'grade';
        
        coord.recordStepOutput('GRADE', { grade: result.output.grade });
        
        return res.status(200).json(result);
      }
      
      // ======================================================================
      // UNKNOWN STEP
      // ======================================================================
      result.output = `Unknown step: ${step?.tool}`;
      result.success = false;
      return res.status(400).json(result);
    }
    
    // ========================================================================
    // INVALID ACTION
    // ========================================================================
    return res.status(400).json({ success: false, error: 'Invalid action' });
    
  } catch (e) {
    console.error('[Agent] Error:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message,
      // ← Optional: include coordination notes for debugging
      coordination: typeof coord !== 'undefined' ? coord.context.coordinationNotes : undefined
    });
  }
}
