const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    // 1. CORS Headers - Vercel Block Fix
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
    // NOTE: This MUST be the SERVICE_ROLE_KEY from Supabase, not Anon Key!
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
         return res.status(500).json({ error: 'Vercel ENV Missing: Add SUPABASE_SERVICE_KEY in Vercel settings.' });
    }

    const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

    try {
        const supabase = createClient(cleanUrl, supabaseKey.trim());

        // 2. Fetch Link Data
        const { data: linkData, error: linkErr } = await supabase.from('links').select('*').eq('short_id', short_id).single();
        if (linkErr || !linkData) return res.status(404).json({ error: 'Link not found in database' });

        // 3. Fetch Admin Settings
        const { data: adminSettings } = await supabase.from('settings').select('*').limit(1).maybeSingle();
        const cpm = adminSettings && adminSettings.cpm ? parseFloat(adminSettings.cpm) : 2.0;
        const earn_amount = cpm / 1000;

        // 4. INSERT INTO click_logs (Daily Report Generation)
        await supabase.from('click_logs').insert([{
            link_id: linkData.id,
            clicker_tg_id: clicker_tg_id || null,
            ip_address: req.headers['x-forwarded-for'] || 'unknown'
        }]);

        // 5. Update LINK table
        await supabase.from('links').update({
            clicks: (linkData.clicks || 0) + 1,
            earnings: (parseFloat(linkData.earnings) || 0) + earn_amount
        }).eq('id', linkData.id);

        // 6. Fetch and Update USER table (Views and Earnings)
        const { data: userData, error: userFetchErr } = await supabase.from('users').select('*').eq('id', linkData.user_id).single();
        
        if (userFetchErr) {
            return res.status(500).json({ error: 'User fetch failed: ' + userFetchErr.message });
        }
        
        if (userData) {
            const { error: userUpdateErr } = await supabase.from('users').update({
                balance: (parseFloat(userData.balance) || 0) + earn_amount,
                today_earnings: (parseFloat(userData.today_earnings) || 0) + earn_amount,
                total_earnings: (parseFloat(userData.total_earnings) || 0) + earn_amount,
                total_clicks: (parseInt(userData.total_clicks) || 0) + 1,
                today_clicks: (parseInt(userData.today_clicks) || 0) + 1
            }).eq('id', userData.id);

            if (userUpdateErr) {
                return res.status(500).json({ error: 'Database Update Error (Column missing?): ' + userUpdateErr.message });
            }

            // 7. Referral Commission Logic
            const referPercent = adminSettings && adminSettings.refer_percent ? adminSettings.refer_percent : 10;
            if (referPercent > 0) {
                const { data: referralData } = await supabase.from('referrals').select('referrer_tg_id').eq('referred_tg_id', userData.telegram_id).maybeSingle();
                if (referralData && referralData.referrer_tg_id) {
                    const { data: referrerData } = await supabase.from('users').select('*').eq('telegram_id', referralData.referrer_tg_id).maybeSingle();
                    if (referrerData) {
                        const referComm = earn_amount * (referPercent / 100);
                        await supabase.from('users').update({
                            balance: (parseFloat(referrerData.balance) || 0) + referComm,
                            total_earnings: (parseFloat(referrerData.total_earnings) || 0) + referComm
                        }).eq('id', referrerData.id);
                    }
                }
            }
        }

        return res.status(200).json({ success: true, message: 'Reward & Views Added!' });

    } catch (error) {
        return res.status(500).json({ error: 'Backend Crash: ' + error.message });
    }
}
