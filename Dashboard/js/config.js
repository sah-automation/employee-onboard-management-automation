// ============================================================
// TANISITECH ONBOARDING DASHBOARD — CONFIG
// Uses ANON key only — RLS is the security boundary
// NEVER put service role key here
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = '[your-supabase-url]';
const SUPABASE_ANON = '[your-supabase-anon]';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

export const CONFIG = {
  appName:       'Tanisitech Onboarding',
  companyName:   'Tanisitech',
  version:       '1.0.0',
  n8nBaseUrl:    'https://n8n.sahcreatives.com',
  roles: {
    ADMIN:   'admin',
    HR:      'hr',
    IT:      'it',
    MANAGER: 'manager'
  }
};
