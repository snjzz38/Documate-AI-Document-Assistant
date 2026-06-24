import { ScraperAPI } from '../_utils/scraper.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { url } = req.body;
        if (!url) throw new Error("URL is required");

        // FIX: Add a dummy snippet so the scraper doesn't print "undefined" on failure
        const sources = [{ 
            title: "Debug Preview", 
            link: url, 
            snippet: "Debug Mode - Content fetch attempted." 
        }];
        
        const result = await ScraperAPI.scrape(sources);

        return res.status(200).json({ success: true, data: result[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}
