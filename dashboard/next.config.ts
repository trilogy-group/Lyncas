import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Client-side router cache. Next 16 defaults dynamic page segments to
  // 0s, which means every dashboard page switch re-runs its server-side
  // Supabase queries and shows a loading skeleton. We keep dynamic
  // payloads for a short window and fully-prefetched (static) payloads
  // for longer so navigating between already-visited pages is instant.
  // After a mutation, components already call router.refresh() to bust
  // this cache where freshness matters.
  experimental: {
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
};

export default nextConfig;
