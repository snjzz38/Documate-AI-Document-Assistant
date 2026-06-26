// api/_utils/planner.js
//
// Produces a concrete writing brief for any task by having an LLM read the
// actual assignment and specify exactly what the final deliverable must
// contain — sections, required specifics, constraints, tone, and length.
// This replaces rigid format-guessing with task-specific intelligence.
const { GroqAPI } = require('./groqAPI');

const DEFAULT_PLAN = {
    summary: 'Complete the task as directly and completely as the instructions require.',
    instructions: [
        'Read the task carefully and identify every distinct requirement, deliverable, and section it asks for.',
        'Match the format the task implies (prose for essays/briefs/reports; direct answers for questions; structured layout for tables/forms).',
        'If the task asks you to choose or invent a specific subject (city, company, case study, etc.), pick ONE realistic, named example and use it consistently — never stay generic or hypothetical.',
        'Include every concrete element the task demands: data points, timelines, stakeholders, comparisons, criteria, etc.',
        'Respect any stated constraints: word limits, things to avoid, required headings, citation style.',
        'Do not pad or add sections the task did not ask for.'
    ],
    estimatedLength: 'as appropriate to fully address every requirement'
};

// ── JSON extraction & repair ─────────────────────────────────────────

/**
 * Extracts the first complete JSON object from raw LLM text using a
 * brace-depth counter that respects strings and escape sequences.
 * Falls back to greedy slicing only if the counter approach fails.
 */
function extractJSON(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Strategy 1: brace-depth extraction (handles nesting, strings, escapes)
    const start = raw.indexOf('{');
    if (start !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < raw.length; i++) {
            const ch = raw[i];

            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    const candidate = raw.slice(start, i + 1);
                    const parsed = tryParse(candidate);
                    if (parsed) return parsed;
                    break; // depth reached 0 but parse failed — don't keep scanning
                }
            }
        }
    }

    // Strategy 2: non-greedy regex for simple flat objects
    const regexMatch = raw.match(/\{[^{}]*\}/s);
    if (regexMatch) {
        const parsed = tryParse(regexMatch[0]);
        if (parsed) return parsed;
    }

    // Strategy 3: last-resort greedy slice (first { to last })
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) {
        return tryParse(raw.slice(first, last + 1));
    }

    return null;
}

/**
 * Attempts to parse a string as JSON, applying common repairs between
 * each attempt. Returns the parsed object or null.
 */
function tryParse(str) {
    // 1. Direct parse
    try { return JSON.parse(str); } catch (_) { /* continue */ }

    // 2. Remove trailing commas before } or ]
    let r = str.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(r); } catch (_) { /* continue */ }

    // 3. Quote unquoted keys: { key: → { "key":
    r = r.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
    try { return JSON.parse(r); } catch (_) { /* continue */ }

    // 4. Replace single-quoted strings with double-quoted (naive but covers common cases)
    r = str.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    try { return JSON.parse(r); } catch (_) { /* continue */ }

    return null;
}

/**
 * Validates that a parsed object has the minimum shape of a plan.
 */
function isValidPlan(obj) {
    return (
        obj &&
        typeof obj === 'object' &&
        !Array.isArray(obj) &&
        Array.isArray(obj.instructions) &&
        obj.instructions.length > 0 &&
        obj.instructions.every(i => typeof i === 'string' && i.trim().length > 0)
    );
}

// ── Prompt construction ──────────────────────────────────────────────

const SYSTEM_MESSAGE = `You are a writing-brief planner. Your only job: read an assignment and produce a precise, actionable brief that tells a writer exactly what the final deliverable must contain.

You do NOT write the deliverable. You do NOT summarize the assignment. You figure out what satisfying the assignment actually requires and encode that as concrete directives.

Be specific, not vague. Examples:

GOOD instruction: "Include a 3-year phased timeline with specific milestones for each year"
BAD instruction:  "Include a timeline"

GOOD instruction: "Create a table with columns: Risk | Likelihood (High/Med/Low) | Impact | Mitigation — populate with 5-8 realistic risks"
BAD instruction:  "Include a risk table"

GOOD instruction: "Write in formal academic tone, cite sources in APA format"
BAD instruction:  "Use good tone"

Identify:
- OUTPUT FORMAT: prose essay, bullet list, table, mixed, form, numbered steps, etc.
- SECTIONS/HEADINGS: in the order they should appear in the deliverable
- REQUIRED SPECIFICS: data points, names, numbers, examples — if the task says "choose a city/company", instruct the writer to invent ONE specific named example
- CONSTRAINTS: word limits, things to avoid, required terminology, citation style, format restrictions
- TONE and AUDIENCE
- LENGTH: as an approximate word count range (e.g. "800-1200 words")

If the task contains multiple deliverables (e.g. "write an essay AND create a rubric"), cover each one.

Return ONLY a raw JSON object. No markdown fences, no explanation, no commentary.`;

function buildUserPrompt(task) {
    return `TASK:
 ${task}

Produce the writing brief as this exact JSON shape:
{
  "summary": "One sentence describing what the final deliverable fundamentally is",
  "instructions": ["concrete directive 1", "concrete directive 2", "..."],
  "estimatedLength": "e.g. 800-1200 words, or 150-250 words, or as needed"
}

Rules for the instructions array:
- Each entry must be a specific, actionable directive
- Include as many as the task actually requires — no artificial cap
- Cover: output format, sections in order, required specifics, constraints, tone/audience
- If the task implies choosing a subject, include: "Invent one specific, named, realistic [subject type] and use it consistently throughout"
- If there are things to AVOID, state them: "Do NOT include X" or "Avoid Y"

Raw JSON only, nothing else:`;
}

function buildRetryPrompt() {
    return `Your previous response could not be parsed as valid JSON. Common fixes:
- Remove any markdown fences (```json ... ```)
- Remove trailing commas before } or ]
- Ensure all keys are double-quoted
- Ensure all string values are double-quoted
- Do not include any text outside the JSON object

Produce ONLY the raw JSON object now:`;
}

// ── Main entry point ─────────────────────────────────────────────────

const MAX_TASK_LENGTH = 6000;
const TRUNCATION_WARN_THRESHOLD = 5500;

/**
 * Produces a concrete writing brief for the given task via one or two
 * Groq calls. Falls back to DEFAULT_PLAN on any failure so write.js
 * never blocks — worst case it gets generic-but-safe instructions.
 *
 * @param {string} task - The assignment/task text
 * @param {object} GROQ - Groq API configuration
 * @param {object} budget - Budget tracker with spend(key) method
 * @returns {{ summary: string, instructions: string[], estimatedLength: string }}
 */
async function planTask(task, GROQ, budget) {
    // Guard: need a substantive task
    if (!task || typeof task !== 'string' || task.trim().length < 10) {
        return DEFAULT_PLAN;
    }

    // Guard: need API access and budget
    if (!GROQ || !budget?.spend?.('plan-task')) {
        return DEFAULT_PLAN;
    }

    // Truncate if extremely long — warn so logs reveal when requirements may be lost
    let taskText = task;
    if (task.length > MAX_TASK_LENGTH) {
        console.warn(
            `[Planner] Task truncated from ${task.length} to ${MAX_TASK_LENGTH} chars — ` +
            'tail requirements may be lost. Consider providing a shorter task or splitting it.'
        );
        taskText = task.substring(0, MAX_TASK_LENGTH);
    } else if (task.length > TRUNCATION_WARN_THRESHOLD) {
        console.warn(`[Planner] Task is ${task.length} chars, approaching ${MAX_TASK_LENGTH} truncation limit`);
    }

    // ── Attempt 1: fresh call ────────────────────────────────────────
    const messages1 = [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: buildUserPrompt(taskText) }
    ];
    const result1 = await attemptPlan(messages1, GROQ, 'attempt 1');
    if (result1) return result1;

    // ── Attempt 2: retry with parse-failure nudge ────────────────────
    console.warn('[Planner] Attempt 1 failed to produce valid JSON, retrying with format nudge');
    const messages2 = [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: buildUserPrompt(taskText) },
        { role: 'assistant', content: '{' },
        { role: 'user', content: buildRetryPrompt() }
    ];
    const result2 = await attemptPlan(messages2, GROQ, 'attempt 2');
    if (result2) return result2;

    // ── Both failed — fall back silently ─────────────────────────────
    console.warn('[Planner] Both attempts failed, using default plan');
    return DEFAULT_PLAN;
}

/**
 * Single planning attempt: calls Groq, extracts JSON, validates, sanitizes.
 * Returns a clean plan object or null on any failure.
 */
async function attemptPlan(messages, GROQ, label) {
    try {
        const raw = await GroqAPI.chat(messages, GROQ, true);

        if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
            console.warn(`[Planner] ${label}: empty or non-string response`);
            return null;
        }

        const parsed = extractJSON(raw);
        if (!parsed) {
            console.warn(`[Planner] ${label}: could not extract valid JSON (response length: ${raw.length})`);
            return null;
        }

        if (!isValidPlan(parsed)) {
            console.warn(`[Planner] ${label}: JSON parsed but not a valid plan structure`);
            return null;
        }

        // Sanitize: coerce everything to trimmed strings, drop empties
        const cleanInstructions = parsed.instructions
            .map(i => String(i).trim())
            .filter(i => i.length > 0);

        if (cleanInstructions.length === 0) {
            console.warn(`[Planner] ${label}: all instructions were empty after sanitization`);
            return null;
        }

        const plan = {
            summary: String(parsed.summary || DEFAULT_PLAN.summary).trim(),
            instructions: cleanInstructions,
            estimatedLength: String(parsed.estimatedLength || DEFAULT_PLAN.estimatedLength).trim()
        };

        // Soft sanity check: if instructions are absurdly long, the write
        // prompt will bloat — log but don't block (the plan is still valid)
        const totalInstrChars = cleanInstructions.reduce((sum, i) => sum + i.length, 0);
        if (totalInstrChars > 4000) {
            console.warn(
                `[Planner] ${label}: instruction text is ${totalInstrChars} chars — ` +
                'unusually long, may bloat the write prompt'
            );
        }

        return plan;
    } catch (e) {
        console.warn(`[Planner] ${label}: unexpected error — ${e.message}`);
        return null;
    }
}

// ── Formatting for write.js ──────────────────────────────────────────

/**
 * Formats a plan object into the prompt block that write.js injects
 * into its generation prompt.
 *
 * @param {{ summary: string, instructions: string[], estimatedLength: string }} plan
 * @returns {string}
 */
function formatPlanForPrompt(plan) {
    const bulletList = plan.instructions.map(i => `- ${i}`).join('\n');
    return `WRITING BRIEF — what this deliverable needs to be:
 ${plan.summary}

REQUIREMENTS:
 ${bulletList}

LENGTH: ${plan.estimatedLength}`;
}

module.exports = { planTask, formatPlanForPrompt };
