// api/features/steps/write.js
import { GeminiAPI } from '../../utils/geminiAPI.js';
import { extractTopic, detectTaskFormat, cleanText } from '../../utils/textCleanup.js';
import { getFormatInstructions } from '../../utils/formatInstructions.js';
import { fmtAuthorLastOnly } from '../../utils/citationHelpers.js';

/**
 * Writes the task response.
 * Extracts uploaded PDFs in parallel with whatever the caller is doing
 * concurrently (e.g. source digest pre-warm) — caller controls that via Promise.all.
 */
export async function runWrite({ task, researchSources = [], uploadedFiles = [] }, GEMINI, budget) {
    const imageFiles = uploadedFiles.filter(f => f.type?.startsWith('image/'));
    const pdfFiles = uploadedFiles.filter(f => f.type === 'application/pdf');
    const otherFiles = uploadedFiles.filter(f => !f.type?.startsWith('image/') && f.type !== 'application/pdf');

    const taskTopic = extractTopic(task);

    const pdfTexts = await Promise.all(pdfFiles.map(async pdf => {
        budget.spend('pdf-extract');
        try {
            return await GeminiAPI.vision(
                `Extract ONLY information relevant to: "${taskTopic}". Summarize key findings, arguments, and data. Skip unrelated sections.`,
                GEMINI,
                [pdf]
            );
        } catch (e) {
            console.error('[Write] PDF extraction failed:', e.message);
            return '';
        }
    }));

    const pdfContext = pdfTexts
        .map((txt, i) => txt ? `\nUPLOADED DOCUMENT (${pdfFiles[i].name}):\n${txt}\n` : '')
        .join('');

    const fileContext = otherFiles.length > 0
        ? `\nUSER FILES: ${otherFiles.map(f => f.name).join(', ')} - consider this context.\n`
        : '';

    const sourceInfo = researchSources.slice(0, 5).map((s, i) =>
        `SOURCE ${i + 1} [Key: ${fmtAuthorLastOnly(s)}, ${s.year}]:\nTitle: "${s.title}"\nSummary: ${(s.text || '').substring(0, 120) || 'N/A'}`
    ).join('\n\n');

    const fmt = detectTaskFormat(task);
    const formatInstructions = getFormatInstructions(fmt);

    const prompt = `Complete the following task accurately.

TASK:
${task}
${pdfContext}${fileContext}
${researchSources.length > 0 ? `\nRESEARCH SOURCES (use for ideas and content only — do NOT include citations, author names, or references in your output now):\n${sourceInfo}` : ''}

${formatInstructions}

CRITICAL RULES — ALWAYS APPLY:
- Do NOT include any in-text citations, author names, or source references anywhere in the output
- Do NOT add a reference list, "Sources:", or bibliography section at the end
- Do NOT mention specific researchers, papers, or organisations by name
- Do NOT start with any preamble — begin with the actual content immediately
- Do NOT use direct quotes from sources — paraphrase all source material
- NEVER start a sentence with "Because" — lead with the subject or claim instead
- NEVER write a vague sentence that makes an observation without naming a specific consequence
${imageFiles.length > 0 ? '- Carefully analyze any uploaded images as part of the response.' : ''}

Complete the task now:`;

    budget.spend('write-gemini');
    const rawText = imageFiles.length > 0
        ? await GeminiAPI.vision(prompt, GEMINI, imageFiles)
        : await GeminiAPI.chat(prompt, GEMINI);

    return cleanText(rawText);
}
