// ==========================================================================
// FILE PATH: api/features/agent.js
// ==========================================================================

/**
 * api/features/agent.js
 * DocuMate Agent Coordinator Endpoint
 * 
 * Table of Contents:
 * 1. Cosmetic Step Planner Module
 * 2. Swarm Executor Core Module
 * 3. Central Router Handler Module
 */

import { resetModelUsage, getModelUsage } from '../_utils/geminiAPI.js';

// Centralized agent helpers imports (routed into the ignored agentHelpers.js sibling)
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
import { runPlan } from './agent/_steps/plan.js'; // Added precursor plan import
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
        const { topic, plan } = await runPlan({ task }, GROQ, budget);
        tPlan();

        console.log('[Swarm Logger] Planning Complete.');
        console.log('[Swarm Logger] Extracted Topic:', topic);
        console.log('[Swarm Logger] Generated Outline Sections:', plan.sections);
        console.log('[Swarm Logger] Custom Writing Quality Guidelines:', plan.writing_tips);

        // ── PHASE 1.5: Research, using the pre-planned topic query ─────────────
        console.log('[Swarm Logger] Initiating Phase 1.5: Academic Research...');
        const tResearch = startTimer('research');
        const { sources } = await runResearch({ topic, citationStyle: style }, GROQ, budget);
        tResearch();
        console.log(`[Swarm Logger] Research Complete. ${sources.length} sources resolved.`);

        // ── PHASE 2: Write + digest pre-warm, in parallel ────────────────────
        console.log('[Swarm Logger] Initiating Phase 2: Parallel Draft Generation & Pre-warm...');
        const allFiles = context.uploadedFiles || (context.uploadedFile ? [context.uploadedFile] : []);

        const tWrite = startTimer('write');
        const tDigest = startTimer('digest');

        const [writeOutput, digest] = await Promise.all([
            runWrite({ task, plan, researchSources: sources, uploadedFiles: allFiles }, GEMINI, budget)
                .then(out => { tWrite(); return out; }),
            (sources.length > 0
                ? buildSourceDigest(sources, style, GEMINI, budget)
                : Promise.resolve({})
            ).then(d => { tDigest(); return d; })
        ]);
        console.log(`[Swarm Logger] Phase 2 Complete. Draft generated (${writeOutput.length} chars).`);

        // ── PHASE 2.5: Parallel Style Humanizer & Sibling QA Pass ─────────────────────
        // We run Humanizer and QA on the plain draft first so citations are NEVER modified by LLM checks [1]
        console.log('[Swarm Logger] Initiating Phase 2.5: Parallel Humanization & Grammar QA...');
        const tHumanize = startTimer('humanize');
        const tQA = startTimer('qa');

        const [humanizeOutput, qaChecks] = await Promise.all([
            enableHumanize
                ? runHumanize(writeOutput, budget).then(out => { tHumanize(); return out; })
                : Promise.resolve(null),
            (GROQ && writeOutput.length > 1000)
                ? checkWithGroq(writeOutput, GROQ, budget).then(checks => { tQA(); return checks; })
                : Promise.resolve([]).then(c => { tQA(); return c; })
        ]);

        // Merge humanize and apply QA corrections onto the clean draft
        let polishedText = writeOutput;
        if (enableHumanize && humanizeOutput) {
            polishedText = humanizeOutput;
        }
        if (qaChecks.length > 0) {
            polishedText = applyFixes(polishedText, qaChecks);
        }

        // ── PHASE 3: Cite (reads the polished, grammatically correct draft) ────
        console.log('[Swarm Logger] Initiating Phase 3: Citation Insertion...');
        const tCite = startTimer('cite');

        const citeResult = enableCite
            ? await runCite({
                task,
                previousOutput: polishedText,
                researchSources: sources,
                citationStyle: style,
                citationType: options.citationType || 'in-text',
                enableQuotes,
                preWarmedDigest: digest
            }, GEMINI, GROQ, budget)
            : null;
        tCite();

        let citedText = citeResult ? citeResult.text : polishedText;
        let quotesHandledInCite = citeResult ? !!citeResult.quotesHandledInCite : false;
        let sourceDigest = citeResult?.sourceDigest || digest;

        // ── PHASE 3.5: Quotes (depends on cited text + cite digest) ─────────
        let finalText = citedText;
        if (enableQuotes) {
            console.log('[Swarm Logger] Initiating Phase 3.5: Verbatim Quote Insertion...');
            const tQuotes = startTimer('quotes');
            const quotesResult = await runQuotes({
                task,
                previousOutput: citedText,
                researchSources: sources,
                citationStyle: style,
                quotesHandledInCite,
                sourceDigest
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
                researchSources: sources,
                citationStyle: style,
                citationType: options.citationType,
                enableCite,
                uploadedFiles: allFiles
            }, budget)
            : null;
        tGrade();
        console.log('[Swarm Logger] Swarm Execution Complete.');

        // ── Bibliography ───────────────────────────────────────────────────────
        const bib = enableCite
            ? buildBibliographyHTML(sources, style, options.citationType === 'footnotes' ? 'footnotes' : 'bibliography')
            : { html: '', plain: '' };

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
            bibliographyHtml: citeResult?.bibliographyHtml || bib.html,
            bibliographyPlain: citeResult?.bibliographyPlain || bib.plain,
            sources: citeResult?.citedSources || sources, // Full synchronization
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