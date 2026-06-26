// api/features/agent.js
import { RequestBudget } from '../_utils/budget.js';
import { cleanText } from '../_utils/textCleanup.js';
import { mergeHumanizeIntoCited } from '../_utils/citationHelpers.js';
import { buildBibliographyHTML, buildEssayHTML } from '../_utils/htmlBuilders.js';
import { checkWithGroq, applyFixes } from '../_utils/qaHelpers.js';
import { splitSentences } from '../_utils/textCleanup.js';
import { resetModelUsage, getModelUsage } from '../_utils/geminiAPI.js';
import { detectTaskFormatSmart } from '../_utils/formatDetector.js';

import { runResearch } from './_steps/research.js';
import { runWrite } from './_steps/write.js';
import { runHumanize } from './_steps/humanize.js';
import { runCite } from './_steps/cite.js';
import { runQuotes } from './_steps/quotes.js';
import { runGrade } from './_steps/grade.js';

// ─── Plan builder ─────────────────────────────────────────────────────────────
function buildPlan(options = {}) {
    const fast = options.fastMode === true;
    const steps = [{ tool: 'RESEARCH', action: 'Find academic sources' }];
    if (options.enableWrite !== false) steps.push({ tool: 'WRITE', action: 'Write response' });
    if (!fast && options.enableHumanize) steps.push({ tool: 'HUMANIZE', action: 'Humanize text' });
    if (options.enableCite) steps.push({ tool: 'CITE', action: `Add ${options.citationType || 'in-text'} citations` });
    if (!fast && options.enableQuotes) steps.push({ tool: 'QUOTES', action: 'Insert quotes with transitions' });
    if (options.enableGrade) steps.push({ tool: 'GRADE', action: 'Grade work' });
    return { steps };
}

// ─── Full swarm run ───────────────────────────────────────────────────────────
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
        // ── PHASE 1: Research + format detection, in parallel (no deps) ──────
        const tResearch = startTimer('research');
        const tFormat = startTimer('formatDetect');

        const [{ sources }, taskFormat] = await Promise.all([
            runResearch({ task, citationStyle: style }, GROQ, budget).then(out => { tResearch(); return out; }),
            detectTaskFormatSmart(task, GROQ, budget).then(fmt => { tFormat(); return fmt; })
        ]);

        console.log('[Swarm] Detected task format:', taskFormat);

        // ── PHASE 2: Write + digest pre-warm, in parallel ────────────────────
        const allFiles = context.uploadedFiles || (context.uploadedFile ? [context.uploadedFile] : []);

        const tWrite = startTimer('write');
        const tDigest = startTimer('digest');

        const { buildSourceDigest } = await import('../_utils/citationHelpers.js');

        const [writeOutput, digest] = await Promise.all([
            runWrite({ task, taskFormat, researchSources: sources, uploadedFiles: allFiles }, GEMINI, budget)
                .then(out => { tWrite(); return out; }),
            (sources.length > 0
                ? buildSourceDigest(sources, style, GEMINI, budget)
                : Promise.resolve({})
            ).then(d => { tDigest(); return d; })
        ]);

        // ── PHASE 3: Humanize + Cite, in parallel (both read writeOutput) ────
        const tHumanize = startTimer('humanize');
        const tCite = startTimer('cite');

        const [humanizeOutput, citeResult] = await Promise.all([
            enableHumanize
                ? runHumanize(writeOutput, budget).then(out => { tHumanize(); return out; })
                : Promise.resolve(null),
            enableCite
                ? runCite({
                    task,
                    taskFormat,
                    previousOutput: writeOutput,
                    researchSources: sources,
                    citationStyle: style,
                    citationType: options.citationType || 'in-text',
                    enableQuotes,
                    preWarmedDigest: digest
                }, GEMINI, GROQ, budget).then(out => { tCite(); return out; })
                : Promise.resolve(null)
        ]);

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
            const tQuotes = startTimer('quotes');
            const quotesResult = await runQuotes({
                task,
                taskFormat,
                previousOutput: mergedText,
                researchSources: sources,
                citationStyle: style,
                quotesHandledInCite,
                sourceDigest
            }, GEMINI, GROQ, budget);
            finalText = quotesResult.text;
            tQuotes();
        }

        // ── PHASE 4: Final QA + Grade, in parallel ────────────────────────────
        const tQA = startTimer('qa');
        const tGrade = startTimer('grade');

        const qaPromise = (!enableQuotes && GROQ && finalText.length > 1000)
            ? checkWithGroq(finalText, taskFormat, GROQ, budget)
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
            bibliographyHtml: citeResult?.bibliographyHtml || bib.html,
            bibliographyPlain: citeResult?.bibliographyPlain || bib.plain,
            sources,
            grade: gradeOutput,
            taskFormat,
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

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { action, options = {} } = req.body;

        if (action === 'plan') {
            return res.status(200).json({ success: true, plan: buildPlan(options) });
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
