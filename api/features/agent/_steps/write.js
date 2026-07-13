// api/features/steps/write.js
import { GeminiAPI } from '../../_utils/geminiAPI.js';
import { extractTopic, cleanText } from '../../_utils/textCleanup.js';
import { formatPlanForPrompt } from '../../_utils/planner.js';
import { fmtAuthorLastOnly } from '../../_utils/citationHelpers.js';

/**
 * Writes the task response.
 * `plan` is produced once upstream (agent.js, via planTask) and describes
 * concretely what this deliverable needs to contain — required sections,
 * specifics to invent if missing (e.g. a city), tone, length. This replaces
 * the old detectTaskFormat()/getFormatInstructions() template-matching system.
 */
export async function runWrite({ task, plan, researchSources = [], uploadedFiles = [] }, GEMINI, budget) {
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

    const briefBlock = formatPlanForPrompt(plan);

    const prompt = `Complete the following task accurately.

TASK:
${task}
${pdfContext}${fileContext}
${researchSources.length > 0 ? `\nRESEARCH SOURCES (use for ideas and content only — do NOT include citations, author names, or references in your output now):\n${sourceInfo}` : ''}

${briefBlock}

CRITICAL RULES — ALWAYS APPLY:
- Follow the WRITING BRIEF above exactly — it tells you what this deliverable actually needs
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
