import "server-only";
import { unstable_cache } from "next/cache";

export interface Pricing {
    id: string;
    name: string;
    prices: {
        usd: string | null;
        usd_foil: string | null;
        usd_etched: string | null;
    };
}

interface CollectionResponse {
    data: Pricing[];
}

const BATCH_SIZE = 75;
const REQUEST_GAP_MS = 550;
const REQUEST_TIMEOUT_MS = 30000;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Page renders and snapshot requests share this queue within this server process.
let requestQueue: Promise<void> = Promise.resolve();

async function fetchPriceBatch(ids: string[]): Promise<Pricing[]> {
    const previous = requestQueue;
    let release!: () => void;
    requestQueue = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous;

    try {
        const response = await fetch(
            "https://api.scryfall.com/cards/collection",
            {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": "Collector Ouphe/0.1",
                },
                body: JSON.stringify({
                    identifiers: ids.map((id) => ({ id })),
                }),
                cache: "no-store",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }
        );

        if (response.status === 429) {
            throw new Error(
                "Scryfall temporarily limited price lookups. Wait a moment and retry."
            );
        }

        if (!response.ok) {
            throw new Error(
                `Scryfall price lookup failed (${response.status}). Please retry later.`
            );
        }

        const result: CollectionResponse = await response.json();

        if (!result || !Array.isArray(result.data)) {
            throw new Error("Scryfall returned an invalid price response.");
        }

        for (const card of result.data) {
            if (
                !card ||
                typeof card.id !== "string" ||
                typeof card.name !== "string" ||
                !card.prices ||
                typeof card.prices !== "object"
            ) {
                throw new Error("Scryfall returned invalid card pricing data.");
            }
        }

        return result.data;
    } catch (error) {
        if (
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
            throw new Error(
                "The Scryfall price lookup timed out. Please retry."
            );
        }

        throw error;
    } finally {
        await new Promise((resolve) =>
            setTimeout(resolve, REQUEST_GAP_MS)
        );
        release();
    }
}

// Cache successful responses for one hour. Failed requests throw instead of
// being converted into successful empty responses.
const loadPriceBatch = unstable_cache(
    fetchPriceBatch,
    ["scryfall-price-batch-v2"],
    { revalidate: 3600 }
);

export async function loadScryfallPrices(
    cards: readonly { scryfall_id: string }[]
): Promise<Map<string, Pricing | null>> {
    const ids = [
        ...new Set(
            cards.map((card) => card.scryfall_id.trim().toLowerCase())
        ),
    ].sort();

    for (const id of ids) {
        if (!UUID_PATTERN.test(id)) {
            throw new Error(`Invalid Scryfall ID in stored cards: ${id || "(empty)"}`);
        }
    }

    const prices = new Map<string, Pricing | null>(
        ids.map((id) => [id, null])
    );

    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        const batch = await loadPriceBatch(
            ids.slice(offset, offset + BATCH_SIZE)
        );

        for (const card of batch) {
            const id = card.id.trim().toLowerCase();
            if (prices.has(id)) prices.set(id, card);
        }
    }

    // Preserve callers' original keys as well as canonical lowercase keys.
    for (const card of cards) {
        prices.set(
            card.scryfall_id,
            prices.get(card.scryfall_id.trim().toLowerCase()) ?? null
        );
    }

    return prices;
}
