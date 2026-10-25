const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    // CORS Headers
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

    if (!supabaseUrl || !supabaseKey) {
         return res.status(500).json({ error: 'Vercel ENV variables missing' });
    }

    // URL Cleanup
    const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

    try {
        const supabase = createClient(cleanUrl, supabaseKey.trim());

        // 1. Fetch Link Data
        const { data: linkData, error: linkErr } = await supabase.from('links').select('*').eq('short_id', short_id).single();
        if (linkErr || !linkData) return res.status(404).json({ error: 'Link not found' });

        // 2. Fetch Admin Settings (For LIVE CPM)
        const { data: adminSettings } = await supabase.from('settings').select('*').limit(1).maybeSingle();
        
        // ⭐ CPM = 3.0 → প্রতি ক্লিকে $0.0030 (আপনার চাহিদা অনুযায়ী)
        const cpm = adminSettings && adminSettings.cpm ? Number(adminSettings.cpm) : 3.0;
        const earn_amount = cpm / 1000; // $0.0030 per click

        // 3. Duplicate Click Check (একই ইউজার একই লিংকে বার বার ক্লিক করলে টাকা যোগ হবে না)
        let isDuplicate = false;
        if (clicker_tg_id) {
            const { data: existingClick } = await supabase
                .from('click_logs')
                .select('id')
                .eq('link_id', linkData.id)
                .eq('clicker_tg_id', clicker_tg_id)
                .limit(1);
            if (existingClick && existingClick.length > 0) isDuplicate = true;
        }

        // ⭐ Self-Click চেক (নিজের লিংকে নিজে ক্লিক করলে টাকা যোগ হবে না)
        let isSelfClick = false;
        const { data: linkOwner } = await supabase.from('users').select('telegram_id').eq('id', linkData.user_id).single();
        if (linkOwner && clicker_tg_id && Number(linkOwner.telegram_id) === Number(clicker_tg_id)) {
            isSelfClick = true;
        }

        // 4. INSERT INTO click_logs (সব ক্লিকই লগ হবে, কিন্তু ফ্রড ক্লিকে টাকা যোগ হবে না)
        await supabase.from('click_logs').insert([{
            link_id: linkData.id,
            clicker_tg_id: clicker_tg_id || null,
            ip_address: req.headers['x-forwarded-for'] || 'unknown'
        }]);

        // ⭐ যদি Duplicate বা Self-Click হয়, তাহলে ব্যালেন্স আপডেট হবে না
        if (isDuplicate || isSelfClick) {
            return res.status(200).json({ 
                success: true, 
                message: 'Click logged but no reward (duplicate/self click)',
                isDuplicate, 
                isSelfClick 
            });
        }

        // 5. Update LINK table (শুধু বৈধ ক্লিকে)
        await supabase.from('links').update({
            clicks: (linkData.clicks || 0) + 1,
            earnings: (linkData.earnings || 0) + earn_amount
        }).eq('id', linkData.id);

        // 6. Fetch and Update USER table (লিংক ওনারের ব্যালেন্স + views)
        const { data: userData } = await supabase.from('users').select('*').eq('id', linkData.user_id).single();
        
        if (userData) {
            await supabase.from('users').update({
                balance: (userData.balance || 0) + earn_amount,
                today_earnings: (userData.today_earnings || 0) + earn_amount,
                total_earnings: (userData.total_earnings || 0) + earn_amount,
                total_clicks: (userData.total_clicks || 0) + 1,
                today_clicks: (userData.today_clicks || 0) + 1
            }).eq('id', userData.id);

            // 7. Referral Commission Logic
            const referPercent = adminSettings && adminSettings.refer_percent ? Number(adminSettings.refer_percent) : 10;
            if (referPercent > 0) {
                const { data: referralData } = await supabase.from('referrals').select('referrer_tg_id').eq('referred_tg_id', userData.telegram_id).maybeSingle();
                if (referralData && referralData.referrer_tg_id) {
                    const { data: referrerData } = await supabase.from('users').select('*').eq('telegram_id', referralData.referrer_tg_id).maybeSingle();
                    if (referrerData) {
                        const referComm = earn_amount * (referPercent / 100);
                        await supabase.from('users').update({
                            balance: (referrerData.balance || 0) + referComm,
                            total_earnings: (referrerData.total_earnings || 0) + referComm
                        }).eq('id', referrerData.id);
                    }
                }
            }
        }

        return res.status(200).json({ 
            success: true, 
            message: 'Reward added successfully',
            earned: earn_amount,
            cpm: cpm
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
