"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface FiltersProps {
  repos: string[];
}

const SELECT =
  "bg-bg border border-border rounded-sm px-2 py-1.5 text-sm font-mono focus:border-white focus:outline-none";

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
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col">
        <span className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Repo
        </span>
        <select
          className={`${SELECT} min-w-[180px]`}
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
        <span className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Verdict
        </span>
        <select
          className={SELECT}
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
        <span className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Action
        </span>
        <select
          className={SELECT}
          value={get("action")}
          onChange={(e) => update("action", e.target.value)}
        >
          <option value="">Any</option>
          <option value="commented">commented</option>
          <option value="closed">closed</option>
        </select>
      </label>

      <label className="flex flex-col">
        <span className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Sev ≥
        </span>
        <input
          type="number"
          min={1}
          max={10}
          className={`${SELECT} w-20`}
          value={get("minSev")}
          onChange={(e) => update("minSev", e.target.value)}
        />
      </label>

      <label className="flex flex-col">
        <span className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Sev ≤
        </span>
        <input
          type="number"
          min={1}
          max={10}
          className={`${SELECT} w-20`}
          value={get("maxSev")}
          onChange={(e) => update("maxSev", e.target.value)}
        />
      </label>

      {hasAnyFilter && (
        <button
          type="button"
          onClick={() => router.push("?")}
          className="self-end pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted underline underline-offset-4 hover:text-text"
        >
          clear
        </button>
      )}
    </div>
  );
}
