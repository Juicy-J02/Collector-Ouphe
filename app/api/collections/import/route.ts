import { NextRequest, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { db } from "@/lib/server/database";
import {
    SESSION_COOKIE,
    getSessionUser,
} from "@/lib/server/session";

interface ImportedCard {
    scryfallId: string;
    quantity: number;
    condition: string;
    finish: string;
    language: string;
    name: string;
    setCode: string;
    collectorNumber: string;
}

interface ScryfallPrinting {
    id: string;
    collector_number: string;
    finishes: string[];
}

interface ScryfallSearch {
    data: ScryfallPrinting[];
    has_more: boolean;
}

class ImportValidationError extends Error {}

const finishes: Record<string, string> = {
    normal: "nonfoil",
    nonfoil: "nonfoil",
    non_foil: "nonfoil",
    foil: "foil",
    etched: "etched",
    etched_foil: "etched",
};

const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizeValue(value: string): string {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function mapped(
    map: Record<string, string>,
    key: string
): string | undefined {
    return Object.prototype.hasOwnProperty.call(map, key)
        ? map[key]
        : undefined;
}

function parseCard(value: unknown, index: number): ImportedCard {
    function invalid(field: string): never {
        throw new ImportValidationError(
            `Row ${index + 1}: invalid or missing ${field}.`
        );
    }

    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
    ) {
        invalid("card");
    }

    const row = new Map<string, unknown>();

    for (const [key, field] of Object.entries(value)) {
        row.set(key.trim().toLowerCase(), field);
    }

    function text(field: string, fallback = ""): string {
        const fieldValue = row.get(field);

        if (fieldValue === undefined || fieldValue === null) {
            return fallback;
        }

        if (typeof fieldValue !== "string") {
            return invalid(field);
        }

        return fieldValue.trim() || fallback;
    }

    const name = text("name");
    const setCode = text("set code").toLowerCase();
    const collectorNumber = text("collector number");
    const scryfallId = text("scryfall id").toLowerCase();

    if (!name || name.length > 255) {
        invalid("name");
    }

    if (
        setCode.length > 20 ||
        !/^[a-z0-9]+$/.test(setCode)
    ) {
        invalid("set code");
    }

    if (collectorNumber.length > 30) {
        invalid("collector number");
    }

    if (scryfallId && !uuidPattern.test(scryfallId)) {
        invalid("Scryfall ID");
    }

    const rawQuantity = text("quantity", "1");
    const quantity = Number(rawQuantity);

    if (
        !/^[1-9]\d*$/.test(rawQuantity) ||
        !Number.isSafeInteger(quantity) ||
        quantity > 4294967295
    ) {
        invalid("quantity");
    }

    // Preserve arbitrary condition and language text.
    const condition = text("condition", "NM");
    const language = text("language", "en");

    if (condition.length > 50) {
        invalid("condition (maximum 50 characters)");
    }

    if (language.length > 50) {
        invalid("language (maximum 50 characters)");
    }

    const finish = mapped(
        finishes,
        normalizeValue(text("foil", "nonfoil"))
    );

    if (!finish) {
        invalid("foil");
    }

    return {
        scryfallId,
        quantity,
        condition,
        finish,
        language,
        name,
        setCode,
        collectorNumber,
    };
}

async function resolveScryfallId(
    card: ImportedCard,
    index: number
): Promise<string> {
    const params = new URLSearchParams({
        q: `!${JSON.stringify(card.name)} set:${card.setCode}`,
        unique: "prints",
        include_extras: "true",
        include_variations: "true",
    });

    const response = await fetch(
        `https://api.scryfall.com/cards/search?${params}`,
        {
            headers: {
                Accept: "application/json",
                "User-Agent": "Collector Ouphe/0.1",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(15000),
        }
    );

    if (response.status === 404) {
        throw new ImportValidationError(
            `Row ${index + 1}: no printing found for ` +
            `${card.name} in ${card.setCode}.`
        );
    }

    if (!response.ok) {
        throw new Error(
            `Scryfall lookup failed with status ${response.status}.`
        );
    }

    const result: ScryfallSearch = await response.json();

    if (result.has_more) {
        throw new ImportValidationError(
            `Row ${index + 1}: too many matches. Provide a Scryfall ID.`
        );
    }

    const matches = result.data.filter((printing) => {
        const collectorMatches =
            !card.collectorNumber ||
            printing.collector_number.toLowerCase() ===
                card.collectorNumber.toLowerCase();

        return (
            collectorMatches &&
            printing.finishes.includes(card.finish)
        );
    });

    if (matches.length === 0) {
        throw new ImportValidationError(
            `Row ${index + 1}: no printing matches the supplied ` +
            "collector number and finish."
        );
    }

    if (matches.length > 1) {
        throw new ImportValidationError(
            `Row ${index + 1}: multiple printings match ` +
            `${card.name}. Provide a collector number or Scryfall ID.`
        );
    }

    return matches[0].id;
}

export async function POST(request: NextRequest) {
    if (request.headers.get("origin") !== request.nextUrl.origin) {
        return NextResponse.json(
            { error: "Invalid request origin." },
            { status: 403 }
        );
    }

    try {
        const user = await getSessionUser(
            request.cookies.get(SESSION_COOKIE)?.value
        );

        if (!user) {
            return NextResponse.json(
                { error: "Not signed in." },
                { status: 401 }
            );
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { error: "Invalid JSON." },
                { status: 400 }
            );
        }

        if (
            typeof body !== "object" ||
            body === null ||
            !("collectionId" in body) ||
            typeof body.collectionId !== "number" ||
            !Number.isSafeInteger(body.collectionId) ||
            body.collectionId <= 0 ||
            !("rows" in body) ||
            !Array.isArray(body.rows) ||
            body.rows.length === 0 ||
            body.rows.length > 10000
        ) {
            return NextResponse.json(
                {
                    error:
                        "Provide a valid collectionId and 1–10000 CSV rows.",
                },
                { status: 400 }
            );
        }

        const collectionId = body.collectionId;

        // Validate every row before lookups or writes.
        const parsedCards = body.rows.map(parseCard);

        const [ownedCollections] = await db.execute<RowDataPacket[]>(
            `SELECT id
             FROM collections
             WHERE id = ? AND user_id = ?`,
            [collectionId, user.id]
        );

        if (ownedCollections.length === 0) {
            return NextResponse.json(
                { error: "Collection not found." },
                { status: 404 }
            );
        }

        const cards: ImportedCard[] = [];
        const resolvedIds = new Map<string, string>();

        // Only contact Scryfall when an ID is missing.
        for (const [index, card] of parsedCards.entries()) {
            const lookupKey = JSON.stringify([
                card.name,
                card.setCode,
                card.collectorNumber,
                card.finish,
            ]);

            let scryfallId =
                card.scryfallId || resolvedIds.get(lookupKey);

            if (!scryfallId) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 550)
                );

                scryfallId = await resolveScryfallId(card, index);
                resolvedIds.set(lookupKey, scryfallId);
            }

            // Preserve all metadata for the bulk insert.
            cards.push({
                ...card,
                scryfallId,
            });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Recheck ownership and lock during writes.
            const [collections] =
                await connection.execute<RowDataPacket[]>(
                    `SELECT id
                     FROM collections
                     WHERE id = ? AND user_id = ?
                     FOR UPDATE`,
                    [collectionId, user.id]
                );

            if (collections.length === 0) {
                await connection.rollback();

                return NextResponse.json(
                    { error: "Collection not found." },
                    { status: 404 }
                );
            }

            const BATCH_SIZE = 500;

            for (
                let offset = 0;
                offset < cards.length;
                offset += BATCH_SIZE
            ) {
                const batch = cards.slice(
                    offset,
                    offset + BATCH_SIZE
                );

                const placeholders = batch
                    .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .join(", ");

                const values = batch.flatMap((card) => [
                    collectionId,
                    card.scryfallId,
                    card.quantity,
                    card.condition,
                    card.finish,
                    card.language,
                    card.name,
                    card.setCode,
                    card.collectorNumber,
                ]);

                await connection.execute(
                    `INSERT INTO collection_cards (
                        collection_id,
                        scryfall_id,
                        quantity,
                        card_condition,
                        finish,
                        language,
                        card_name,
                        set_code,
                        collector_number
                    )
                    VALUES ${placeholders}
                    ON DUPLICATE KEY UPDATE
                        quantity = quantity + VALUES(quantity),
                        card_name = VALUES(card_name),
                        set_code = VALUES(set_code),
                        collector_number = VALUES(collector_number)`,
                    values
                );
            }

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        return NextResponse.json(
            {
                message: "Cards imported successfully.",
                rowCount: cards.length,
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (error instanceof ImportValidationError) {
            return NextResponse.json(
                { error: error.message },
                { status: 400 }
            );
        }

        console.error("Collection import failed:", error);

        return NextResponse.json(
            { error: "Could not import cards. Please try again later." },
            { status: 500 }
        );
    }
}