import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import { useModelCatalog } from "../state/queries.ts";
import { icons, useDismiss } from "./ui.tsx";

const SHOWN_MODELS = 100;

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return value ? String(value) : "";
}

export function ModelPicker({ provider, value, onChange }: {
  provider: string;
  value: string;
  onChange(value: string): void;
}) {
  const catalog = useModelCatalog(provider);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const wrapper = useDismiss(open, () => setOpen(false));
  const models = catalog.data ?? [];
  const selected = models.find((model) => model.id === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = needle
      ? models.filter((model) => `${model.name}\n${model.id}`.toLocaleLowerCase().includes(needle))
      : models;
    return matches.slice(0, SHOWN_MODELS);
  }, [models, query]);

  useEffect(() => setActive(0), [provider, query]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = window.requestAnimationFrame(() => search.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div
      className="model-picker"
      ref={wrapper as RefObject<HTMLDivElement>}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`model-picker-button ${value && catalog.data && !selected ? "unavailable" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!provider}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="model-picker-value">
          <span>{value ? selected?.name ?? value : provider ? catalog.loading ? "Loading models…" : "Choose a model" : "Choose a provider first"}</span>
          {selected && selected.name !== selected.id ? <small>{selected.id}</small> : null}
        </span>
        {icons.chevron}
      </button>
      {open ? (
        <div className="model-picker-menu">
          <input
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => filtered.length ? Math.min(index + 1, filtered.length - 1) : 0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (filtered[active]) choose(filtered[active].id);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder="Search models"
            aria-label="Search models"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
          />
          {catalog.loading ? <p className="model-picker-note">Loading models…</p> : null}
          {catalog.error ? <p className="model-picker-note error-text">Could not load this provider's models.</p> : null}
          {!catalog.loading && !catalog.error ? (
            <div className="model-picker-options" id={listId} role="listbox" aria-label={`${provider} models`}>
              {filtered.map((model, index) => {
                const details = [compactTokens(model.contextWindow), model.reasoning ? "reasoning" : "", model.input.includes("image") ? "vision" : ""].filter(Boolean);
                return (
                  <button
                    type="button"
                    role="option"
                    id={`${listId}-${index}`}
                    aria-selected={model.id === value}
                    className={`model-picker-option ${index === active ? "active" : ""}`}
                    key={model.id}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(model.id)}
                  >
                    <span><b>{model.name}</b>{model.name !== model.id ? <small>{model.id}</small> : null}</span>
                    {details.length ? <em>{details.join(" · ")}</em> : null}
                  </button>
                );
              })}
              {!filtered.length ? <p className="model-picker-note">No matching models.</p> : null}
            </div>
          ) : null}
          {models.length > SHOWN_MODELS && filtered.length === SHOWN_MODELS ? <p className="model-picker-note">Keep typing to narrow the list.</p> : null}
          {value && catalog.data && !selected ? <p className="model-picker-note error-text">The current selection is not in this provider's catalog.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
