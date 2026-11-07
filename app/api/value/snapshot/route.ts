import { NextRequest, NextResponse } from "next/server";
import type {
    RowDataPacket,
    ResultSetHeader,
} from "mysql2";

import { db } from "@/lib/server/database";
import {
    loadScryfallPrices,
    type Pricing,
} from "@/lib/server/scryfallPrices";
import {
    SESSION_COOKIE,
    getSessionUser,
} from "@/lib/server/session";

interface Variant extends RowDataPacket {
    scryfall_id: string;
    finish: string;
}

function reply(body: object, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: {
            "Cache-Control": "no-store",
        },
    });
}

function priceCents(
    card: Pricing,
    finish: string
): number | null {
    const raw =
        finish === "foil"
            ? card.prices.usd_foil
            : finish === "etched"
                ? card.prices.usd_etched
                : finish === "nonfoil"
                    ? card.prices.usd
                    : null;

    if (
        raw === null ||
        raw === undefined ||
        raw === ""
    ) {
        return null;
    }

    const value = Number(raw);

    return Number.isFinite(value) && value >= 0
        ? Math.round(value * 100)
        : null;
}

async function missingVariants(
    transactionId: string,
    userId: number
): Promise<Variant[]> {
    const [rows] = await db.execute<Variant[]>(
        `SELECT DISTINCT
            ti.scryfall_id,
            ti.finish
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         WHERE t.id = ?
           AND t.user_id = ?
           AND NOT EXISTS (
               SELECT 1
               FROM card_price_snapshots s
               WHERE s.scryfall_id = ti.scryfall_id
                 AND s.finish = ti.finish
                 AND s.currency = 'USD'
                 AND s.recorded_at >= UTC_DATE()
                 AND s.recorded_at <
                     UTC_DATE() + INTERVAL 1 DAY
           )`,
        [transactionId, userId]
    );

    return rows;
}

export async function POST(request: NextRequest) {
    if (
        request.headers.get("origin") !==
        request.nextUrl.origin
    ) {
        return reply(
            { error: "Invalid request origin." },
            403
        );
    }

    try {
        const user = await getSessionUser(
            request.cookies.get(SESSION_COOKIE)?.value
        );

        if (!user) {
            return reply(
                { error: "Not signed in." },
                401
            );
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return reply(
                { error: "Invalid JSON." },
                400
            );
        }

        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !("transactionId" in body)
        ) {
            return reply(
                { error: "Provide a transaction ID." },
                400
            );
        }

        const rawId = body.transactionId;

        const transactionId =
            typeof rawId === "string"
                ? rawId
                : typeof rawId === "number" &&
                    Number.isSafeInteger(rawId)
                    ? String(rawId)
                    : "";

        if (!/^[1-9]\d{0,19}$/.test(transactionId)) {
            return reply(
                { error: "Invalid transaction ID." },
                400
            );
        }

        const [transactions] =
            await db.execute<RowDataPacket[]>(
                `SELECT id, currency
                 FROM transactions
                 WHERE id = ? AND user_id = ?`,
                [transactionId, user.id]
            );

        if (!transactions.length) {
            return reply(
                { error: "Transaction not found." },
                404
            );
        }

        if (transactions[0].currency !== "USD") {
            return reply(
                { error: "Only USD snapshots are supported." },
                400
            );
        }

        // Only request variants without a snapshot today.
        const missing = await missingVariants(
            transactionId,
            user.id
        );

        if (!missing.length) {
            return reply({
                inserted: 0,
                missing: 0,
            });
        }

        const prices = await loadScryfallPrices(missing);

        const priced = missing.flatMap((variant) => {
            const card = prices.get(variant.scryfall_id);

            const cents = card
                ? priceCents(card, variant.finish)
                : null;

            return cents === null
                ? []
                : [{ ...variant, cents }];
        });

        // The lookup succeeded, but the remaining variants have
        // no usable USD price. This is not a server error.
        if (!priced.length) {
            return reply({
                inserted: 0,
                missing: missing.length,
            });
        }

        const conn = await db.getConnection();

        let locked = false;
        let inserted = 0;

        try {
            const [locks] = await conn.execute<
                (RowDataPacket & {
                    acquired: number | null;
                })[]
            >(
                `SELECT GET_LOCK(
                    'prowess_daily_price_snapshots',
                    5
                ) AS acquired`
            );

            if (Number(locks[0]?.acquired) !== 1) {
                return reply(
                    {
                        error:
                            "Price recording is busy. Please retry.",
                    },
                    503
                );
            }

            locked = true;

            await conn.beginTransaction();

            try {
                // Recheck ownership after the external lookups.
                const [owned] =
                    await conn.execute<RowDataPacket[]>(
                        `SELECT id
                         FROM transactions
                         WHERE id = ? AND user_id = ?
                         FOR UPDATE`,
                        [transactionId, user.id]
                    );

                if (!owned.length) {
                    await conn.rollback();

                    return reply(
                        { error: "Transaction not found." },
                        404
                    );
                }

                for (const card of priced) {
                    const [result] =
                        await conn.execute<ResultSetHeader>(
                            `INSERT INTO card_price_snapshots (
                                scryfall_id,
                                finish,
                                currency,
                                price,
                                recorded_at
                            )
                            SELECT ?, ?, 'USD', ?, UTC_TIMESTAMP()
                            WHERE NOT EXISTS (
                                SELECT 1
                                FROM card_price_snapshots
                                WHERE scryfall_id = ?
                                  AND finish = ?
                                  AND currency = 'USD'
                                  AND recorded_at >= UTC_DATE()
                                  AND recorded_at <
                                      UTC_DATE() + INTERVAL 1 DAY
                            )`,
                            [
                                card.scryfall_id,
                                card.finish,
                                (card.cents / 100).toFixed(2),
                                card.scryfall_id,
                                card.finish,
                            ]
                        );

                    inserted += result.affectedRows;
                }

                await conn.commit();
            } catch (error) {
                await conn.rollback();
                throw error;
            }
        } finally {
            try {
                if (locked) {
                    await conn.execute(
                        `SELECT RELEASE_LOCK(
                            'prowess_daily_price_snapshots'
                        )`
                    );
                }
            } finally {
                conn.release();
            }
        }

        const remaining = await missingVariants(
            transactionId,
            user.id
        );

        return reply({
            inserted,
            missing: remaining.length,
        });
    } catch (error) {
        console.error(
            "Automatic snapshot recording failed:",
            error
        );

        return reply(
            {
                error:
                    "Could not record today's prices. Please retry.",
            },
            500
        );
    }
}