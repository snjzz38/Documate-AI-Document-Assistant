// api/_utils/topicExtractor.js
//
// Replaces naive keyword extraction with an LLM call that actually reads
// the task and identifies the real subject matter — critical for long,
// structured assignments (policy briefs, multi-section prompts) where
// keyword-frequency heuristics pick up meta-text ("due date", "learning
// objectives", "required structure") instead of the actual topic.
//
// Uses Groq rather than Gemini: this is a short, low-ambiguity extraction
// task that doesn't need Gemini's deeper reasoning, and keeps it off the
// Gemini free-tier quota that the rest of the pipeline depends on.
import { GroqAPI } from './groqAPI.js';
import { extractTopic as extractTopicHeuristic } from './textCleanup.js';

/**
 * Extracts the real research topic from a task description using a fast
 * Groq call. Falls back to the keyword heuristic if the API call fails
 * for any reason (quota, network, missing key, etc.) so research never
 * silently breaks — it just degrades to the older behavior.
 */
export async function extractTopicSmart(task, GROQ, budget) {
    if (!task || task.trim().length < 10) {
        return extractTopicHeuristic(task || '');
    }

    if (!GROQ || !budget.spend('topic-extract')) {
        return extractTopicHeuristic(task);
    }

    const prompt = `Read this assignment/task description and identify ONLY the core subject matter to search academic databases for — ignore due dates, formatting instructions, page counts, grading weight, and section structure.

TASK:
${task.substring(0, 3000)}

Return ONLY a short search phrase (5-10 words) naming the actual topic. No preamble, no explanation, no quotes.

Example: if the task is about a "Policy Brief on Urban Heat Island effect mitigation", return: urban heat island effect mitigation strategies

Topic:`;

    try {
        const result = await GroqAPI.chat(
            [{ role: 'user', content: prompt }],
            GROQ,
            false
        );
        const cleaned = result
            .replace(/^["']|["']$/g, '')
            .replace(/^Topic:\s*/i, '')
            .trim();

        // Sanity check: reject if it's empty, too long, or looks like it
        // echoed instruction-words rather than a real topic.
        const looksLikeMeta = /\b(assignment|prompt|instructions?|task|here is|complete)\b/i.test(cleaned);
        if (!cleaned || cleaned.length > 150 || looksLikeMeta) {
            console.warn('[TopicExtractor] Result looked unreliable, falling back to heuristic:', cleaned);
            return extractTopicHeuristic(task);
        }

        return cleaned;
    } catch (e) {
        console.warn('[TopicExtractor] Groq extraction failed, falling back to heuristic:', e.message);
        return extractTopicHeuristic(task);
    }
}
