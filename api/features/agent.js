// ==========================================================================
// FILE PATH: api/features/agent.js
// ==========================================================================

/**
 * api/features/agent.js
 * DocuMate Agent Coordinator Endpoint
 * 
 * Table of Contents:
 * 1. Dependencies & Step Imports
 * 2. Swarm Executor Core Module
 * 3. Central Router Handler Module
 */

// ==========================================================================
// MODULE 1: DEPENDENCIES & STEP IMPORTS
// ==========================================================================
import { resetModelUsage, getModelUsage } from '../_utils/geminiAPI.js';
import { ScraperAPI } from '../_utils/scraper.js'; // Added import to resolve ScraperAPI reference error [1]

// Centralized agent helpers sibling imports (resolves Vercel Require Stack crash)
import {
    RequestBudget,
    buildSourceDigest,
    mergeHumanizeIntoCited,
    splitSentences,
    checkWithGroq,
    applyFixes,
    buildBibliographyHTML,
    buildEssayHTML
} from './agent/agentHelpers.js';

// Step file imports (local to steps/ directory under features/)
import { runPlan } from './agent/_steps/plan.js';
import { runResearch } from './agent/_steps/research.js';
import { runWrite } from './agent/_steps/write.js';
import { runHumanize } from './agent/_steps/humanize.js';
import { runCite } from './agent/_steps/cite.js';
import { runQuotes } from './agent/_steps/quotes.js';
import { runGrade } from './agent/_steps/grade.js';

// ==========================================================================
// MODULE 1: Cosmetic Step Planner
// ==========================================================================
function buildStepList(options = {}) {
    const fast = options.fastMode === true;
    const steps = [{ tool: 'RESEARCH', action: 'Find academic sources' }];
    
    if (options.enableWrite !== false) steps.push({ tool: 'WRITE', action: 'Write response' });
    if (!fast && options.enableHumanize) steps.push({ tool: 'HUMANIZE', action: 'Humanize text' });
    if (options.enableCite) steps.push({ tool: 'CITE', action: `Add ${options.citationType || 'in-text'} citations` });
    if (!fast && options.enableQuotes) steps.push({ tool: 'QUOTES', action: 'Insert quotes with transitions' });
    if (options.enableGrade) steps.push({ tool: 'GRADE', action: 'Grade work' });
    
    return { steps };
}

// ==========================================================================
// MODULE 2: Swarm Executor Core
// ==========================================================================
async function runSwarm(req, res) {
    const { task, context = {}, options = {} } = req.body;
    const GEMINI = process.env.GEMINI_API_KEY;
    const GROQ = process.env.GROQ_API_KEY;

    resetModelUsage();
    const budget = new RequestBudget();
    const style = options.citationStyle || 'apa7';
    const fast = options.fastMode === true;
    const enableHumanize = !fast && options.enableHumanize;
    const enableCite = options.enableCite !== false;
    const enableQuotes = !fast && options.enableQuotes;

    const timings = {};
    const startTimer = label => {
        const start = Date.now();
        return () => { timings[label] = Date.now() - start; };
    };

    try {
        // ── PHASE 1: Precursor Content & Topic Planning ────────────────────────
        console.log('[Swarm Logger] Initiating Phase 1: Topic Planning...');
        const tPlan = startTimer('plan');
        const { topic, scale_profile, plan } = await runPlan({ task }, GROQ, budget);
        tPlan();

        // STRICT CONTEXT VALIDATOR: Guarantee scale.sectored_outlines is a valid array regardless of LLM structural variance [1]
        const scale = scale_profile && Array.isArray(scale_profile.sectored_outlines)
            ? scale_profile
            : {
                tier: 'standard',
                total_target_words: 1000,
                total_target_sources: 4,
                sectored_outlines: (plan?.sections || ["Introduction", "Analysis", "Conclusion"]).map((h, i) => ({
                    id: i + 1,
                    heading: h,
                    target_words: 400,
                    search_query: topic
                }))
            };

        console.log(`[Swarm Logger] Planning Complete. Tier: ${scale.tier.toUpperCase()}`);
        console.log('[Swarm Logger] Outline Sections:', plan.sections);
        console.log('[Swarm Logger] Custom Writing Quality Guidelines:', plan.writing_tips);

        // ── PHASE 1.5: Research & Scrape (Concurrently) ────────────────────────
        console.log('[Swarm Logger] Initiating Phase 1.5: Sectored Academic Research...');
        const tResearch = startTimer('research');
        
        const targetQueries = scale.tier === 'high_horizon'
            ? scale.sectored_outlines.map(o => o.search_query).filter(Boolean).slice(0, 5)
            : [topic];

        const researchOutputs = await Promise.all(targetQueries.map(q =>
            runResearch({ topic: q, citationStyle: style }, GROQ, budget)
        ));

        // Merge and deduplicate all gathered sources
        const allSources = [];
        const seenUrls = new Set();
        researchOutputs.forEach(out => {
            (out.sources || []).forEach(src => {
                const key = src.doi || src.url;
                if (key && !seenUrls.has(key)) {
                    seenUrls.add(key);
                    allSources.push(src);
                }
            });
        });

        // Scrape the top 8 sources to extract their full text (essential for quotes & writing depth) [1]
        console.log('[Swarm Logger] Scraping top 8 sources for full text extraction...');
        const topSources = allSources.slice(0, 8);
        const scrapedSources = await ScraperAPI.scrape(topSources);
        
        // Combine scraped sources with the remaining unscraped fallback sources
        const activeSources = [...scrapedSources, ...allSources.slice(8)];

        tResearch();
        console.log(`[Swarm Logger] Research & Scraping Complete. ${activeSources.length} sources resolved.`);

        // ── PHASE 2: Sequential Chained Writing (Sliding Context Window) ───────
        console.log('[Swarm Logger] Initiating Phase 2: Sequential Chained Draft Generation...');
        const allFiles = context.uploadedFiles || (context.uploadedFile ? [context.uploadedFile] : []);
        const tWrite = startTimer('write');

        let compiledDraft = '';
        const waveTexts = []; // Stores the raw drafted text of each section
        const sourcesPerSection = Math.ceil(activeSources.length / scale.sectored_outlines.length);

        for (let i = 0; i < scale.sectored_outlines.length; i++) {
            const sectionOutline = scale.sectored_outlines[i];
            
            // Slice a unique source bucket for this section to force source diversity
            const sectionSources = activeSources.slice(i * sourcesPerSection, (i + 1) * sourcesPerSection);
            
            // Sliding Window: feed the text of the immediately preceding section as transition context
            const previousContext = i > 0 ? waveTexts[i - 1] : '';

            console.log(`[Swarm Logger] Drafting Wave ${i + 1}/${scale.sectored_outlines.length}: "${sectionOutline.heading}"...`);
            
            const sectionDraft = await runWrite({
                task,
                plan: {
                    sections: [sectionOutline.heading],
                    tone: plan.tone || 'Academic and objective',
                    writing_tips: plan.writing_tips || []
                },
                researchSources: sectionSources,
                uploadedFiles: allFiles,
                sectionOutline: sectionOutline,
                previousContext: previousContext
            }, GEMINI, budget);

            waveTexts.push(sectionDraft);
            compiledDraft += (compiledDraft ? '\n\n' : '') + sectionDraft;
        }
        tWrite();
        console.log(`[Swarm Logger] Phase 2 Complete. Chained draft generated (${compiledDraft.length} chars).`);

        // ── PHASE 2.5: Parallel Style Humanizer & Sibling QA Pass ───────────────
        console.log('[Swarm Logger] Initiating Phase 2.5: Parallel Humanization & Grammar QA...');
        const tHumanize = startTimer('humanize');
        const tQA = startTimer('qa');

        const [humanizeOutput, qaChecks] = await Promise.all([
            enableHumanize
                ? runHumanize(compiledDraft, budget).then(out => { tHumanize(); return out; })
                : Promise.resolve(null),
            (GROQ && compiledDraft.length > 1000)
                ? checkWithGroq(compiledDraft, GROQ, budget).then(checks => { tQA(); return checks; })
                : Promise.resolve([]).then(c => { tQA(); return c; })
        ]);

        let polishedText = compiledDraft;
        if (enableHumanize && humanizeOutput) {
            polishedText = humanizeOutput;
        }
        if (qaChecks.length > 0) {
            polishedText = applyFixes(polishedText, qaChecks);
        }
        console.log('[Swarm Logger] Phase 2.5 Complete.');

        // ── PHASE 3: Parallel Sectored Citation Ingestion ────────────────────────
        let finalEssayText = polishedText;
        let bibliographyHtml = '';
        let bibliographyPlain = '';
        let citedSourcesList = [];
        const tCite = startTimer('cite');

        if (enableCite && activeSources.length > 0) {
            console.log('[Swarm Logger] Initiating Phase 3: Parallel Sectored Citation Ingestion...');
            
            // To prevent citation clustering, we cite each drafted section separately in parallel
            const citedSections = await Promise.all(waveTexts.map(async (sectionText, idx) => {
                const sectionSources = activeSources.slice(idx * sourcesPerSection, (idx + 1) * sourcesPerSection);
                if (sectionSources.length === 0) return { text: sectionText, sources: [] };

                const citeRes = await runCite({
                    task,
                    previousOutput: sectionText,
                    researchSources: sectionSources,
                    citationStyle: style,
                    citationType: options.citationType || 'in-text',
                    enableQuotes,
                    preWarmedDigest: null
                }, GEMINI, GROQ, budget);

                return {
                    text: citeRes.text,
                    sources: citeRes.citedSources || sectionSources,
                    bibHtml: citeRes.bibliographyHtml,
                    bibPlain: citeRes.bibliographyPlain
                };
            }));

            // Re-compile cited essay
            finalEssayText = citedSections.map(s => s.text).join('\n\n');

            // Gather all cited sources
            const citedSeen = new Set();
            citedSections.forEach(s => {
                if (s.sources) {
                    s.sources.forEach(src => {
                        const key = src.doi || src.url;
                        if (key && !citedSeen.has(key)) {
                            citedSeen.add(key);
                            citedSourcesList.push(src);
                        }
                    });
                }
            });

            // Compile a single master bibliography alphabetically [3]
            const masterBib = buildBibliographyHTML(citedSourcesList, style, options.citationType === 'footnotes' ? 'footnotes' : 'bibliography');
            bibliographyHtml = masterBib.html;
            bibliographyPlain = masterBib.plain;
            console.log(`[Swarm Logger] Citations complete. ${citedSourcesList.length} sources cited.`);
        } else {
            console.log('[Swarm Logger] Citation disabled or no sources found, skipping.');
        }
        tCite();

        // ── PHASE 3.5: Quotes (depends on merged text + cite digest) ─────────
        let finalText = finalEssayText;
        if (enableQuotes && citedSourcesList.length > 0) {
            console.log('[Swarm Logger] Initiating Phase 3.5: Verbatim Quote Insertion...');
            const tQuotes = startTimer('quotes');
            
            // Re-warm digest using the cited sources list
            const digest = await buildSourceDigest(citedSourcesList, style, GEMINI, budget);

            const quotesResult = await runQuotes({
                task,
                previousOutput: finalEssayText,
                researchSources: citedSourcesList,
                citationStyle: style,
                quotesHandledInCite: false,
                sourceDigest: digest
            }, GEMINI, GROQ, budget);
            finalText = quotesResult.text;
            tQuotes();
            console.log('[Swarm Logger] Quotes Injected.');
        }

        // ── PHASE 4: Academic Grading ─────────────────────────────────────────
        console.log('[Swarm Logger] Initiating Phase 4: Parallel Grading...');
        const tGrade = startTimer('grade');

        const gradeOutput = options.enableGrade
            ? await runGrade({
                task,
                rubric: context.rubric,
                previousOutput: finalText,
                researchSources: citedSourcesList.length ? citedSourcesList : activeSources,
                citationStyle: style,
                citationType: options.citationType,
                enableCite,
                uploadedFiles: allFiles
            }, budget)
            : null;
        tGrade();
        console.log('[Swarm Logger] Swarm Execution Complete.');

        // Bulletproof final plain-text clean sweep
        const cleanOutputText = finalText
            .replace(/\*\*+/g, '')  // strip bold
            .replace(/#+\s*/g, '')  // strip headers
            .trim();

        console.log('[Swarm] Budget:', budget.report());
        console.log('[Swarm] Timings:', timings);
        console.log('[Swarm] Model usage:', getModelUsage());

        return res.status(200).json({
            success: true,
            output: cleanOutputText,
            outputHtml: buildEssayHTML(cleanOutputText),
            bibliographyHtml: bibliographyHtml,
            bibliographyPlain: bibliographyPlain,
            sources: citedSourcesList.length ? citedSourcesList : activeSources, // Full synchronization
            grade: gradeOutput,
            plan,
            timings,
            budgetReport: budget.report(),
            modelUsage: getModelUsage(),
            type: 'swarm'
        });

    } catch (e) {
        console.error('[Swarm] Error:', e);
        return res.status(500).json({ success: false, error: e.message, budgetReport: budget.report(), modelUsage: getModelUsage() });
    }
}

// ==========================================================================
// MODULE 3: Central Router Handler
// ==========================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { action, options = {} } = req.body;

        if (action === 'plan') {
            return res.status(200).json({ success: true, plan: buildStepList(options) });
        }

        if (action === 'run_swarm') {
            return await runSwarm(req, res);
        }

        return res.status(400).json({ success: false, error: 'Invalid action' });

    } catch (e) {
        console.error('[Agent] Error:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
}