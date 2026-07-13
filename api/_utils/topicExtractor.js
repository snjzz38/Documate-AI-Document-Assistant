// ==========================================================================
// FILE PATH: api/_utils/topicExtractor.js
// ==========================================================================

/**
 * api/_utils/topicExtractor.js
 * DocuMate Smart Topic Extractor Utility
 * 
 * Table of Contents:
 * 1. Smart Topic Extractor Module
 */

import { GroqAPI } from './groqAPI.js';

// ==========================================================================
// MODULE 1: Smart Topic Extractor
// ==========================================================================
export async function extractTopicSmart(task, groqKey, budget) {
    if (!task) return 'general research';

    // Self-contained light text cleaner (replaces the deleted textCleanup.js imports)
    const cleanTask = task
        .replace(/\s+/g, ' ')
        .trim();

    if (!groqKey) {
        // Fallback: extract first 5 meaningful words if Groq is missing
        const words = cleanTask.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        return words.slice(0, 5).join(' ') || 'general research';
    }

    if (budget && typeof budget.spend === 'function') {
        budget.spend('topic-extraction');
    }

    try {
        const prompt = `You are an expert research assistant. Extract a single, highly optimized academic search phrase (3-6 words) representing the core topic of this task.
Do NOT include search operators, do NOT include quotes, and do NOT include any introductory preamble. Just return the raw search phrase.

TASK:
"${cleanTask.substring(0, 1000)}"

OPTIMIZED SEARCH PHRASE:`;

        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
        
        // Clean up response of any accidental quotes or headers
        let topic = response
            .trim()
            .replace(/^["']|["']$/g, '')
            .replace(/^(topic|search phrase|query):\s*/i, '')
            .replace(/\s+/g, ' ');

        return topic || 'general research';
    } catch (e) {
        console.error('[TopicExtractor] extractTopicSmart failed, using fallback:', e.message);
        const words = cleanTask.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        return words.slice(0, 5).join(' ') || 'general research';
    }
}