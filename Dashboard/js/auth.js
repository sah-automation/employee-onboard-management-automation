import { supabase } from './config.js';

// ── Login ──────────────────────────────────────────────────
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  if (error) throw error;
  return data;
}

// ── Logout ─────────────────────────────────────────────────
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
}

// ── Get current session ────────────────────────────────────
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// ── Get current user with role from app_metadata ──────────
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  return {
    id:         user.id,
    email:      user.email,
    role:       user.app_metadata?.role || 'viewer',
    department: user.app_metadata?.department_id || null,
    name:       user.user_metadata?.full_name || user.email
  };
}

// ── Route guard: redirect to login if no session ──────────
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
  return session;
}

// ── Route guard: redirect to app if already logged in ─────
export async function redirectIfAuthed() {
  const session = await getSession();
  if (session) {
    window.location.href = '/app.html';
  }
}

// ── Check if user has required role ───────────────────────
export function hasRole(user, ...roles) {
  return roles.includes(user?.role);
}