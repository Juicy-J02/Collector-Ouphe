const path = require("node:path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({
    path: path.resolve(process.cwd(), ".env.local"),
    quiet: true,
});

dotenv.config({
    path: path.resolve(process.cwd(), ".env"),
    quiet: true,
});

const LOCK_NAME = "prowess_daily_price_snapshots";
const BATCH_SIZE = 75;
const VALID_FINISHES = new Set([
    "nonfoil",
    "foil",
    "etched",
]);

const sleep = (milliseconds) =>
    new Promise((resolve) =>
        setTimeout(resolve, milliseconds)
    );

const variantKey = (id, finish) =>
    `${id.toLowerCase()}:${finish}`;

function priceCents(card, finish) {
    const raw =
        finish === "foil"
            ? card.prices?.usd_foil
            : finish === "etched"
                ? card.prices?.usd_etched
                : finish === "nonfoil"
                    ? card.prices?.usd
                    : null;

    if (raw === null || raw === undefined || raw === "") {
        return null;
    }

    const amount = Number(raw);
    const cents = Math.round(amount * 100);

    // Match the DECIMAL(12,2) price column.
    if (
        !Number.isFinite(amount) ||
        amount < 0 ||
        !Number.isSafeInteger(cents) ||
        cents > 999999999999
    ) {
        return null;
    }

    return cents;
}

async function fetchBatch(ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
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
                signal: AbortSignal.timeout(20000),
            }
        );

        if (
            (response.status === 429 ||
                response.status >= 500) &&
            attempt < 2
        ) {
            const retryAfter = Number(
                response.headers.get("retry-after")
            );

            const delay =
                Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(retryAfter * 1000, 60000)
                    : 2000 * (attempt + 1);

            await sleep(delay);
            continue;
        }

        if (!response.ok) {
            throw new Error(
                `Scryfall lookup failed: HTTP ${response.status}`
            );
        }

        const result = await response.json();

        if (!Array.isArray(result.data)) {
            throw new Error(
                "Scryfall returned an unexpected response."
            );
        }

        return result.data;
    }

    throw new Error("Scryfall lookup could not finish.");
}

async function loadPrices(variants) {
    const ids = [
        ...new Set(
            variants.map((card) =>
                card.scryfall_id.toLowerCase()
            )
        ),
    ].sort();

    const prices = new Map();

    for (
        let offset = 0;
        offset < ids.length;
        offset += BATCH_SIZE
    ) {
        if (offset > 0) {
            await sleep(150);
        }

        const batch = ids.slice(
            offset,
            offset + BATCH_SIZE
        );

        console.log(
            `Fetching printings ${offset + 1}–` +
            `${offset + batch.length} of ${ids.length}…`
        );

        const cards = await fetchBatch(batch);

        for (const card of cards) {
            prices.set(card.id.toLowerCase(), card);
        }
    }

    return prices;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");

    if (args.some((arg) => arg !== "--dry-run")) {
        throw new Error("Only --dry-run is supported.");
    }

    for (const name of [
        "DB_HOST",
        "DB_USER",
        "DB_PASSWORD",
        "DB_NAME",
    ]) {
        if (!process.env[name]) {
            throw new Error(`Missing environment variable: ${name}`);
        }
    }

    const port = Number(process.env.DB_PORT || 3306);

    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new Error("DB_PORT is invalid.");
    }

    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        port,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        supportBigNumbers: true,
        bigNumberStrings: true,
    });

    try {
        const [variants] = await pool.execute(
            `SELECT DISTINCT
                cc.scryfall_id,
                cc.finish
             FROM collection_cards cc
             JOIN collections c ON c.id = cc.collection_id
             WHERE cc.quantity > 0`
        );

        console.log(
            `Found ${variants.length} owned printing/finish variants.`
        );

        // Finish external requests before opening a DB transaction.
        // A failed request stops the job before any writes.
        const prices = await loadPrices(variants);

        let available = 0;

        for (const variant of variants) {
            const card = prices.get(
                variant.scryfall_id.toLowerCase()
            );

            if (
                card &&
                priceCents(card, variant.finish) !== null
            ) {
                available++;
            }
        }

        console.log(
            `Available prices: ${available}/${variants.length}.`
        );

        if (dryRun) {
            console.log(
                "Dry run finished. No database rows were written."
            );
            return;
        }

        const conn = await pool.getConnection();
        let locked = false;

        try {
            const [locks] = await conn.execute(
                "SELECT GET_LOCK(?, 5) AS acquired",
                [LOCK_NAME]
            );

            if (Number(locks[0]?.acquired) !== 1) {
                throw new Error(
                    "Another price recorder is running. Try again later."
                );
            }

            locked = true;

            await conn.beginTransaction();

            try {
                // Capture one UTC day for the entire run.
                const [dates] = await conn.execute(
                    `SELECT DATE_FORMAT(
                        UTC_DATE(),
                        '%Y-%m-%d'
                    ) AS day`
                );

                const day = dates[0].day;

                // Read inventory again after price fetching.
                // Empty collections are included.
                const [inventory] = await conn.execute(
                    `SELECT
                        c.user_id,
                        c.id AS collection_id,
                        cc.scryfall_id,
                        cc.finish,
                        cc.quantity
                     FROM collections c
                     LEFT JOIN collection_cards cc
                       ON cc.collection_id = c.id
                      AND cc.quantity > 0
                     ORDER BY c.user_id, c.id, cc.id`
                );

                const currentVariants = new Map();

                for (const row of inventory) {
                    if (!row.scryfall_id) continue;

                    currentVariants.set(
                        variantKey(
                            row.scryfall_id,
                            row.finish
                        ),
                        {
                            scryfall_id:
                                row.scryfall_id.toLowerCase(),
                            finish: row.finish,
                        }
                    );
                }

                // Reuse any prices already recorded today.
                const [existing] = await conn.execute(
                    `SELECT
                        scryfall_id,
                        finish,
                        price
                     FROM card_price_snapshots
                     WHERE currency = 'USD'
                       AND recorded_at >= DATE(?)
                       AND recorded_at <
                           DATE(?) + INTERVAL 1 DAY
                     ORDER BY recorded_at, id`,
                    [day, day]
                );

                const dailyPrices = new Map();

                for (const row of existing) {
                    const cents = Math.round(
                        Number(row.price) * 100
                    );

                    if (
                        Number.isSafeInteger(cents) &&
                        cents >= 0
                    ) {
                        dailyPrices.set(
                            variantKey(
                                row.scryfall_id,
                                row.finish
                            ),
                            cents
                        );
                    }
                }

                let inserted = 0;

                for (const [key, variant] of currentVariants) {
                    if (dailyPrices.has(key)) continue;

                    if (!VALID_FINISHES.has(variant.finish)) {
                        continue;
                    }

                    const card = prices.get(
                        variant.scryfall_id
                    );

                    const cents = card
                        ? priceCents(card, variant.finish)
                        : null;

                    if (cents === null) continue;

                    await conn.execute(
                        `INSERT INTO card_price_snapshots (
                            scryfall_id,
                            finish,
                            currency,
                            price,
                            recorded_at
                        )
                        VALUES (
                            ?, ?, 'USD', ?,
                            TIMESTAMP(DATE(?), '00:00:00')
                        )`,
                        [
                            variant.scryfall_id,
                            variant.finish,
                            (cents / 100).toFixed(2),
                            day,
                        ]
                    );

                    dailyPrices.set(key, cents);
                    inserted++;
                }

                // Each scope groups quantities by printing/finish.
                const scopes = new Map();

                function getScope(userId, scopeId) {
                    const key = `${userId}:${scopeId}`;

                    if (!scopes.has(key)) {
                        scopes.set(key, {
                            userId: String(userId),
                            scopeId: String(scopeId),
                            variants: new Map(),
                        });
                    }

                    return scopes.get(key);
                }

                for (const row of inventory) {
                    const collectionScope = getScope(
                        row.user_id,
                        row.collection_id
                    );

                    const accountScope = getScope(
                        row.user_id,
                        "0"
                    );

                    if (!row.scryfall_id) continue;

                    const key = variantKey(
                        row.scryfall_id,
                        row.finish
                    );

                    const quantity = BigInt(
                        String(row.quantity)
                    );

                    for (const scope of [
                        collectionScope,
                        accountScope,
                    ]) {
                        scope.variants.set(
                            key,
                            (scope.variants.get(key) ?? 0n) +
                                quantity
                        );
                    }
                }

                for (const scope of scopes.values()) {
                    let totalCents = 0n;
                    let covered = 0;

                    for (const [key, quantity] of scope.variants) {
                        const cents = dailyPrices.get(key);

                        if (cents === undefined) continue;

                        totalCents +=
                            BigInt(cents) * quantity;

                        covered++;
                    }

                    await conn.execute(
                        `INSERT INTO collection_value_snapshots (
                            user_id,
                            scope_id,
                            snapshot_day,
                            value_cents,
                            variant_count,
                            covered
                        )
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            value_cents = VALUES(value_cents),
                            variant_count = VALUES(variant_count),
                            covered = VALUES(covered)`,
                        [
                            scope.userId,
                            scope.scopeId,
                            day,
                            totalCents.toString(),
                            scope.variants.size,
                            covered,
                        ]
                    );
                }

                await conn.commit();

                console.log(
                    `Saved ${inserted} new card-price points for ${day}.`
                );

                console.log(
                    `Updated ${scopes.size} collection/account totals.`
                );
            } catch (error) {
                await conn.rollback();
                throw error;
            }
        } finally {
            try {
                if (locked) {
                    await conn.execute(
                        "SELECT RELEASE_LOCK(?)",
                        [LOCK_NAME]
                    );
                }
            } finally {
                conn.release();
            }
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(
        "Daily price update failed:",
        error instanceof Error
            ? error.message
            : "Unknown error"
    );

    process.exitCode = 1;
});