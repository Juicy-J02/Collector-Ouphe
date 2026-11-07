"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface CollectionOption {
    id: number;
    name: string;
}

interface TransactionOption {
    id: number;
    name: string;
    type: "purchase" | "sale";
    date: string;
    amountCents: number;
}

interface Props {
    selectedValue: string;
    collections: CollectionOption[];
    transactions: TransactionOption[];
}

interface ViewOption {
    value: string;
    label: string;
    detail: string;
    search: string;
    type?: "purchase" | "sale";
}

const PAGE_SIZE = 8;
const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
});
const controlBaseClass =
    "rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#44e0c5] focus-visible:ring-offset-2 focus-visible:ring-offset-[#071827] disabled:cursor-not-allowed disabled:border-[#425d70] disabled:bg-[#102238] disabled:text-[#91aaba]";
const controlClass =
    `${controlBaseClass} border-[#627f92] bg-[#10283d] text-[#f4f8fc] placeholder:text-[#b6cbd8] enabled:hover:border-[#44e0c5] enabled:hover:bg-[#173b52]`;

function searchText(value: string): string {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export default function ValueViewPicker({
    selectedValue,
    collections,
    transactions,
}: Props) {
    const router = useRouter();
    const [navigating, startTransition] = useTransition();
    const [selected, setSelected] = useState(selectedValue);
    const [category, setCategory] = useState<"collection" | "transaction">(
        selectedValue.startsWith("collection:") ? "collection" : "transaction"
    );
    const [query, setQuery] = useState("");
    const [type, setType] = useState<"all" | "purchase" | "sale">("all");
    const [page, setPage] = useState(1);
    const details = useRef<HTMLDetailsElement>(null);
    const summary = useRef<HTMLElement>(null);
    const search = useRef<HTMLInputElement>(null);

    const collectionOptions = useMemo<ViewOption[]>(() =>
        collections.map((collection) => ({
            value: `collection:${collection.id}`,
            label: collection.name,
            detail: `Collection #${collection.id}`,
            search: searchText(`${collection.name} ${collection.id}`),
        })), [collections]);

    const transactionOptions = useMemo<ViewOption[]>(() =>
        transactions.map((transaction) => ({
            value: `transaction:${transaction.id}`,
            label: transaction.name,
            detail: `${transaction.type === "purchase" ? "Purchase" : "Sale"} · ${transaction.date} · ${money.format(transaction.amountCents / 100)} · #${transaction.id}`,
            search: searchText(
                `${transaction.name} ${transaction.id} ${transaction.type} ${transaction.date} ${money.format(transaction.amountCents / 100)} ${(transaction.amountCents / 100).toFixed(2)}`
            ),
            type: transaction.type,
        })), [transactions]);

    const allOption: ViewOption = category === "collection"
        ? { value: "collection:all", label: "All collections", detail: "Combined collection value", search: "" }
        : { value: "transaction:all", label: "Account overview", detail: "Combined account activity", search: "" };

    const selectedLabel = selected === "collection:all"
        ? "All collections"
        : selected === "transaction:all"
            ? "Account overview"
            : [...collectionOptions, ...transactionOptions].find(
                (option) => option.value === selected
            )?.label ?? "Choose a view";

    const filtered = useMemo(() => {
        const words = searchText(query).trim().split(/\s+/).filter(Boolean);
        const options = category === "collection" ? collectionOptions : transactionOptions;
        return options.filter((option) =>
            (category === "collection" || type === "all" || option.type === type) &&
            words.every((word) => option.search.includes(word))
        );
    }, [query, category, type, collectionOptions, transactionOptions]);

    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const currentPage = Math.min(page, pages);
    const offset = (currentPage - 1) * PAGE_SIZE;
    const visible = filtered.slice(offset, offset + PAGE_SIZE);

    function choose(option: ViewOption) {
        setSelected(option.value);
        if (details.current) details.current.open = false;
        summary.current?.focus();
        if (option.value === selectedValue) return;
        const [kind, id] = option.value.split(":");
        const params = new URLSearchParams({ [kind!]: id! });
        startTransition(() => {
            router.push(`/value?${params.toString()}`, { scroll: false });
        });
    }

    function changeCategory(next: "collection" | "transaction") {
        setCategory(next);
        setQuery("");
        setPage(1);
    }

    function optionButton(option: ViewOption) {
        const active = selected === option.value;
        return (
            <button
                key={option.value}
                type="button"
                aria-pressed={active}
                disabled={navigating}
                onClick={() => choose(option)}
                className={`mb-1 last:mb-0 flex w-full min-w-0 items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#44e0c5] ${active ? "border-[#44e0c5] bg-[#123f47] text-[#f4f8fc]" : "border-[#425d70] bg-[#0c2235] text-[#f4f8fc] hover:border-[#7da4ba] hover:bg-[#173b52]"}`}
            >
                <span className="min-w-0">
                    <span className="block truncate text-sm font-medium" title={option.label}>
                        {option.label}
                    </span>
                    <span className="mt-1 block break-words text-xs text-[#c3d5e2]">
                        {option.detail}
                    </span>
                </span>
                {active && <span aria-hidden="true" className="shrink-0 text-[#67f0d6]">✓</span>}
            </button>
        );
    }

    return (
        <div aria-busy={navigating} className="min-w-0 flex-1 space-y-2 text-[#f4f8fc]">
            <p id="value-view-label" className="text-sm font-semibold text-[#ffe29a]">View value for</p>
            <details
                ref={details}
                className="group min-w-0 rounded-xl border border-[#627f92] bg-[#071827] text-[#f4f8fc] [color-scheme:dark]"
                onToggle={(event) => {
                    if (event.currentTarget.open) search.current?.focus();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        if (details.current) details.current.open = false;
                        summary.current?.focus();
                    }
                }}
            >
                <summary
                    ref={summary}
                    aria-labelledby="value-view-label value-view-current"
                    className="flex min-w-0 cursor-pointer list-none items-center justify-between gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#44e0c5] [&::-webkit-details-marker]:hidden"
                >
                    <span id="value-view-current" className="min-w-0 truncate font-medium" title={selectedLabel}>
                        {selectedLabel}
                    </span>
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 shrink-0 text-[#c3d5e2] transition-transform group-open:rotate-180">
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </summary>

                <div className="min-w-0 space-y-3 border-t border-[#425d70] bg-[#071827] p-3">
                    <div role="group" aria-label="View category" className="grid grid-cols-2 gap-2">
                        {(["collection", "transaction"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={category === value}
                                onClick={() => changeCategory(value)}
                                className={`${controlBaseClass} ${category === value ? "border-[#44e0c5] bg-[#123f47] text-[#f4f8fc]" : "border-[#627f92] bg-[#10283d] text-[#e0eaf2] hover:border-[#7da4ba] hover:bg-[#173b52]"}`}
                            >
                                {value === "collection" ? "Collections" : "Transactions"}
                                {" "}({value === "collection" ? collections.length : transactions.length})
                            </button>
                        ))}
                    </div>

                    <label className="flex flex-col gap-2 text-sm">
                        Search {category === "collection" ? "collections" : "transactions"}
                        <input
                            ref={search}
                            type="search"
                            value={query}
                            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                            onKeyDown={(event) => {
                                // Search should not submit the parent form.
                                if (event.key === "Enter") event.preventDefault();
                            }}
                            placeholder={category === "collection" ? "Name or collection ID…" : "Name, date, amount, or transaction ID…"}
                            className={`${controlClass} w-full`}
                        />
                    </label>

                    {category === "transaction" && (
                        <label className="flex items-center gap-3 text-sm text-[#c3d5e2]">
                            Type
                            <select
                                value={type}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setType(value === "purchase" || value === "sale" ? value : "all");
                                    setPage(1);
                                }}
                                className={`${controlClass} min-w-0 flex-1`}
                            >
                                <option value="all">All transactions</option>
                                <option value="purchase">Purchases</option>
                                <option value="sale">Sales</option>
                            </select>
                        </label>
                    )}

                    {category === "collection" && optionButton(allOption)}

                    <p role="status" aria-live="polite" className="text-xs text-[#c3d5e2]">
                        {filtered.length === 0 ? "No matching results" : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, filtered.length)} of ${filtered.length}`}
                    </p>
                    <div className="max-h-72 min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-[#425d70] bg-[#06121f] p-1" style={{ scrollbarGutter: "stable", scrollbarColor: "#7899ae #06121f" }}>
                        {visible.length ? visible.map(optionButton) : (
                            <div className="p-4 text-sm text-[#c3d5e2]">
                                <p>No {category === "collection" ? "collections" : "transactions"} match these filters.</p>
                                {(query || (category === "transaction" && type !== "all")) && (
                                    <button type="button" onClick={() => { setQuery(""); setType("all"); setPage(1); }} className="mt-2 rounded text-[#ffe29a] underline underline-offset-4 hover:text-[#fff1c9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#44e0c5]">
                                        Clear filters
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {pages > 1 && (
                        <nav aria-label="View results pages" className="flex items-center justify-between gap-2">
                            <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} className={controlClass}>Previous</button>
                            <span className="text-xs text-[#c3d5e2]">{currentPage} / {pages}</span>
                            <button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)} className={controlClass}>Next</button>
                        </nav>
                    )}
                    <p className="text-xs text-[#c3d5e2]">Select a collection or transaction to view its value.</p>
                </div>
            </details>
            {navigating && (
                <p role="status" className="text-sm text-[#c3d5e2]">Loading value…</p>
            )}
        </div>
    );
}
