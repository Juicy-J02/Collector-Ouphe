"use client";

import {
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { importManaboxCSV } from "@/lib/importManaboxCSV";

interface CollectionOption {
    id: number;
    name: string;
}

interface OwnedCard {
    id: number;
    scryfallId: string;
    name: string;
    quantity: number;
    condition: string;
    finish: string;
    language: string;
}

interface PrintingOption {
    id: string;
    name: string;
    set: string;
    set_name: string;
    collector_number: string;
    finishes: string[];
    image_uris?: {
        small?: string;
    };
    card_faces?: {
        image_uris?: {
            small?: string;
        };
    }[];
}

interface CardInput {
    rowKey: number;
    ownedId: string;
    scryfallId: string;
    availableFinishes: string[];
    quantity: string;
    condition: string;
    finish: string;
    language: string;
    cardName: string;
    setCode: string;
    collectorNumber: string;
    importNotice?: string;
}

interface Props {
    collections: CollectionOption[];
}

interface PrintingSearchResult {
    data: PrintingOption[];
    has_more: boolean;
}

const MAX_QUANTITY = 4294967295;
const MAX_ITEMS = 1000;
const BATCH_SIZE = 75;
const CARDS_PER_PAGE = 10;

const SUPPORTED_FINISHES = ["nonfoil", "foil", "etched"];
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputClass =
    "w-full rounded-xl border border-border bg-background p-3 text-foreground";

const buttonClass =
    "rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors enabled:hover:border-teal enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40";

function emptyCard(rowKey: number): CardInput {
    return {
        rowKey,
        ownedId: "",
        scryfallId: "",
        availableFinishes: [],
        quantity: "1",
        condition: "NM",
        finish: "nonfoil",
        language: "en",
        cardName: "",
        setCode: "",
        collectorNumber: "",
    };
}

async function readJSON(response: Response) {
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
        throw new Error(
            `Expected JSON (status ${response.status}). Check the API route.`
        );
    }

    return response.json();
}

// Share one request queue between CSV imports and manual searches.
let searchQueue: Promise<void> = Promise.resolve();

async function queuedScryfallRequest<T>(
    url: string,
    signal: AbortSignal,
    init: RequestInit = {},
    allowNotFound = false
): Promise<T | null> {
    const previous = searchQueue;
    let release!: () => void;

    searchQueue = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous;

    try {
        signal.throwIfAborted();

        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");

        const response = await fetch(url, {
            ...init,
            headers,
            signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(30000),
            ]),
        });

        if (allowNotFound && response.status === 404) {
            return null;
        }

        if (response.status === 429) {
            throw new Error(
                "Scryfall is busy. Wait a moment before trying again."
            );
        }

        if (!response.ok) {
            throw new Error(
                `Card lookup failed (${response.status}).`
            );
        }

        return (await response.json()) as T;
    } finally {
        await new Promise((resolve) => setTimeout(resolve, 550));
        release();
    }
}

async function searchPrintings(
    query: string,
    page: number,
    signal: AbortSignal
): Promise<PrintingSearchResult> {
    const params = new URLSearchParams({
        q: `!${JSON.stringify(query)} game:paper`,
        unique: "prints",
        include_variations: "true",
        order: "released",
        dir: "desc",
        page: String(page),
    });

    const result =
        await queuedScryfallRequest<PrintingSearchResult>(
            `https://api.scryfall.com/cards/search?${params}`,
            signal,
            {},
            true
        );

    return result ?? { data: [], has_more: false };
}

function csvValue(
    row: Record<string, unknown>,
    ...columns: string[]
): string {
    for (const column of columns) {
        const value = row[column];

        if (
            (typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean") &&
            String(value).trim()
        ) {
            return String(value).trim();
        }
    }

    return "";
}

function normalizeCondition(value: string): string {
    const key = value.toLowerCase().replace(/[\s_-]/g, "");

    // Convert export conditions to the conditions used by the form.
    const conditions: Record<string, string> = {
        m: "NM",
        mint: "NM",
        nm: "NM",
        nearmint: "NM",

        ex: "LP",
        excellent: "LP",
        lp: "LP",
        lightplayed: "LP",
        lightlyplayed: "LP",

        gd: "MP",
        good: "MP",
        mp: "MP",
        moderatelyplayed: "MP",

        hp: "HP",
        heavilyplayed: "HP",

        dmg: "DMG",
        damaged: "DMG",
    };

    const condition = conditions[key || "nm"];

    if (!condition) {
        throw new Error(`Unrecognized condition "${value}".`);
    }

    return condition;
}

function normalizeFinish(value: string): string {
    const key = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

    if (!key || ["normal", "regular", "standard", "false", "no", "0", "n"].includes(key)) {
        return "nonfoil";
    }
    if (key.includes("nonfoil") || key.includes("notfoil") || key.includes("nofoil")) {
        return "nonfoil";
    }
    if (key.includes("etched")) return "etched";
    if (key.includes("foil") || ["true", "yes", "1", "y", "f", "holo", "holographic"].includes(key)) {
        return "foil";
    }

    // An unknown finish is reviewed in the form instead of aborting the import.
    return "";
}

function normalizeLanguage(value: string): string {
    const key = value.trim().toLowerCase().replace(/_/g, "-");
    const languages: Record<string, string> = {
        english: "en", japanese: "ja", german: "de", french: "fr",
        italian: "it", spanish: "es", portuguese: "pt", russian: "ru",
        korean: "ko", latin: "la", ancientgreek: "grc", arabic: "ar",
        hebrew: "he", sanskrit: "sa", phyrexian: "ph",
        "ancient greek": "grc", "anglo-saxon": "ang", "old english": "ang",
        "simplified chinese": "zhs", "chinese simplified": "zhs",
        "zh-cn": "zhs", "zh-sg": "zhs", "zh-hans": "zhs",
        "traditional chinese": "zht", "chinese traditional": "zht",
        "zh-tw": "zht", "zh-hk": "zht", "zh-mo": "zht", "zh-hant": "zht",
    };
    if (!key) return "en";
    if (languages[key]) return languages[key];
    if (key.startsWith("zh-hans-")) return "zhs";
    if (key.startsWith("zh-hant-")) return "zht";

    const base = key.split("-")[0]!;
    if (["en", "ja", "de", "fr", "it", "es", "pt", "ru", "ko"].includes(base)) {
        return base;
    }

    // Preserve unfamiliar language values instead of changing them to English.
    // Overlong values remain editable and must be corrected before saving.
    return key;
}

function validQuantity(value: string): boolean {
    const quantity = Number(value);

    return (
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(quantity) &&
        quantity <= MAX_QUANTITY
    );
}

function validatePrinting(
    printing: PrintingOption,
    name: string,
    setCode: string,
    collectorNumber: string
) {
    if (printing.set.toLowerCase() !== setCode.toLowerCase()) {
        throw new Error(
            `${name}: the Scryfall ID does not match ` +
            `set code "${setCode}".`
        );
    }

    if (
        collectorNumber &&
        printing.collector_number.toLowerCase() !==
            collectorNumber.toLowerCase()
    ) {
        throw new Error(
            `${name}: the printing does not match ` +
            `collector number "${collectorNumber}".`
        );
    }
}

async function loadCSVPrintings(
    ids: string[],
    signal: AbortSignal,
    onProgress: (message: string) => void
): Promise<Map<string, PrintingOption>> {
    const uniqueIds = [
        ...new Set(
            ids
                .map((id) => id.trim().toLowerCase())
                .filter(Boolean)
        ),
    ];

    for (const id of uniqueIds) {
        if (!UUID_PATTERN.test(id)) {
            throw new Error(`Invalid Scryfall ID: ${id}`);
        }
    }

    const printings = new Map<string, PrintingOption>();

    for (
        let offset = 0;
        offset < uniqueIds.length;
        offset += BATCH_SIZE
    ) {
        signal.throwIfAborted();

        const batch = uniqueIds.slice(offset, offset + BATCH_SIZE);
        onProgress("Loading…");

        const result = await queuedScryfallRequest<{
            data: PrintingOption[];
        }>(
            "https://api.scryfall.com/cards/collection",
            signal,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    identifiers: batch.map((id) => ({ id })),
                }),
            }
        );

        if (!result || !Array.isArray(result.data)) {
            throw new Error("Scryfall returned an invalid card batch.");
        }

        // Match by ID because response order is not used.
        for (const printing of result.data) {
            printings.set(printing.id.toLowerCase(), printing);
        }
    }

    return printings;
}

// Used only for CSV rows that do not include Scryfall IDs.
async function resolveCSVPrinting(
    name: string,
    setCode: string,
    collectorNumber: string,
    signal: AbortSignal
): Promise<PrintingOption> {
    const matches = new Map<string, PrintingOption>();
    let page = 1;

    while (true) {
        const result = await searchPrintings(name, page, signal);

        for (const printing of result.data) {
            if (
                printing.set.toLowerCase() !==
                setCode.toLowerCase()
            ) {
                continue;
            }

            if (
                collectorNumber &&
                printing.collector_number.toLowerCase() !==
                    collectorNumber.toLowerCase()
            ) {
                continue;
            }

            matches.set(printing.id, printing);
        }

        if (!result.has_more) break;
        page += 1;
    }

    if (matches.size === 0) {
        throw new Error(
            `No matching printing for ${name} (${setCode}` +
            `${collectorNumber ? ` #${collectorNumber}` : ""}).`
        );
    }

    if (matches.size > 1) {
        throw new Error(
            `${name} has multiple matching printings. ` +
            "Include its Collector number or Scryfall ID."
        );
    }

    return Array.from(matches.values())[0]!;
}

function PurchaseCardSearch({
    selectedId,
    onSelect,
}: {
    selectedId: string;
    onSelect: (printing: PrintingOption | null) => void;
}) {
    const [query, setQuery] = useState("");
    const [searchedQuery, setSearchedQuery] = useState("");
    const [results, setResults] = useState<PrintingOption[]>([]);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [searched, setSearched] = useState(false);

    const pending = useRef<AbortController | null>(null);

    useEffect(() => {
        return () => pending.current?.abort();
    }, []);

    async function search(more = false) {
        const term = more ? searchedQuery : query.trim();
        if (!term) return;

        pending.current?.abort();

        const controller = new AbortController();
        pending.current = controller;

        setLoading(true);
        setError("");

        const nextPage = more ? page + 1 : 1;

        if (!more) {
            setResults([]);
            setHasMore(false);
            setSearched(false);
            onSelect(null);
        }

        try {
            const result = await searchPrintings(
                term,
                nextPage,
                controller.signal
            );

            if (controller.signal.aborted) return;

            setResults((current) =>
                more ? [...current, ...result.data] : result.data
            );

            setPage(nextPage);
            setHasMore(result.has_more);
            setSearchedQuery(term);
            setSearched(true);
        } catch (error) {
            if (!controller.signal.aborted) {
                setError(
                    error instanceof Error
                        ? error.message
                        : "Could not search cards."
                );
            }
        } finally {
            if (!controller.signal.aborted) {
                setLoading(false);
            }
        }
    }

    const selected = results.find(
        (printing) => printing.id === selectedId
    );

    const image =
        selected?.image_uris?.small ??
        selected?.card_faces?.[0]?.image_uris?.small;

    return (
        <div className="space-y-3">
            <label className="flex flex-col gap-2">
                Card name

                <input
                    value={query}
                    placeholder="Sol Ring"
                    maxLength={255}
                    onChange={(event) => {
                        pending.current?.abort();
                        setLoading(false);
                        setQuery(event.target.value);
                        setResults([]);
                        setHasMore(false);
                        setSearched(false);
                        setError("");
                        onSelect(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();

                            if (!loading) {
                                void search();
                            }
                        }
                    }}
                    className={inputClass}
                />
            </label>

            <button
                type="button"
                disabled={loading || !query.trim()}
                onClick={() => void search()}
                className={buttonClass}
            >
                {loading ? "Searching…" : "Search Printings"}
            </button>

            <p className="text-sm text-muted">
                Enter the full card name, then choose its set
                and collector number.
            </p>

            {error && (
                <p role="alert" className="text-red-400">
                    {error}
                </p>
            )}

            {searched && !loading && results.length === 0 && (
                <p>No printings found. Check the full card name.</p>
            )}

            {results.length > 0 && (
                <label className="flex flex-col gap-2">
                    Printing

                    <select
                        value={selectedId}
                        required
                        disabled={loading}
                        onChange={(event) =>
                            onSelect(
                                results.find(
                                    (card) =>
                                        card.id === event.target.value
                                ) ?? null
                            )
                        }
                        className={inputClass}
                    >
                        <option value="">Select a printing</option>

                        {results.map((card) => (
                            <option key={card.id} value={card.id}>
                                {card.name} — {card.set_name}
                                {" ("}
                                {card.set.toUpperCase()}
                                {") #"}
                                {card.collector_number}
                            </option>
                        ))}
                    </select>
                </label>
            )}

            {hasMore && (
                <button
                    type="button"
                    disabled={loading}
                    onClick={() => void search(true)}
                    className={buttonClass}
                >
                    Load More Printings
                </button>
            )}

            {selected && (
                <div className="flex items-center gap-4 rounded-xl border border-border p-3">
                    {image && (
                        <img
                            src={image}
                            alt={selected.name}
                            width={100}
                            height={140}
                            className="h-auto rounded"
                        />
                    )}

                    <p>
                        {selected.name}
                        <br />
                        {selected.set_name}
                        {" · #"}
                        {selected.collector_number}
                    </p>
                </div>
            )}
        </div>
    );
}

export default function TransactionForm({ collections }: Props) {
    const router = useRouter();

    const [collectionId, setCollectionId] = useState(
        collections[0] ? String(collections[0].id) : ""
    );

    const [name, setName] = useState("");
    const [type, setType] =
        useState<"purchase" | "sale">("purchase");
    const [totalAmount, setTotalAmount] = useState("");
    const [notes, setNotes] = useState("");

    const [items, setItems] = useState<CardInput[]>([emptyCard(0)]);
    const nextRowKey = useRef(1);
    const [cardPage, setCardPage] = useState(1);

    const totalCardPages = Math.max(
        1,
        Math.ceil(items.length / CARDS_PER_PAGE)
    );
    const currentCardPage = Math.min(cardPage, totalCardPages);
    const cardOffset = (currentCardPage - 1) * CARDS_PER_PAGE;
    const visibleItems = items.slice(
        cardOffset,
        cardOffset + CARDS_PER_PAGE
    );

    const [ownedCards, setOwnedCards] = useState<OwnedCard[]>([]);
    const [loadingCards, setLoadingCards] = useState(false);
    const [cardsError, setCardsError] = useState("");
    const [reload, setReload] = useState(0);

    const [busy, setBusy] = useState(false);
    const savingRef = useRef(false);

    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const [importing, setImporting] = useState(false);
    const [importProgress, setImportProgress] = useState("");
    const [importFileName, setImportFileName] = useState("");

    const importController = useRef<AbortController | null>(null);

    const locked = busy || importing;

    const saleUnavailable =
        type === "sale" &&
        (loadingCards || !!cardsError || ownedCards.length === 0);

    useEffect(() => {
        return () => importController.current?.abort();
    }, []);

    useEffect(() => {
        if (!collectionId || type !== "sale") {
            setOwnedCards([]);
            setLoadingCards(false);
            setCardsError("");
            return;
        }

        const controller = new AbortController();

        setOwnedCards([]);
        setCardsError("");
        setLoadingCards(true);

        async function loadCards() {
            try {
                const response = await fetch(
                    `/api/collections/${collectionId}/cards`,
                    {
                        cache: "no-store",
                        signal: controller.signal,
                    }
                );

                const data = await readJSON(response);

                if (!response.ok) {
                    throw new Error(
                        data.error ?? "Could not load collection cards."
                    );
                }

                if (!Array.isArray(data.cards)) {
                    throw new Error(
                        "The collection API returned an invalid card list."
                    );
                }

                if (!controller.signal.aborted) {
                    setOwnedCards(data.cards);
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    setCardsError(
                        error instanceof Error
                            ? error.message
                            : "Could not load collection cards."
                    );
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoadingCards(false);
                }
            }
        }

        void loadCards();

        return () => controller.abort();
    }, [collectionId, type, reload]);

    function resetSelection() {
        setItems([emptyCard(nextRowKey.current++)]);
        setCardPage(1);
        setImportFileName("");
        setError("");
        setSuccess("");
    }

    function updateItem(
        rowKey: number,
        field: "quantity" | "condition" | "finish" | "language",
        value: string
    ) {
        setItems((current) =>
            current.map((item) =>
                item.rowKey === rowKey
                    ? { ...item, [field]: value }
                    : item
            )
        );
    }

    function selectOwnedCard(rowKey: number, ownedId: string) {
        const card = ownedCards.find(
            (entry) => String(entry.id) === ownedId
        );

        setItems((current) =>
            current.map((item) => {
                if (item.rowKey !== rowKey) return item;
                if (!card) return emptyCard(rowKey);

                return {
                    ...item,
                    ownedId,
                    scryfallId: card.scryfallId,
                    quantity: item.quantity,
                    condition: card.condition,
                    finish: card.finish,
                    language: card.language,
                    cardName: card.name,
                    setCode: "",
                    collectorNumber: "",
                    availableFinishes: [],
                };
            })
        );
    }

    function selectPrinting(
        rowKey: number,
        printing: PrintingOption | null
    ) {
        setItems((current) =>
            current.map((item) => {
                if (item.rowKey !== rowKey) return item;

                if (!printing) {
                    return {
                        ...item,
                        scryfallId: "",
                        cardName: "",
                        setCode: "",
                        collectorNumber: "",
                        availableFinishes: [],
                        finish: "",
                    };
                }

                const supported = printing.finishes.filter(
                    (finish) => SUPPORTED_FINISHES.includes(finish)
                );

                return {
                    ...item,
                    scryfallId: printing.id,
                    cardName: printing.name,
                    setCode: printing.set,
                    collectorNumber: printing.collector_number,
                    availableFinishes: supported,
                    finish: supported.includes(item.finish)
                        ? item.finish
                        : supported[0] ?? "",
                };
            })
        );
    }

    async function handleTransactionCSV(file: File | undefined) {
        if (
            !file ||
            locked ||
            savingRef.current ||
            importController.current
        ) {
            return;
        }

        setError("");
        setSuccess("");

        if (type === "sale" && saleUnavailable) {
            setError(
                "Load your collection cards before importing a sale."
            );
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            setError("Choose a CSV smaller than 5 MB.");
            return;
        }

        const controller = new AbortController();
        importController.current = controller;

        setImporting(true);
        setImportProgress("Loading…");

        try {
            const csv = await file.text();
            controller.signal.throwIfAborted();

            const rows = importManaboxCSV(csv);

            if (rows.length === 0 || rows.length > MAX_ITEMS) {
                throw new Error(
                    `The CSV must contain 1–${MAX_ITEMS} card rows.`
                );
            }

            // Validate the local fields before making API requests.
            const preparedRows = rows.map((rawRow, index) => {
                try {
                    const row =
                        rawRow as unknown as Record<string, unknown>;

                    const cardName = csvValue(row, "Name");
                    const setCode = csvValue(
                        row,
                        "Set code"
                    ).toLowerCase();

                    const collectorNumber = csvValue(
                        row,
                        "Collector number",
                        "Collector Number"
                    );

                    const scryfallId = csvValue(
                        row,
                        "Scryfall ID",
                        "Scryfall Id",
                        "Scryfall id"
                    ).toLowerCase();

                    const quantityText =
                        csvValue(row, "Quantity") || "1";

                    if (!cardName || !setCode) {
                        throw new Error(
                            "Name and Set code are required."
                        );
                    }

                    if (!validQuantity(quantityText)) {
                        throw new Error(
                            "Quantity must be a positive integer."
                        );
                    }

                    if (
                        scryfallId &&
                        !UUID_PATTERN.test(scryfallId)
                    ) {
                        throw new Error("Invalid Scryfall ID.");
                    }

                    return {
                        cardName,
                        setCode,
                        collectorNumber,
                        scryfallId,
                        quantity: Number(quantityText),
                        condition: normalizeCondition(
                            csvValue(row, "Condition")
                        ),
                        rawFinish: csvValue(row, "Foil", "Finish"),
                        finish: normalizeFinish(
                            csvValue(row, "Foil", "Finish")
                        ),
                        language: normalizeLanguage(
                            csvValue(row, "Language")
                        ),
                    };
                } catch (error) {
                    throw new Error(
                        `CSV card row ${index + 1}: ${
                            error instanceof Error
                                ? error.message
                                : "Invalid card."
                        }`
                    );
                }
            });

            const batchPrintings = await loadCSVPrintings(
                preparedRows.map((row) => row.scryfallId),
                controller.signal,
                setImportProgress
            );

            const importedItems: CardInput[] = [];
            const requested = new Map<string, number>();
            const groupedQuantities = new Map<string, number>();
            const fallbackCache = new Map<string, PrintingOption>();

            const ownedByVariant = new Map<string, OwnedCard[]>();

            for (const owned of ownedCards) {
                const key = JSON.stringify([
                    owned.scryfallId.toLowerCase(),
                    owned.condition,
                    owned.finish,
                    owned.language,
                ]);

                const matches = ownedByVariant.get(key) ?? [];
                matches.push(owned);
                ownedByVariant.set(key, matches);
            }

            setImportProgress("Loading…");

            for (const [index, row] of preparedRows.entries()) {
                controller.signal.throwIfAborted();

                try {
                    let printing: PrintingOption;

                    if (row.scryfallId) {
                        const found = batchPrintings.get(
                            row.scryfallId
                        );

                        if (!found) {
                            throw new Error(
                                `Scryfall could not find ${row.cardName} ` +
                                `with ID ${row.scryfallId}.`
                            );
                        }

                        printing = found;
                    } else {
                        const cacheKey = JSON.stringify([
                            row.cardName,
                            row.setCode,
                            row.collectorNumber,
                        ]);

                        let found = fallbackCache.get(cacheKey);

                        if (!found) {
                            setImportProgress("Loading…");

                            found = await resolveCSVPrinting(
                                row.cardName,
                                row.setCode,
                                row.collectorNumber,
                                controller.signal
                            );

                            fallbackCache.set(cacheKey, found);
                        }

                        printing = found;
                    }

                    validatePrinting(
                        printing,
                        row.cardName,
                        row.setCode,
                        row.collectorNumber
                    );

                    const supported = printing.finishes.filter(
                        (finish) => SUPPORTED_FINISHES.includes(finish)
                    );

                    const finish = supported.includes(row.finish) ? row.finish : "";
                    const notices: string[] = [];
                    if (!finish) {
                        notices.push(
                            `CSV finish "${row.rawFinish || "nonfoil"}" needs review. Choose a finish for this printing.`
                        );
                    }
                    if (row.language.length > 100) {
                        notices.push("The language value exceeds 100 characters. Edit it before saving.");
                    }

                    const variantKey = JSON.stringify([
                        printing.id.toLowerCase(),
                        row.condition,
                        row.finish,
                        row.language,
                    ]);

                    const combinedQuantity =
                        (groupedQuantities.get(variantKey) ?? 0) +
                        row.quantity;

                    if (combinedQuantity > MAX_QUANTITY) {
                        throw new Error(
                            "Combined quantity exceeds the limit."
                        );
                    }

                    groupedQuantities.set(
                        variantKey,
                        combinedQuantity
                    );

                    let ownedId = "";

                    if (type === "sale") {
                        const candidates =
                            ownedByVariant.get(variantKey) ?? [];

                        if (candidates.length !== 1 || !finish) {
                            notices.push(
                                "No unique owned variant was selected. Choose the correct card from your collection before saving."
                            );
                        } else {
                            const owned = candidates[0]!;
                            ownedId = String(owned.id);
                            const combined = (requested.get(ownedId) ?? 0) + row.quantity;
                            if (combined > Number(owned.quantity)) {
                                throw new Error(
                                    `The CSV requests ${combined} copies of ${printing.name}, ` +
                                    `but you own ${owned.quantity} in this variant.`
                                );
                            }
                            requested.set(ownedId, combined);
                        }
                    }

                    importedItems.push({
                        rowKey: nextRowKey.current++,
                        ownedId,
                        scryfallId: printing.id,
                        availableFinishes: supported,
                        quantity: String(row.quantity),
                        condition: row.condition,
                        finish,
                        language: row.language,
                        importNotice: notices.join(" "),
                        cardName: printing.name,
                        setCode: printing.set,
                        collectorNumber: printing.collector_number,
                    });
                } catch (error) {
                    controller.signal.throwIfAborted();

                    throw new Error(
                        `CSV card row ${index + 1}: ${
                            error instanceof Error
                                ? error.message
                                : "Could not import this card."
                        }`
                    );
                }
            }

            controller.signal.throwIfAborted();

            // Replace the form only when the whole import succeeds.
            setItems(importedItems);
            setCardPage(1);
            setImportFileName(file.name);

            const reviewCount = importedItems.filter((item) => item.importNotice).length;
            setSuccess(
                `Loaded ${importedItems.length} card rows. ` +
                (reviewCount ? `${reviewCount} rows have import notices. ` : "") +
                "Review the cards, any import notices, and the total, then save the transaction."
            );
        } catch (error) {
            if (!controller.signal.aborted) {
                setError(
                    error instanceof Error
                        ? error.message
                        : "Could not import CSV."
                );
            }
        } finally {
            if (importController.current === controller) {
                importController.current = null;

                if (!controller.signal.aborted) {
                    setImporting(false);
                    setImportProgress("");
                }
            }
        }
    }

    async function handleSubmit(
        event: FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        if (
            locked ||
            savingRef.current ||
            importController.current
        ) {
            return;
        }

        setError("");
        setSuccess("");

        if (!collectionId || !name.trim()) {
            setError(
                "Select a collection and enter a transaction name."
            );
            return;
        }

        if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(totalAmount)) {
            setError("Enter a valid total, such as 25.50.");
            return;
        }

        if (saleUnavailable) {
            setError("Load your collection cards before saving.");
            return;
        }

        if (items.length === 0 || items.length > MAX_ITEMS) {
            setError(`Provide 1–${MAX_ITEMS} card items.`);
            return;
        }

        const requested = new Map<string, number>();
        const groupedQuantities = new Map<string, number>();

        for (const [index, item] of items.entries()) {
            const showCardError = (message: string) => {
                setCardPage(Math.floor(index / CARDS_PER_PAGE) + 1);
                setError(message);
            };
            if (!validQuantity(item.quantity)) {
                showCardError(
                    `Card ${index + 1}: enter a valid quantity.`
                );
                return;
            }

            const quantity = Number(item.quantity);

            if (
                type === "purchase" &&
                (
                    !UUID_PATTERN.test(item.scryfallId) ||
                    !item.cardName ||
                    !item.setCode ||
                    !item.collectorNumber ||
                    !item.availableFinishes.includes(item.finish)
                )
            ) {
                showCardError(
                    `Card ${index + 1}: select a printing and finish.`
                );
                return;
            }

            if (
                type === "purchase" &&
                (!item.language.trim() || item.language.trim().length > 100)
            ) {
                showCardError(
                    `Card ${index + 1}: enter a language value containing 1–100 characters.`
                );
                return;
            }

            const variantKey = JSON.stringify([
                item.scryfallId.toLowerCase(),
                item.condition,
                item.finish,
                item.language,
            ]);

            const combinedVariant =
                (groupedQuantities.get(variantKey) ?? 0) + quantity;

            if (combinedVariant > MAX_QUANTITY) {
                showCardError(
                    `Card ${index + 1}: combined quantity is too large.`
                );
                return;
            }

            groupedQuantities.set(variantKey, combinedVariant);

            if (type === "sale") {
                const owned = ownedCards.find(
                    (card) => String(card.id) === item.ownedId
                );

                if (!owned) {
                    showCardError(
                        `Card ${index + 1}: select an owned card.`
                    );
                    return;
                }

                const combined =
                    (requested.get(item.ownedId) ?? 0) + quantity;

                if (combined > Number(owned.quantity)) {
                    showCardError(
                        `You only own ${owned.quantity} copies ` +
                        `of ${owned.name} in this variant.`
                    );
                    return;
                }

                requested.set(item.ownedId, combined);
            }
        }

        savingRef.current = true;
        setBusy(true);

        try {
            const response = await fetch("/api/transactions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    collectionId: Number(collectionId),
                    name: name.trim(),
                    type,
                    totalAmount,
                    currency: "USD",
                    notes: notes.trim(),
                    items: items.map((item) => ({
                        scryfallId: item.scryfallId,
                        cardName: item.cardName,
                        setCode: item.setCode,
                        collectorNumber: item.collectorNumber,
                        quantity: Number(item.quantity),
                        condition: item.condition,
                        finish: item.finish,
                        language: item.language,
                    })),
                }),
            });

            const data = await readJSON(response);

            if (!response.ok) {
                throw new Error(
                    data.error ?? "Could not save transaction."
                );
            }

            setSuccess("Transaction saved successfully.");
            setName("");
            setTotalAmount("");
            setNotes("");
            setImportFileName("");
            setItems([emptyCard(nextRowKey.current++)]);
            setCardPage(1);

            setOwnedCards([]);
            setLoadingCards(type === "sale");
            setReload((current) => current + 1);

            router.refresh();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : "Could not save transaction."
            );
        } finally {
            savingRef.current = false;
            setBusy(false);
        }
    }

    if (collections.length === 0) {
        return (
            <p className="mt-6">
                <Link href="/collection" className="underline">
                    Create a collection
                </Link>{" "}
                before recording a transaction.
            </p>
        );
    }

    return (
        <form
            onSubmit={handleSubmit}
            aria-busy={locked}
            className="mt-6"
        >
            {error && (
                <p
                    role="alert"
                    className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-300"
                >
                    {error}
                </p>
            )}

            {success && (
                <p
                    role="status"
                    className="mb-4 rounded-xl border border-green-400/25 bg-green-400/10 p-4 text-sm text-green-300"
                >
                    {success}
                </p>
            )}

            <fieldset disabled={locked} className="space-y-6">
                <label className="flex flex-col gap-2">
                    Collection

                    <select
                        value={collectionId}
                        onChange={(event) => {
                            setCollectionId(event.target.value);
                            setOwnedCards([]);
                            setCardsError("");
                            setLoadingCards(type === "sale");
                            resetSelection();
                        }}
                        required
                        className={inputClass}
                    >
                        {collections.map((collection) => (
                            <option
                                key={collection.id}
                                value={collection.id}
                            >
                                {collection.name}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="flex flex-col gap-2">
                    Transaction name

                    <input
                        value={name}
                        onChange={(event) =>
                            setName(event.target.value)
                        }
                        placeholder={
                            type === "sale"
                                ? "Sold my Sol Rings"
                                : "Card shop purchase"
                        }
                        maxLength={100}
                        required
                        className={inputClass}
                    />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-2">
                        Type

                        <select
                            value={type}
                            onChange={(event) => {
                                const nextType =
                                    event.target.value === "sale"
                                        ? "sale"
                                        : "purchase";

                                setType(nextType);
                                setOwnedCards([]);
                                setCardsError("");
                                setLoadingCards(nextType === "sale");
                                resetSelection();
                            }}
                            className={inputClass}
                        >
                            <option value="purchase">Purchase</option>
                            <option value="sale">Sale</option>
                        </select>
                    </label>

                    <label className="flex flex-col gap-2">
                        Total {type === "sale" ? "received" : "paid"} (USD)

                        <input
                            type="text"
                            inputMode="decimal"
                            value={totalAmount}
                            onChange={(event) =>
                                setTotalAmount(event.target.value)
                            }
                            placeholder="5.00"
                            required
                            className={inputClass}
                        />
                    </label>
                </div>

                <p className="text-sm text-muted">
                    {type === "sale"
                        ? "Saving removes the sold quantities."
                        : "Saving adds the purchased quantities."}
                    {" "}The price is the total for the entire transaction.
                </p>

                {type === "sale" && (
                    <div className="space-y-3">
                        {loadingCards && (
                            <p role="status">Loading your cards…</p>
                        )}

                        {cardsError && (
                            <div>
                                <p role="alert" className="text-red-400">
                                    {cardsError}
                                </p>

                                <button
                                    type="button"
                                    onClick={() => {
                                        setLoadingCards(true);
                                        setReload((current) => current + 1);
                                    }}
                                    className={`${buttonClass} mt-2`}
                                >
                                    Try Again
                                </button>
                            </div>
                        )}

                        {!loadingCards &&
                            !cardsError &&
                            ownedCards.length === 0 && (
                                <p>
                                    This collection has no cards to sell.
                                </p>
                            )}
                    </div>
                )}

                <div className="space-y-3 rounded-xl border border-dashed border-teal/35 bg-teal/5 p-5">
                    <label className="flex flex-col gap-3">
                        <span className="font-semibold">
                            Import cards from CSV
                        </span>

                        <span className="text-sm text-muted">
                            Upload a ManaBox export for this{" "}
                            {type === "sale" ? "sale" : "purchase"}.
                            A successful import replaces the card rows below.
                        </span>

                        <input
                            type="file"
                            accept=".csv,text/csv"
                            disabled={locked || saleUnavailable}
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                void handleTransactionCSV(file);
                            }}
                            className={inputClass}
                        />
                    </label>

                    <p className="text-sm text-muted">
                        Name and Set code are required. Including Scryfall ID
                        makes imports faster and identifies the exact printing.
                        Missing optional values default to quantity 1, NM,
                        nonfoil, and English.
                    </p>

                    <p className="text-sm text-muted">
                        {type === "sale"
                            ? "Cards must match the printing, condition, finish, and language you own."
                            : "Purchased cards are added to the selected collection when saved."}
                        {" "}Enter the transaction total separately.
                        Uploading alone does not change inventory.
                    </p>

                    {importing && (
                        <p role="status" className="text-sm text-teal">
                            {importProgress}
                        </p>
                    )}

                    {importFileName && (
                        <p className="break-words text-sm text-muted">
                            Loaded file: {importFileName}
                        </p>
                    )}
                </div>

                <section className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-xl font-semibold">Cards</h2>

                        <span className="badge">
                            {items.length}{" "}
                            {items.length === 1 ? "row" : "rows"}
                        </span>
                    </div>

                    <p className="text-sm text-muted">
                        Showing {cardOffset + 1}–
                        {Math.min(cardOffset + CARDS_PER_PAGE, items.length)}
                        {" "}of {items.length} card rows
                    </p>

                    {visibleItems.map((item, pageIndex) => {
                        const index = cardOffset + pageIndex;
                        const selected = ownedCards.find(
                            (card) => String(card.id) === item.ownedId
                        );

                        return (
                            <div
                                key={item.rowKey}
                                className="space-y-4 rounded-xl border border-border p-4"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <h3 className="font-medium">
                                        Card {index + 1}
                                    </h3>

                                    <button
                                        type="button"
                                        disabled={items.length === 1}
                                        onClick={() => {
                                            setItems((current) =>
                                                current.filter(
                                                    (entry) =>
                                                        entry.rowKey !== item.rowKey
                                                )
                                            );
                                            setCardPage(Math.min(
                                                currentCardPage,
                                                Math.max(1, Math.ceil(
                                                    (items.length - 1) / CARDS_PER_PAGE
                                                ))
                                            ));
                                        }}
                                        className="text-sm text-red-400 disabled:opacity-40"
                                    >
                                        Remove
                                    </button>
                                </div>

                                {item.importNotice && (
                                    <p className="rounded-xl border border-accent/25 bg-accent/5 p-3 text-sm text-accent">
                                        {item.importNotice}
                                    </p>
                                )}

                                {type === "sale" ? (
                                    <>
                                        <label className="flex flex-col gap-2">
                                            Card from your collection

                                            <select
                                                value={item.ownedId}
                                                onChange={(event) =>
                                                    selectOwnedCard(
                                                        item.rowKey,
                                                        event.target.value
                                                    )
                                                }
                                                disabled={saleUnavailable}
                                                required
                                                className={inputClass}
                                            >
                                                <option value="">
                                                    Select a card
                                                </option>

                                                {ownedCards.map((card) => (
                                                    <option
                                                        key={card.id}
                                                        value={card.id}
                                                    >
                                                        {card.name}
                                                        {" · "}
                                                        {card.condition}
                                                        {" · "}
                                                        {card.finish}
                                                        {" · "}
                                                        {card.language}
                                                        {" · "}
                                                        {card.quantity} owned
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        {selected && (
                                            <p className="text-sm text-muted">
                                                {selected.quantity} available.
                                                Printing, condition, finish,
                                                and language are filled
                                                automatically.
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        {item.scryfallId && item.cardName && (
                                            <p className="rounded-xl border border-teal/25 bg-teal/5 p-3 text-sm">
                                                Selected: {item.cardName}
                                                {" · "}
                                                {item.setCode.toUpperCase()}
                                                {" #"}
                                                {item.collectorNumber}
                                            </p>
                                        )}

                                        <PurchaseCardSearch
                                            selectedId={item.scryfallId}
                                            onSelect={(printing) =>
                                                selectPrinting(
                                                    item.rowKey,
                                                    printing
                                                )
                                            }
                                        />

                                        <div className="grid gap-4 sm:grid-cols-3">
                                            <label className="flex flex-col gap-2">
                                                Condition

                                                <select
                                                    value={item.condition}
                                                    onChange={(event) =>
                                                        updateItem(
                                                            item.rowKey,
                                                            "condition",
                                                            event.target.value
                                                        )
                                                    }
                                                    className={inputClass}
                                                >
                                                    {CONDITIONS.map(
                                                        (condition) => (
                                                            <option
                                                                key={condition}
                                                                value={condition}
                                                            >
                                                                {condition}
                                                            </option>
                                                        )
                                                    )}
                                                </select>
                                            </label>

                                            <label className="flex flex-col gap-2">
                                                Finish

                                                <select
                                                    value={
                                                        item.availableFinishes.includes(
                                                            item.finish
                                                        )
                                                            ? item.finish
                                                            : ""
                                                    }
                                                    onChange={(event) =>
                                                        updateItem(
                                                            item.rowKey,
                                                            "finish",
                                                            event.target.value
                                                        )
                                                    }
                                                    required
                                                    className={inputClass}
                                                >
                                                    <option value="">
                                                        Select finish
                                                    </option>

                                                    {item.availableFinishes.map(
                                                        (finish) => (
                                                            <option
                                                                key={finish}
                                                                value={finish}
                                                            >
                                                                {finish}
                                                            </option>
                                                        )
                                                    )}
                                                </select>
                                            </label>

                                            <label className="flex flex-col gap-2">
                                                Language code

                                                <input
                                                    value={item.language}
                                                    onChange={(event) =>
                                                        updateItem(
                                                            item.rowKey,
                                                            "language",
                                                            event.target.value
                                                                .trim()
                                                                .toLowerCase()
                                                        )
                                                    }
                                                    placeholder="en"
                                                    required
                                                    maxLength={100}
                                                    className={inputClass}
                                                />
                                            </label>
                                        </div>
                                    </>
                                )}

                                <label className="flex flex-col gap-2">
                                    Quantity

                                    <input
                                        type="number"
                                        min="1"
                                        max={
                                            type === "sale"
                                                ? selected?.quantity ?? 1
                                                : MAX_QUANTITY
                                        }
                                        step="1"
                                        value={item.quantity}
                                        onChange={(event) =>
                                            updateItem(
                                                item.rowKey,
                                                "quantity",
                                                event.target.value
                                            )
                                        }
                                        required
                                        className={inputClass}
                                    />
                                </label>
                            </div>
                        );
                    })}

                    {totalCardPages > 1 && (
                        <nav
                            aria-label="Card pages"
                            className="flex flex-wrap items-center justify-between gap-3"
                        >
                            <button
                                type="button"
                                disabled={currentCardPage === 1}
                                onClick={() => setCardPage(currentCardPage - 1)}
                                className={buttonClass}
                            >
                                Previous
                            </button>

                            <label className="flex items-center gap-2 text-sm text-muted">
                                Page
                                <select
                                    aria-label="Card page"
                                    value={currentCardPage}
                                    onChange={(event) =>
                                        setCardPage(Number(event.target.value))
                                    }
                                    className="rounded-lg border border-border bg-background p-2 text-foreground"
                                >
                                    {Array.from(
                                        { length: totalCardPages },
                                        (_, index) => (
                                            <option key={index + 1} value={index + 1}>
                                                {index + 1}
                                            </option>
                                        )
                                    )}
                                </select>
                                of {totalCardPages}
                            </label>

                            <button
                                type="button"
                                disabled={currentCardPage === totalCardPages}
                                onClick={() => setCardPage(currentCardPage + 1)}
                                className={buttonClass}
                            >
                                Next
                            </button>
                        </nav>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <button
                            type="button"
                            disabled={
                                items.length >= MAX_ITEMS ||
                                saleUnavailable
                            }
                            onClick={() => {
                                const fresh = emptyCard(
                                    nextRowKey.current++
                                );

                                setItems((current) => [...current, fresh]);
                                setCardPage(Math.ceil(
                                    (items.length + 1) / CARDS_PER_PAGE
                                ));
                            }}
                            className={buttonClass}
                        >
                            Add Another Card
                        </button>

                        <button
                            type="button"
                            onClick={resetSelection}
                            className={buttonClass}
                        >
                            Clear Card Rows
                        </button>
                    </div>
                </section>

                <label className="flex flex-col gap-2">
                    Notes (optional)

                    <textarea
                        value={notes}
                        onChange={(event) =>
                            setNotes(event.target.value)
                        }
                        maxLength={5000}
                        rows={3}
                        className={inputClass}
                    />
                </label>

                <button
                    type="submit"
                    disabled={locked || saleUnavailable}
                    className="inline-flex items-center justify-center rounded-xl border border-[#efd079] bg-[#efd079] px-6 py-3 text-lg font-bold text-[#03101f] shadow-lg shadow-[#efd079]/15 transition-colors enabled:hover:border-[#ffe7a1] enabled:hover:bg-[#ffe7a1] disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {busy
                        ? "Saving…"
                        : importing
                            ? "Loading…"
                            : "Save Transaction"}
                </button>
            </fieldset>
        </form>
    );
}