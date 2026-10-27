import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { short_id } = req.body;

    if (!short_id) {
        return res.status(400).json({ error: 'short_id is required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Vercel ENV variables missing (SUPABASE_URL or SUPABASE_SERVICE_KEY)' });
    }

    // URL Clean-up safeguard (trailing slash ya /rest/v1 remove karne ke liye)
    const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');

    try {
        const supabase = createClient(cleanUrl, supabaseKey.trim());

        // 1. Fetch Link Data
        const { data: linkData, error: linkErr } = await supabase
            .from('links')
            .select('*')
            .eq('short_id', short_id)
            .single();

        if (linkErr || !linkData) {
            return res.status(404).json({ error: 'Link not found' });
        }

        // 2. Fetch Admin Settings (Live CPM rate ke liye)
        const { data: adminSettings } = await supabase
            .from('settings')
            .select('*')
            .limit(1)
            .single();

        const cpm = adminSettings && adminSettings.cpm ? Number(adminSettings.cpm) : 2.0;
        const earn_amount = cpm / 1000;

        // 3. Update LINK Table (clicks aur earnings increase)
        await supabase
            .from('links')
            .update({
                clicks: (linkData.clicks || 0) + 1,
                earnings: (Number(linkData.earnings) || 0) + earn_amount
            })
            .eq('id', linkData.id);

        // 4. Fetch and Update USER Table (Link owner ka balance aur views update)
        const { data: userData } = await supabase
            .from('users')
            .select('*')
            .eq('id', linkData.user_id)
            .single();

        if (userData) {
            await supabase
                .from('users')
                .update({
                    balance: (Number(userData.balance) || 0) + earn_amount,
                    today_earnings: (Number(userData.today_earnings) || 0) + earn_amount,
                    total_earnings: (Number(userData.total_earnings) || 0) + earn_amount,
                    total_clicks: (userData.total_clicks || 0) + 1,
                    today_clicks: (userData.today_clicks || 0) + 1
                })
                .eq('id', userData.id);

            // 5. Referral Commission Logic
            const referPercent = adminSettings && adminSettings.refer_percent ? Number(adminSettings.refer_percent) : 10;
            
            if (referPercent > 0 && userData.telegram_id) {
                const { data: referralData } = await supabase
                    .from('referrals')
                    .select('referrer_tg_id')
                    .eq('referred_tg_id', userData.telegram_id)
                    .single();

                if (referralData && referralData.referrer_tg_id) {
                    const { data: referrerData } = await supabase
                        .from('users')
                        .select('*')
                        .eq('telegram_id', referralData.referrer_tg_id)
                        .single();

                    if (referrerData) {
                        const referComm = earn_amount * (referPercent / 100);
                        await supabase
                            .from('users')
                            .update({
                                balance: (Number(referrerData.balance) || 0) + referComm,
                                total_earnings: (Number(referrerData.total_earnings) || 0) + referComm
                            })
                            .eq('id', referrerData.id);
                    }
                }
            }
        }

        return res.status(200).json({ success: true, message: 'Reward & Views added successfully' });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
