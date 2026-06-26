// api/_utils/planner.js
//
// Replaces detectTaskFormat() + getFormatInstructions() entirely. Instead
// of guessing which rigid category a task belongs to and pulling a matching
// hardcoded template, this reads the ACTUAL task once and asks an LLM to
// produce a concrete writing brief: what sections/content this specific
// deliverable needs, what concrete specifics must be included (a named
// city, real data points, a timeline — whatever the task actually calls
// for), and how long it should be (as a word count, not a page count, since
// the writer is a token-based model).
import { GroqAPI } from './groqAPI.js';
import { parseLlmJson } from './jsonExtract.js';

const MAX_TASK_CHARS = 6000;

const DEFAULT_PLAN = {
    summary: 'Complete the task as directly and completely as the instructions require.',
    instructions: [
        'Read the task and identify every distinct requirement, deliverable, and section it asks for.',
        'Address each requirement explicitly — do not skip optional-sounding details.',
        'Match the format implied by the task (e.g. write prose if it asks for an essay/brief/report; answer directly if it asks short questions).',
        'If the task requires a concrete example, case, or subject that the user hasn\'t provided (e.g. "choose a city", "pick a company"), invent one reasonable, named, realistic example and use it consistently throughout — do not stay generic or hypothetical.'
    ],
    estimatedWordCount: null // null = "no specific target, use judgment"
};

const SYSTEM_MESSAGE = `You are a planning assistant for an academic/professional writing tool. Your only job is to read a task description and output a concrete, actionable writing brief as JSON. You never write the deliverable itself — only the plan for it. You always return valid JSON with no surrounding prose.`;

const FEW_SHOT_EXAMPLE = `EXAMPLE INPUT TASK:
"Policy Brief: Mitigating the Urban Heat Island (UHI) Effect. Act as a consultant for a mid-sized city (150k-500k) of your choosing. Required sections: Executive Summary, Problem Statement & Local Context, Proposed Interventions, Implementation & Feasibility Strategy, Conclusion & Call to Action, References (8+ sources, APA 7th). 4-6 pages. Tone: professional, persuasive, for a City Council audience."

EXAMPLE GOOD OUTPUT:
{
  "summary": "A persuasive policy brief written for a city council, proposing UHI mitigation strategies for one specific named city.",
  "instructions": [
    "Invent ONE specific, realistic mid-sized city (population 150,000-500,000) and name it explicitly — do not stay generic or hypothetical.",
    "Include the exact section headers in this order: Executive Summary, Problem Statement & Local Context, Proposed Interventions, Implementation & Feasibility Strategy, Conclusion & Call to Action, References.",
    "In Problem Statement & Local Context, invent specific illustrative data for the chosen city: temperature differentials, named vulnerable neighborhoods, estimated health or energy costs.",
    "In Proposed Interventions, recommend exactly three specific interventions (e.g. cool pavements, urban canopy expansion, green roofs) justified with reasoning, not just named.",
    "In Implementation & Feasibility Strategy, include a concrete multi-year timeline, named stakeholders, a specific funding mechanism (e.g. a named bond type or grant program), and one explicit barrier with a concrete mitigation.",
    "Write in a persuasive, accessible tone suited to a City Council audience — avoid dense academic jargon.",
    "Write the Executive Summary as a high-level overview that could be understood in under a minute, even though it appears first in the document.",
    "Include a References section with at least 8 sources in APA 7th format."
  ],
  "estimatedWordCount": 2200
}

Note how the output names a SPECIFIC fictional city is required (not "a city"), gives concrete content for each section, and converts "4-6 pages" into an approximate word count (roughly 550 words/page at 12pt double-spaced academic formatting).`;

function sanitizePlan(parsed) {
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : DEFAULT_PLAN.summary;

    const instructions = Array.isArray(parsed.instructions)
        ? parsed.instructions.filter(i => typeof i === 'string' && i.trim().length > 0).map(i => i.trim())
        : [];

    const estimatedWordCount = typeof parsed.estimatedWordCount === 'number' && parsed.estimatedWordCount > 0
        ? Math.round(parsed.estimatedWordCount)
        : null;

    return {
        summary,
        instructions: instructions.length > 0 ? instructions : DEFAULT_PLAN.instructions,
        estimatedWordCount
    };
}

async function requestPlan(task, GROQ, retryNudge = '') {
    const truncated = task.length > MAX_TASK_CHARS;
    const taskText = task.substring(0, MAX_TASK_CHARS);

    const prompt = `Read this task/assignment description carefully and produce a concrete writing brief for whoever will write the response.
${truncated ? `\nNOTE: the task below was truncated to ${MAX_TASK_CHARS} characters — base your plan on what's shown, but be aware requirements may exist beyond this excerpt.\n` : ''}
TASK:
${taskText}

Your job: figure out exactly what the FINAL DELIVERABLE needs to contain and look like — don't describe the assignment back, identify what's actually required to satisfy it.

Pay special attention to:
- Required sections/headers the deliverable must have (if any) — list them in the exact order requested
- Any concrete specifics the task implies but doesn't supply (e.g. "choose a city", "pick a company", "select a case study") — if so, say the writer must invent ONE specific, named, realistic example and use it consistently, rather than staying generic
- Required elements like data points, a timeline, stakeholders, a funding mechanism, a rubric criterion — anything the grading/evaluation would check for
- Tone and audience (e.g. "persuasive, written for a city council" vs "formal academic")
- Approximate length if specified, converted to an estimated WORD COUNT (not pages) — roughly 550 words per page for standard 12pt double-spaced formatting

Distinguish: a numbered/bulleted task description is often just the ASSIGNMENT'S OWN organization (overview, objectives, rubric, submission instructions) — not necessarily the deliverable's structure. Figure out what the deliverable itself needs, which may differ from how the prompt itself is organized.

${FEW_SHOT_EXAMPLE}

Now produce the plan for the TASK above. Return ONLY valid JSON in this exact shape, nothing else, no surrounding prose:
{
  "summary": "one sentence describing what the deliverable fundamentally is",
  "instructions": ["specific instruction 1", "specific instruction 2", "..."],
  "estimatedWordCount": 2200
}

Include as many instructions as the task genuinely requires — do not artificially limit the count, and do not pad with filler if the task is simple. Each instruction must be concrete and actionable, not vague advice.
${retryNudge}
Return ONLY the JSON object:`;

    const raw = await GroqAPI.chat(
        [
            { role: 'system', content: SYSTEM_MESSAGE },
            { role: 'user', content: prompt }
        ],
        GROQ,
        true
    );

    return parseLlmJson(raw);
}

/**
 * Produces a concrete writing brief for the given task via a Groq call,
 * with one retry on parse failure before falling back to a generic plan.
 *
 * Returns: { summary, instructions: string[], estimatedWordCount: number|null }
 */
export async function planTask(task, GROQ, budget) {
    if (!task || task.trim().length < 10) {
        return DEFAULT_PLAN;
    }

    if (!GROQ || !budget.spend('plan-task')) {
        return DEFAULT_PLAN;
    }

    let parsed = null;
    try {
        parsed = await requestPlan(task, GROQ);
    } catch (e) {
        console.warn('[Planner] First attempt failed:', e.message);
    }

    if (!parsed || !Array.isArray(parsed.instructions) || parsed.instructions.length === 0) {
        // One retry with an explicit nudge — cheap, and rescues a meaningful
        // share of malformed-JSON failures.
        if (budget.spend('plan-task-retry')) {
            try {
                parsed = await requestPlan(
                    task,
                    GROQ,
                    '\nYour previous response was not valid JSON or was missing required fields. Return ONLY a single valid JSON object exactly matching the shape requested — no markdown fences, no commentary.\n'
                );
            } catch (e) {
                console.warn('[Planner] Retry also failed:', e.message);
            }
        }
    }

    if (!parsed || !Array.isArray(parsed.instructions) || parsed.instructions.length === 0) {
        console.warn('[Planner] Both attempts failed, using default plan');
        return DEFAULT_PLAN;
    }

    return sanitizePlan(parsed);
}

/**
 * Formats a plan object into the prompt block write.js injects into its
 * generation prompt.
 */
export function formatPlanForPrompt(plan) {
    const instructionLines = plan.instructions.map(i => `- ${i}`).join('\n');
    const lengthLine = plan.estimatedWordCount
        ? `LENGTH: approximately ${plan.estimatedWordCount} words`
        : `LENGTH: as appropriate to the task`;

    return `WRITING BRIEF — what this deliverable needs to be:
${plan.summary}

REQUIREMENTS:
${instructionLines}

${lengthLine}`;
}
