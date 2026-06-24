// api/features/_steps/humanize.js
import humanizerHandler from '../humanizer.js';

const isHeaderLine = s => /^[A-Z][A-Z\s\(\)\/\-&]{2,}:?\s*$/.test(s.trim()) && s.trim().length < 80;

async function runHumanizer(text) {
    if (!text.trim()) return text;
    let out = '';
    const mockReq = { method: 'POST', body: { text } };
    const mockRes = { setHeader: () => {}, status: () => ({ end: () => {}, json: d => { out = d; } }) };
    await humanizerHandler(mockReq, mockRes);
    return (out.success && out.result) ? out.result : text;
}

function splitIntoSections(input) {
    const sections = [];
    let cur = null;
    for (const line of input.split('\n')) {
        if (isHeaderLine(line)) {
            if (cur) sections.push(cur);
            cur = { header: line.trim(), lines: [] };
        } else {
            if (!cur) cur = { header: '', lines: [] };
            cur.lines.push(line);
        }
    }
    if (cur) sections.push(cur);
    return sections;
}

/**
 * Humanizes text section by section, batched with a concurrency cap
 * to avoid bursting the humanizer's rate limit.
 */
export async function runHumanize(input, budget, { concurrency = 3 } = {}) {
    if (!input) return '';

    const sections = splitIntoSections(input);
    const humanizedSections = [];

    for (let i = 0; i < sections.length; i += concurrency) {
        const batch = sections.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async section => {
            const bodyText = section.lines.join('\n').trim();
            if (!bodyText) return section.header;

            const bodyLines = section.lines.filter(l => l.trim());
            const isBulletSection = bodyLines.length > 0 && bodyLines.every(l => /^\s*[-•]\s+/.test(l));

            budget.spend('humanize-section');
            let humanizedBody;

            if (isBulletSection) {
                // Batch all bullets into one call — avoids N separate API calls per section
                const combined = bodyLines.map(l => l.replace(/^\s*[-•]\s+/, '')).join('\n');
                const humanizedCombined = await runHumanizer(combined);
                humanizedBody = humanizedCombined.split('\n')
                    .map(l => `- ${l.trim()}`)
                    .filter(l => l.length > 2)
                    .join('\n');
            } else {
                humanizedBody = await runHumanizer(bodyText);
            }

            return section.header ? `${section.header}\n${humanizedBody}` : humanizedBody;
        }));
        humanizedSections.push(...batchResults);
    }

    return humanizedSections.join('\n\n');
}
