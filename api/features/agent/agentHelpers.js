// ==========================================================================
// FILE PATH: api/features/agent/agentHelpers.js
// ==========================================================================

/**
 * api/features/agent/agentHelpers.js
 * Consolidated Utility Helpers for the AI Agent Pipeline
 * 
 * Table of Contents:
 * 1. Request Budget Manager Module
 * 2. Task Planner Module
 * 3. HTML Builders Module
 * 4. Text Cleaners & Merging Module
 * 5. Source Digest Warm-Up Module
 * 6. Quality Assurance & Fixers Module
 */

import { GroqAPI } from '../../_utils/groqAPI.js';
import { GeminiAPI } from '../../_utils/geminiAPI.js';
import { DoiAPI } from '../../_utils/doiAPI.js';

// ==========================================================================
// MODULE 1: Request Budget Manager
// ==========================================================================
export class RequestBudget {
    constructor(maxRequests = 50) {
        this.maxRequests = maxRequests;
        this.requests = 0;
        this.startTime = Date.now();
    }

    // Replaces increment() to globally support the steps' .spend(label) calls
    spend(label) {
        this.requests++;
        if (this.requests > this.maxRequests) {
            throw new Error(`Request budget exceeded: more than ${this.maxRequests} outbound API calls. Failed on: ${label}`);
        }
    }

    report() {
        return {
            requests: this.requests,
            maxRequests: this.maxRequests,
            elapsedMs: Date.now() - this.startTime
        };
    }
}

// ==========================================================================
// MODULE 2: Task Planner
// ==========================================================================
export async function planTask(task, groqKey, budget) {
    console.log('[Agent Helper] Generating content writing plan...');
    try {
        const prompt = `You are a curriculum director. Analyze the task and output a structured outline.

TASK:
"${task}"

Return a JSON outline with required sections, tone guidelines, and word count targets.`;

        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, true);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : { sections: ["Introduction", "Analysis", "Conclusion"] };
    } catch (e) {
        console.warn('[Agent Helper] Planner failed, using standard fallback outline:', e.message);
        return { sections: ["Introduction", "Analysis", "Conclusion"] };
    }
}

export function formatPlanForPrompt(plan) {
    if (!plan || !plan.sections) return '';
    return `\nWRITING BRIEF:\n- Target Sections: ${plan.sections.join(', ')}\n- Specific Requirements: ${plan.tone || 'Academic and objective'}\n`;
}

// ==========================================================================
// MODULE 3: HTML Builders
// ==========================================================================
export function buildEssayHTML(text) {
    if (!text) return '<i>No essay output.</i>';
    return `<div style="font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:2;color:#000;">` +
        text.split(/\n\n+/).map(p => {
            const cleanP = p.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
            return `<p style="margin:0;text-indent:36px;">${cleanP}</p>`;
        }).join('\n') + `</div>`;
}

export function buildBibliographyHTML(sources, style, formatType = 'bibliography') {
    if (!sources || !sources.length) return { html: '', plain: '' };
    
    const seen = new Set();
    const unique = sources.filter(s => {
        const key = s.doi || s.link;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    unique.sort((a, b) => {
        const nameA = DoiAPI.cleanAuthorName(a.meta?.author) || DoiAPI.cleanSiteName(a.meta?.siteName || a.title);
        const nameB = DoiAPI.cleanAuthorName(b.meta?.author) || DoiAPI.cleanSiteName(b.meta?.siteName || b.title);
        return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
    });

    const plainTexts = unique.map(s => DoiAPI.formatBib(s, style));
    const title = formatType === 'footnotes' ? 'Footnotes' : 'Bibliography';

    const html = `<div class="bibliography-section" style="margin-top:20px;font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:1.5;">
        <h3 style="text-align:center;margin-bottom:20px;">${title}</h3>
        ${plainTexts.map(text => `<p style="margin:0 0 12px 36px;text-indent:-36px;padding-left:36px;">${text}</p>`).join('\n')}
    </div>`;

    return { html, plain: plainTexts.join('\n\n') };
}

// ==========================================================================
// MODULE 4: Text Cleaners & Merging
// ==========================================================================
export function splitSentences(text) {
    if (!text) return [];
    
    // Temporarily mask common academic abbreviations to prevent splitting citations/lists in half [1]
    const masked = text
        .replace(/\b(et\s+al|e\.g|i\.e|vol|no|pp|vs|dr|prof)\./gi, '$1_DOT_');
        
    const sentences = masked.match(/[^.!?]+[!=?.]+(?=\s|$)/g) || [masked];
    
    // Restore the periods to the split sentences
    return sentences.map(s => s.replace(/_DOT_/g, '.'));
}

export function extractTopic(text) {
    if (!text) return 'general research';
    const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    return words.slice(0, 3).join(' ') || 'general research';
}

export function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/\*\*+/g, '')       // Strips all bold markdown (**)
        .replace(/#+\s*/g, '')        // Strips all header hashtag markdown (###, ##)
        .replace(/\|/g, '')           // Strips raw table pipes completely (|)
        .replace(/^\s*[-*•]\s+/gm, '') // Strips bullet points at the start of lines
        .replace(/\s+/g, ' ')
        .replace(/ \./g, '.')
        .replace(/ ,/g, ',')
        .trim();
}

export function fmtAuthorLastOnly(source) {
    if (source.authors?.length > 0) {
        return source.authors[0].family || 'Unknown';
    }
    const rawAuthor = DoiAPI.cleanAuthorName(source.author);
    if (rawAuthor) {
        const clean = rawAuthor.replace(/\s+et\s+al\.?$/i, '').split(',')[0].trim();
        const parts = clean.split(/\s+/);
        return parts[parts.length - 1]; 
    }
    return DoiAPI.cleanSiteName(source.venue || source.title);
}

export function mergeHumanizeIntoCited(humanText, citedText, splitterFn = splitSentences) {
    const humanSentences = splitterFn(humanText);
    const citedSentences = splitterFn(citedText);
    
    // Realign sentences cleanly without structural off-set corruption [1]
    return citedSentences.map((cited, index) => {
        const human = humanSentences[index];
        if (!human) return cited;
        
        // Extract parenthetical citations as well as bracketed/superscript annotations [1]
        const citations = cited.match(/\s*\([^)]+\d{4}[^)]*\)|\s*\[\d+\]|[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+/g);
        if (citations) {
            // Append the extracted citation safely to the humanized sentence
            return human.trim().replace(/\.+$/, '') + ' ' + citations.join('').trim() + '.';
        }
        return human;
    }).join(' ');
}

// ==========================================================================
// MODULE 5: Source Digest Warm-Up
// ==========================================================================
export async function buildSourceDigest(sources, style, geminiKey, budget) {
    console.log('[Agent Helper] Compiling source digest & extracting direct quotes...');
    if (!sources || !sources.length) return {};

    const digest = {};
    const targetSources = sources.slice(0, 5); // Conserve API budget by targeting top 5 sources

    await Promise.all(targetSources.map(async (s, idx) => {
        const key = idx + 1;
        const textToAnalyze = s.text || s.snippet || '';
        
        let quotes = [];
        if (textToAnalyze.length > 100 && geminiKey) {
            try {
                budget.spend('extract-quotes-digest');
                const prompt = `Extract exactly 2-3 short, highly impactful verbatim direct quotes (1-2 sentences each) representing key data, findings, or conclusions from this academic text. Do NOT modify the wording.

TEXT:
"${textToAnalyze.substring(0, 1500)}"

Return a raw JSON array of strings only: ["quote 1", "quote 2"]`;
                
                const res = await GeminiAPI.chat(prompt, geminiKey, 0.2);
                const jsonMatch = res.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    quotes = JSON.parse(jsonMatch[0]).filter(q => typeof q === 'string' && q.length > 10);
                }
            } catch (e) {
                console.warn(`[Agent Helper] Quote extraction failed for source ${key}:`, e.message);
            }
        }

        digest[key] = {
            title: s.title,
            link: s.link || s.url,
            citation: DoiAPI.formatInText(s, style),
            inTextKey: DoiAPI.getShortAuthorName(s),
            mainIdea: s.title,
            quotes: quotes
        };
    }));

    return digest;
}

// ==========================================================================
// MODULE 6: Quality Assurance & Fixers
// ==========================================================================
export async function checkWithGroq(text, groqKey, budget) {
    console.log('[Agent Helper] Running logical and formatting QA checks...');
    try {
        const prompt = `Review this academic essay text for logical inconsistencies, spelling errors, or structural formatting gaps.

TEXT:
"${text}"

Return a JSON array of fixes:
{"fixes": [{"issue": "description", "find": "exact bad phrase from the text", "replace": "exact corrected phrase"}]}

CRITICAL RULES:
1. The "replace" field must contain ONLY the raw, clean, corrected text to replace the "find" field.
2. NEVER include explanations, comments, parenthetical guidelines, or notes (such as "second reference should be...", "no comma...", "edit as needed") inside the "replace" field.
3. Every replacement must be a seamless, drop-in substitution for the original text.`;

        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, true);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]).fixes || [] : [];
    } catch (e) {
        console.warn('[Agent Helper] QA Check failed, skipping auto-repairs:', e.message);
        return [];
    }
}

export function applyFixes(text, fixes) {
    if (!fixes || !fixes.length) return text;
    let result = text;
    
    fixes.forEach(fix => {
        if (fix.find && fix.replace) {
            result = result.replace(fix.find, fix.replace);
        }
    });
    return result;
}