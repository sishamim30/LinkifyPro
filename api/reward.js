const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { short_id, clicker_tg_id } = req.body;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'ENV missing' });
    const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

    try {
        const supabase = createClient(cleanUrl, supabaseKey.trim());

        const { data: linkData, error: linkErr } = await supabase.from('links').select('*').eq('short_id', short_id).single();
        if (linkErr || !linkData) return res.status(404).json({ error: 'Link not found' });
        
        // Error fix: If user_id is null (created from old bug), don't crash
        if (!linkData.user_id) return res.status(400).json({ error: 'This old link has no owner.' });

        const { data: adminSettings } = await supabase.from('settings').select('*').limit(1).maybeSingle();
        const cpm = adminSettings && adminSettings.cpm ? parseFloat(adminSettings.cpm) : 2.0;
        const earn_amount = cpm / 1000;

        await supabase.from('click_logs').insert([{
            link_id: linkData.id,
            clicker_tg_id: clicker_tg_id || null,
            ip_address: req.headers['x-forwarded-for'] || 'unknown'
        }]);

        await supabase.from('links').update({
            clicks: (linkData.clicks || 0) + 1,
            earnings: (parseFloat(linkData.earnings) || 0) + earn_amount
        }).eq('id', linkData.id);

        const { data: userData } = await supabase.from('users').select('*').eq('id', linkData.user_id).single();
        
        if (userData) {
            await supabase.from('users').update({
                balance: (parseFloat(userData.balance) || 0) + earn_amount,
                today_earnings: (parseFloat(userData.today_earnings) || 0) + earn_amount,
                total_earnings: (parseFloat(userData.total_earnings) || 0) + earn_amount,
                total_clicks: (parseInt(userData.total_clicks) || 0) + 1,
                today_clicks: (parseInt(userData.today_clicks) || 0) + 1
            }).eq('id', userData.id);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
