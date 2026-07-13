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

// Centralized agent helpers imports (routed into the ignored _agentHelpers.js sibling)
import {
    RequestBudget,
    buildSourceDigest,
    mergeHumanizeIntoCited,
    splitSentences,
    checkWithGroq,
    applyFixes,
    buildBibliographyHTML,
    buildEssayHTML
} from './_agentHelpers.js';

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

        // ── PHASE 3: Humanize + Cite, in parallel (both read writeOutput) ────
        console.log('[Swarm Logger] Initiating Phase 3: Parallel Style Humanizer & Citation Insertion...');
        const tHumanize = startTimer('humanize');
        const tCite = startTimer('cite');

        const [humanizeOutput, citeResult] = await Promise.all([
            enableHumanize
                ? runHumanize(writeOutput, budget).then(out => { tHumanize(); return out; })
                : Promise.resolve(null),
            enableCite
                ? runCite({
                    task,
                    previousOutput: writeOutput,
                    researchSources: sources,
                    citationStyle: style,
                    citationType: options.citationType || 'in-text',
                    enableQuotes,
                    preWarmedDigest: digest
                }, GEMINI, GROQ, budget).then(out => { tCite(); return out; })
                : Promise.resolve(null)
        ]);
        console.log('[Swarm Logger] Phase 3 Complete.');

        // ── Merge humanize + cite output ──────────────────────────────────────
        let mergedText = writeOutput;
        let quotesHandledInCite = false;
        let sourceDigest = digest;

        if (enableCite && citeResult) {
            mergedText = citeResult.text;
            quotesHandledInCite = !!citeResult.quotesHandledInCite;
            sourceDigest = citeResult.sourceDigest || digest;
            if (enableHumanize && humanizeOutput) {
                mergedText = mergeHumanizeIntoCited(humanizeOutput, citeResult.text, splitSentences);
            }
        } else if (enableHumanize && humanizeOutput) {
            mergedText = humanizeOutput;
        }

        // ── PHASE 3.5: Quotes (depends on merged text + cite digest) ─────────
        let finalText = mergedText;
        if (enableQuotes) {
            console.log('[Swarm Logger] Initiating Phase 3.5: Verbatim Quote Insertion...');
            const tQuotes = startTimer('quotes');
            const quotesResult = await runQuotes({
                task,
                previousOutput: mergedText,
                researchSources: sources,
                citationStyle: style,
                quotesHandledInCite,
                sourceDigest
            }, GEMINI, GROQ, budget);
            finalText = quotesResult.text;
            tQuotes();
            console.log('[Swarm Logger] Quotes Injected.');
        }

        // ── PHASE 4: Final QA + Grade, in parallel ────────────────────────────
        console.log('[Swarm Logger] Initiating Phase 4: Parallel Quality Assurance & Grading...');
        const tQA = startTimer('qa');
        const tGrade = startTimer('grade');

        const qaPromise = (!enableQuotes && GROQ && finalText.length > 1000)
            ? checkWithGroq(finalText, GROQ, budget)
                .then(checks => { tQA(); return applyFixes(finalText, checks); })
            : Promise.resolve(finalText).then(t => { tQA(); return t; });

        const gradePromise = options.enableGrade
            ? runGrade({
                task,
                rubric: context.rubric,
                previousOutput: finalText,
                researchSources: sources,
                citationStyle: style,
                citationType: options.citationType,
                enableCite,
                uploadedFiles: allFiles
            }, budget).then(out => { tGrade(); return out; })
            : Promise.resolve(null);

        const [qaFinalText, gradeOutput] = await Promise.all([qaPromise, gradePromise]);
        console.log('[Swarm Logger] Swarm Execution Complete.');

        // ── Bibliography ───────────────────────────────────────────────────────
        const bib = enableCite
            ? buildBibliographyHTML(sources, style, options.citationType === 'footnotes' ? 'footnotes' : 'bibliography')
            : { html: '', plain: '' };

        console.log('[Swarm] Budget:', budget.report());
        console.log('[Swarm] Timings:', timings);
        console.log('[Swarm] Model usage:', getModelUsage());

        return res.status(200).json({
            success: true,
            output: qaFinalText,
            outputHtml: buildEssayHTML(qaFinalText),
            // FIXED: Prioritize citeResult's matching compiled outputs, falling back safely if citation was disabled
            bibliographyHtml: citeResult?.bibliographyHtml || bib.html,
            bibliographyPlain: citeResult?.bibliographyPlain || bib.plain,
            sources: citeResult?.citedSources || sources, // Ensure top and bottom boxes are fully synchronized
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