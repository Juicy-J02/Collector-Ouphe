import type { Card, Prices } from "@/types/scryfall";

export async function getCard(cardName: string): Promise<Card | null> {
    "use cache"
    const params = new URLSearchParams({ exact: cardName });

    const response = await fetch(
        `https://api.scryfall.com/cards/named?${params}`,
        {
            headers: {
                Accept: "application/json",
                "User-Agent": "Collector Ouphe/0.1",
            },
        }
    );

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`Scryfall request failed: ${response.status}`);
    }

    const card: Card = await response.json();
    return card;
}

export async function getCardPrices(cardName: string): Promise<Prices | null> {
    "use cache"
    const params = new URLSearchParams({ exact: cardName });

    const response = await fetch(
        `https://api.scryfall.com/cards/named?${params}`,
        {
            headers: {
                Accept: "application/json",
                "User-Agent": "Collector Ouphe/0.1",
            },
        }
    );

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`Scryfall request failed: ${response.status}`);
    }

    const card: Card = await response.json();
    return card.prices;
}