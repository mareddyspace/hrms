/**
 * Demo mode: shows the sample sign-in accounts, the persona switcher and on-screen verification codes.
 * On while developing; on a hosted build (e.g. Vercel) only when VITE_DEMO_MODE=true is set at build time.
 * Turn it off before real employees use the portal.
 */
export const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";
