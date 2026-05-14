"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface FiltersProps {
  repos: string[];
}

export function Filters({ repos }: FiltersProps) {
  const router = useRouter();
  const params = useSearchParams();

  const update = useCallback(
    (key: string, value: string) => {
      const sp = new URLSearchParams(params?.toString() ?? "");
      if (value) sp.set(key, value);
      else sp.delete(key);
      sp.delete("page"); // reset pagination on filter change
      router.push(`?${sp.toString()}`);
    },
    [params, router],
  );

  const get = (k: string) => params?.get(k) ?? "";

  const hasAnyFilter =
    Boolean(get("repo")) ||
    Boolean(get("verdict")) ||
    Boolean(get("action")) ||
    Boolean(get("minSev")) ||
    Boolean(get("maxSev"));

  return (
    <div className="flex flex-wrap gap-3 items-end text-sm">
      <label className="flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted mb-1">
          Repo
        </span>
        <select
          className="bg-card border border-border rounded px-2 py-1.5 min-w-[180px]"
          value={get("repo")}
          onChange={(e) => update("repo", e.target.value)}
        >
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted mb-1">
          Verdict
        </span>
        <select
          className="bg-card border border-border rounded px-2 py-1.5"
          value={get("verdict")}
          onChange={(e) => update("verdict", e.target.value)}
        >
          <option value="">Any</option>
          <option value="approve">approve</option>
          <option value="request_changes">request_changes</option>
          <option value="comment">comment</option>
        </select>
      </label>

      <label className="flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted mb-1">
          Action
        </span>
        <select
          className="bg-card border border-border rounded px-2 py-1.5"
          value={get("action")}
          onChange={(e) => update("action", e.target.value)}
        >
          <option value="">Any</option>
          <option value="commented">commented</option>
          <option value="closed">closed</option>
        </select>
      </label>

      <label className="flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted mb-1">
          Sev ≥
        </span>
        <input
          type="number"
          min={1}
          max={10}
          className="bg-card border border-border rounded px-2 py-1.5 w-20"
          value={get("minSev")}
          onChange={(e) => update("minSev", e.target.value)}
        />
      </label>

      <label className="flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted mb-1">
          Sev ≤
        </span>
        <input
          type="number"
          min={1}
          max={10}
          className="bg-card border border-border rounded px-2 py-1.5 w-20"
          value={get("maxSev")}
          onChange={(e) => update("maxSev", e.target.value)}
        />
      </label>

      {hasAnyFilter && (
        <button
          type="button"
          onClick={() => router.push("?")}
          className="text-[11px] font-mono uppercase tracking-wider text-muted hover:text-text underline self-end pb-2"
        >
          clear
        </button>
      )}
    </div>
  );
}
