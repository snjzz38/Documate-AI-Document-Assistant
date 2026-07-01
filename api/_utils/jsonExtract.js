// api/_utils/jsonExtract.js
//
// Shared, string-aware JSON extraction + light repair for LLM responses.
// Used anywhere a prompt asks for "return ONLY JSON" but the model may
// wrap it in prose, leave a trailing comma, or use unquoted keys.

/**
 * Finds the first balanced {...} or [...] block in text, respecting
 * strings so braces inside quoted values don't break matching.
 * Returns the matched substring, or null if no balanced block is found.
 */
export function extractBalancedJson(text) {
    const openers = { '{': '}', '[': ']' };
    let startIdx = -1;
    let openChar = null;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{' || text[i] === '[') {
            startIdx = i;
            openChar = text[i];
            break;
        }
    }
    if (startIdx === -1) return null;

    const closeChar = openers[openChar];
    let depth = 0;
    let inString = false;
    let stringChar = null;
    let escaped = false;

    for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === stringChar) {
                inString = false;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
            continue;
        }

        if (ch === openChar) depth++;
        if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                return text.slice(startIdx, i + 1);
            }
        }
    }
    return null; // unbalanced — no clean match
}

/**
 * Light repair for common LLM JSON mistakes: trailing commas, and
 * (cautiously) unquoted keys. Does NOT attempt full recovery of badly
 * broken JSON — just the handful of mistakes models make constantly.
 */
function lightRepair(jsonStr) {
    let repaired = jsonStr;
    // Trailing commas before } or ]
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
    // Unquoted keys: {key: -> {"key":  (only matches simple identifier keys)
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    return repaired;
}

/**
 * Extracts and parses JSON from an LLM response, with:
 *  - string-aware balanced-brace matching (not greedy regex)
 *  - one repair attempt (trailing commas, unquoted keys) if raw parse fails
 * Returns the parsed object, or null if both attempts fail.
 */
export function parseLlmJson(text) {
    const candidate = extractBalancedJson(text);
    if (!candidate) return null;

    try {
        return JSON.parse(candidate);
    } catch (e) {
        try {
            return JSON.parse(lightRepair(candidate));
        } catch (e2) {
            return null;
        }
    }
}
