import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import type { RowDataPacket } from "mysql2";

import AutoRecordSnapshot from "@/components/AutoRecordSnapshot";
import ValueCardsTable from "@/components/valueCardsTable";
import ValueViewPicker from "@/components/valueViewPicker";
import { db } from "@/lib/server/database";
import {
    loadScryfallPrices,
    type Pricing,
} from "@/lib/server/scryfallPrices";
import {
    SESSION_COOKIE,
    getSessionUser,
} from "@/lib/server/session";

type Params = Record<string, string | string[] | undefined>;

interface Props {
    searchParams: Promise<Params>;
}

interface BasketCard extends RowDataPacket {
    scryfall_id: string;
    finish: string;
    quantity: string | number;
}

interface TransactionRow extends RowDataPacket {
    id: number;
    name: string;
    type: "purchase" | "sale";
    currency: string;
    amount_cents: number | string;
    occurred_at_sql: string;
}

interface CollectionRow extends RowDataPacket {
    id: number;
    name: string;
}

interface SnapshotRow extends RowDataPacket {
    scryfall_id: string;
    finish: string;
    day: string;
    price_cents: string | number;
}

interface CollectionSnapshotRow extends RowDataPacket {
    day: string;
    cents: string | number | null;
    covered: string | number;
    variant_count: string | number;
}

interface HistoryPoint {
    day: string;
    cents: number | null;
    covered: number;
    variantCount?: number;
}

const usd = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
});

const money = (cents: number) => usd.format(cents / 100);

const variantKey = (id: string, finish: string) =>
    `${id}:${finish}`;

function selection(value: unknown): string {
    if (
        value === undefined ||
        value === null ||
        value === "all"
    ) {
        return "all";
    }

    if (
        typeof value !== "string" ||
        !/^[1-9]\d{0,19}$/.test(value)
    ) {
        notFound();
    }

    return value;
}

async function requireUser() {
    const store = await cookies();

    const user = await getSessionUser(
        store.get(SESSION_COOKIE)?.value
    );

    if (!user) {
        redirect("/signin");
    }

    return user;
}

async function loadBasket(
    userId: number,
    selectedId: string
) {
    if (selectedId === "all") {
        const [cards] = await db.execute<BasketCard[]>(
            `SELECT
                cc.scryfall_id,
                cc.finish,
                SUM(cc.quantity) AS quantity
             FROM collection_cards cc
             JOIN collections c ON c.id = cc.collection_id
             WHERE c.user_id = ?
               AND cc.quantity > 0
             GROUP BY cc.scryfall_id, cc.finish`,
            [userId]
        );

        return {
            cards,
            transaction: null as TransactionRow | null,
        };
    }

    const [transactions] = await db.execute<TransactionRow[]>(
        `SELECT
            id,
            name,
            type,
            currency,
            total_amount * 100 AS amount_cents,
            DATE_FORMAT(
                occurred_at,
                '%Y-%m-%d %H:%i:%s'
            ) AS occurred_at_sql
         FROM transactions
         WHERE id = ?
           AND user_id = ?`,
        [selectedId, userId]
    );

    if (
        !transactions.length ||
        transactions[0].currency !== "USD"
    ) {
        notFound();
    }

    const [cards] = await db.execute<BasketCard[]>(
        `SELECT
            ti.scryfall_id,
            ti.finish,
            SUM(ti.quantity) AS quantity
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         WHERE t.id = ?
           AND t.user_id = ?
         GROUP BY ti.scryfall_id, ti.finish`,
        [selectedId, userId]
    );

    return {
        cards,
        transaction: transactions[0],
    };
}

async function loadCollectionBasket(
    userId: number,
    collectionId: string
) {
    if (collectionId === "all") {
        return loadBasket(userId, "all");
    }

    const [owned] = await db.execute<CollectionRow[]>(
        `SELECT id, name
         FROM collections
         WHERE id = ?
           AND user_id = ?`,
        [collectionId, userId]
    );

    if (!owned.length) {
        notFound();
    }

    const [cards] = await db.execute<BasketCard[]>(
        `SELECT
            cc.scryfall_id,
            cc.finish,
            SUM(cc.quantity) AS quantity
         FROM collection_cards cc
         JOIN collections c ON c.id = cc.collection_id
         WHERE c.id = ?
           AND c.user_id = ?
           AND cc.quantity > 0
         GROUP BY cc.scryfall_id, cc.finish`,
        [collectionId, userId]
    );

    return {
        cards,
        transaction: null as TransactionRow | null,
    };
}

function unitCents(
    pricing: Pricing | null | undefined,
    finish: string
): number | null {
    const raw =
        finish === "foil"
            ? pricing?.prices.usd_foil
            : finish === "etched"
                ? pricing?.prices.usd_etched
                : finish === "nonfoil"
                    ? pricing?.prices.usd
                    : null;

    if (
        raw === null ||
        raw === undefined ||
        raw === ""
    ) {
        return null;
    }

    const amount = Number(raw);

    return Number.isFinite(amount) && amount >= 0
        ? Math.round(amount * 100)
        : null;
}

async function recordCollectionSnapshot(
    userId: number,
    collectionId: string,
    cards: BasketCard[],
    prices: Map<string, Pricing | null>
) {
    let cents = 0;
    let covered = 0;

    for (const card of cards) {
        const price = unitCents(
            prices.get(card.scryfall_id),
            card.finish
        );

        if (price !== null) {
            covered++;
            cents += price * Number(card.quantity);
        }
    }

    // Scope 0 represents all collections combined.
    // Only cards with available prices contribute to the total.
    await db.execute(
        `INSERT INTO collection_value_snapshots (
            user_id,
            scope_id,
            snapshot_day,
            value_cents,
            variant_count,
            covered
         )
         VALUES (?, ?, UTC_DATE(), ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            value_cents = VALUES(value_cents),
            variant_count = VALUES(variant_count),
            covered = VALUES(covered)`,
        [
            userId,
            collectionId === "all" ? "0" : collectionId,
            cents,
            cards.length,
            covered,
        ]
    );
}

async function loadCollectionHistory(
    userId: number,
    collectionId: string
): Promise<HistoryPoint[]> {
    const [rows] = await db.execute<CollectionSnapshotRow[]>(
        `SELECT
            DATE_FORMAT(
                snapshot_day,
                '%Y-%m-%d'
            ) AS day,
            value_cents AS cents,
            covered,
            variant_count
         FROM collection_value_snapshots
         WHERE user_id = ?
           AND scope_id = ?
           AND snapshot_day >=
               UTC_DATE() - INTERVAL 90 DAY
           AND snapshot_day <= UTC_DATE()
         ORDER BY snapshot_day`,
        [
            userId,
            collectionId === "all" ? "0" : collectionId,
        ]
    );

    return rows.map((row) => ({
        day: row.day,
        cents:
            row.cents === null ||
            (Number(row.covered) === 0 && Number(row.variant_count) > 0)
                ? null
                : Number(row.cents),
        covered: Number(row.covered),
        variantCount: Number(row.variant_count),
    }));
}

function buildHistory(
    cards: BasketCard[],
    rows: SnapshotRow[]
): HistoryPoint[] {
    const days = new Map<string, Map<string, number>>();

    for (const row of rows) {
        const prices =
            days.get(row.day) ?? new Map<string, number>();

        prices.set(
            variantKey(row.scryfall_id, row.finish),
            Number(row.price_cents)
        );

        days.set(row.day, prices);
    }

    return [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, prices]) => {
            let cents = 0;
            let covered = 0;

            for (const card of cards) {
                const price = prices.get(
                    variantKey(card.scryfall_id, card.finish)
                );

                if (price !== undefined) {
                    covered++;
                    cents += price * Number(card.quantity);
                }
            }

            return {
                day,
                covered,
                variantCount: cards.length,
                cents: covered > 0 ? cents : null,
            };
        });
}

async function loadHistory(
    cards: BasketCard[],
    since: string
): Promise<HistoryPoint[]> {
    if (!cards.length) {
        return [];
    }

    const conditions = cards
        .map(() => "(s.scryfall_id = ? AND s.finish = ?)")
        .join(" OR ");

    const variants = cards.flatMap((card) => [
        card.scryfall_id,
        card.finish,
    ]);

    const [rows] = await db.execute<SnapshotRow[]>(
        `SELECT
            s.scryfall_id,
            s.finish,
            DATE_FORMAT(
                s.recorded_at,
                '%Y-%m-%d'
            ) AS day,
            s.price * 100 AS price_cents
         FROM card_price_snapshots s
         WHERE s.currency = 'USD'
           AND s.recorded_at >= DATE(?)
           AND s.recorded_at >=
               UTC_DATE() - INTERVAL 90 DAY
           AND s.recorded_at <= UTC_TIMESTAMP()
           AND (${conditions})
         ORDER BY s.recorded_at ASC, s.id ASC`,
        [since, ...variants]
    );

    return buildHistory(cards, rows);
}

function changeClass(change: number | null) {
    if (change === null || !Number.isFinite(change) || change === 0) {
        return "text-muted";
    }

    return change > 0
        ? "text-[#4ade80]"
        : "text-[#f87171]";
}

function signedMoney(cents: number) {
    return `${cents > 0 ? "+" : ""}${money(cents)}`;
}

function signedPercent(change: number, baseline: number) {
    if (baseline <= 0) {
        return "—";
    }

    const percent = (change / baseline) * 100;

    return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function Metric({
    title,
    value,
    change = null,
}: {
    title: string;
    value: string;
    change?: number | null;
}) {
    return (
        <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm text-muted">
                {title}
            </h2>

            <p
                className={`mt-2 text-2xl font-semibold ${changeClass(
                    change
                )}`}
            >
                {value}
            </p>
        </section>
    );
}

function chartGeometry(
    history: HistoryPoint[],
    baseline: number | null
) {
    const points = history.filter(
        (
            point
        ): point is HistoryPoint & { cents: number } =>
            point.cents !== null
    );

    if (!points.length) {
        return null;
    }

    const width = 760;
    const height = 300;
    const left = 84;
    const right = 24;
    const top = 24;
    const bottom = 50;

    const times = history.map((point) =>
        Date.parse(`${point.day}T00:00:00Z`)
    );

    const start = Math.min(...times);
    const end = Math.max(...times);

    const low = Math.min(
        ...(baseline === null ? [] : [baseline]),
        ...points.map((point) => point.cents)
    );

    const high = Math.max(
        ...(baseline === null ? [] : [baseline]),
        ...points.map((point) => point.cents)
    );

    const padding = Math.max(
        (high - low) * 0.12,
        high * 0.02,
        100
    );

    const minimum = Math.max(0, low - padding);
    const maximum = high + padding;

    const x = (day: string) =>
        end === start
            ? (left + width - right) / 2
            : left +
            ((Date.parse(`${day}T00:00:00Z`) - start) /
                (end - start)) *
            (width - left - right);

    const y = (cents: number) =>
        top +
        ((maximum - cents) / (maximum - minimum)) *
        (height - top - bottom);

    const segments: string[] = [];
    let active: string[] = [];

    for (const point of history) {
        if (point.cents === null) {
            if (active.length) {
                segments.push(active.join(" "));
            }

            active = [];
        } else {
            active.push(`${x(point.day)},${y(point.cents)}`);
        }
    }

    if (active.length) {
        segments.push(active.join(" "));
    }

    return {
        width,
        height,
        left,
        right,
        start,
        end,
        minimum,
        maximum,
        x,
        y,
        points,
        segments,
    };
}

function HistoryGraph({
    history,
    baseline,
    type,
}: {
    history: HistoryPoint[];
    baseline: number | null;
    type: "purchase" | "sale" | "collection";
}) {
    const chart = chartGeometry(history, baseline);

    if (!chart) {
        return (
            <p>
                No priced daily snapshots to graph yet.
                {type === "collection"
                    ? " Collection snapshots are recorded automatically when you view this page."
                    : " Available transaction prices are recorded automatically."}
            </p>
        );
    }

    const first = chart.points[0];
    const last = chart.points[chart.points.length - 1];
    const change = last.cents - first.cents;
    const enoughHistory = chart.points.length >= 2;
    const isPartial = (point: HistoryPoint) =>
        point.variantCount !== undefined && point.covered < point.variantCount;
    const partialHistory = chart.points.some(isPartial);

    const comparison =
        baseline === null
            ? change
            : type === "purchase"
                ? last.cents - baseline
                : baseline - last.cents;

    const stroke =
        comparison > 0
            ? "#4ade80"
            : comparison < 0
                ? "#f87171"
                : "#44e0c5";

    const ticks = Array.from(
        { length: 5 },
        (_, index) =>
            chart.minimum +
            ((chart.maximum - chart.minimum) * index) / 4
    );

    return (
        <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
                <Metric
                    title={isPartial(last)
                        ? "Latest recorded priced portion"
                        : "Latest recorded reference value"}
                    value={money(last.cents)}
                    change={last.cents}
                />

                <Metric
                    title={
                        partialHistory
                            ? "Priced portion change over shown history"
                            : type === "collection"
                                ? "Collection value change over shown history"
                                : "Market value change over shown history"
                    }
                    value={
                        enoughHistory
                            ? `${signedMoney(change)} (${signedPercent(
                                change,
                                first.cents
                            )})`
                            : "Need a second snapshot date"
                    }
                    change={enoughHistory ? change : null}
                />
            </div>

            <div className="overflow-x-auto rounded-xl border border-border bg-background p-3 text-muted">
                <svg
                    viewBox={`0 0 ${chart.width} ${chart.height}`}
                    className="h-auto min-w-[540px] w-full"
                    role="img"
                    aria-label={`Recorded ${type === "collection" ? "collection" : "transaction"
                        } value from ${first.day} to ${last.day}`}
                >
                    <title>
                        {`${type === "collection" ? "Collection" : "Transaction"
                            } reference value over time`}
                    </title>

                    <desc>
                        Dots show totals for cards with available prices. Hollow dots indicate partial coverage.
                        A dashed line, when present, shows the transaction total.
                        Dates with no available prices break the line. Missing card prices are excluded, not estimated.
                    </desc>

                    {/* Horizontal grid lines and money labels */}
                    {ticks.map((tick, index) => (
                        <g key={index}>
                            <line
                                x1={chart.left}
                                x2={chart.width - chart.right}
                                y1={chart.y(tick)}
                                y2={chart.y(tick)}
                                stroke="currentColor"
                                opacity="0.12"
                            />

                            <text
                                x={chart.left - 10}
                                y={chart.y(tick) + 4}
                                textAnchor="end"
                                fill="currentColor"
                                fontSize="11"
                            >
                                {money(tick)}
                            </text>
                        </g>
                    ))}

                    {baseline !== null && (
                        <line
                            x1={chart.left}
                            x2={chart.width - chart.right}
                            y1={chart.y(baseline)}
                            y2={chart.y(baseline)}
                            stroke="#44e0c5"
                            strokeDasharray="6 5"
                        />
                    )}

                    {chart.segments.map((segment, index) => (
                        <polyline
                            key={index}
                            points={segment}
                            fill="none"
                            stroke={stroke}
                            strokeWidth="3"
                            strokeLinejoin="round"
                        />
                    ))}

                    {chart.points.map((point) => (
                        <circle
                            key={point.day}
                            cx={chart.x(point.day)}
                            cy={chart.y(point.cents)}
                            r="4"
                            fill={isPartial(point) ? "#071827" : stroke}
                            stroke={stroke}
                            strokeWidth="2"
                        >
                            <title>
                                {`${point.day}: ${money(point.cents)} — ${point.covered}/${point.variantCount ?? point.covered} variants priced${isPartial(point) ? " (partial)" : ""}`}
                            </title>
                        </circle>
                    ))}

                    {/* First date, centered when there is only one day */}
                    <text
                        x={chart.x(history[0].day)}
                        y={chart.height - 16}
                        textAnchor={
                            chart.start === chart.end ? "middle" : "start"
                        }
                        fill="currentColor"
                        fontSize="12"
                    >
                        {history[0].day}
                    </text>

                    {chart.start !== chart.end && (
                        <text
                            x={chart.x(history[history.length - 1].day)}
                            y={chart.height - 16}
                            textAnchor="end"
                            fill="currentColor"
                            fontSize="12"
                        >
                            {history[history.length - 1].day}
                        </text>
                    )}

                    <text
                        x={(chart.left + chart.width - chart.right) / 2}
                        y={chart.height - 2}
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize="11"
                    >
                        Date (UTC)
                    </text>
                </svg>
            </div>

            <p className="text-sm text-muted">
                Solid line: total of available recorded prices. Hollow dots indicate partial coverage.{" "}
                {baseline !== null && (
                    <>
                        Dashed line:{" "}
                        {type === "purchase"
                            ? "purchase cost"
                            : "sale proceeds"}{" "}
                        ({money(baseline)}).{" "}
                    </>
                )}
                Hover over a point for its date and value.
                The change compares {first.day} with{" "}
                {last.day}; it is not realized profit.
                {" "}Unpriced cards are excluded. Changes in coverage or collection contents
                can change the total independently of market prices.
            </p>

            {!enoughHistory && (
                <p className="text-sm text-muted">
                    You have one priced snapshot date.
                    Visit again on a different day to show a trend.
                </p>
            )}
        </div>
    );
}

export default function ValuePage({ searchParams }: Props) {
    return (
        <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 text-foreground sm:px-6">
            <h1 className="text-3xl font-semibold">
                Value Tracker
            </h1>
            <p className="mt-3 max-w-2xl text-muted">
                Follow your collection’s reference value and compare
                your purchases and sales with current market prices.
            </p>

            <Suspense
                fallback={
                    <p role="status" className="panel mt-6 text-muted">
                        Loading value…
                    </p>
                }
            >
                <UserValue searchParams={searchParams} />
            </Suspense>
        </main>
    );
}

async function UserValue({ searchParams }: Props) {
    await connection();

    const user = await requireUser();
    const params = await searchParams;

    if (
        params.collection !== undefined &&
        params.transaction !== undefined
    ) {
        notFound();
    }

    const collectionMode =
        params.collection !== undefined ||
        params.transaction === undefined;

    const selectedCollection = selection(params.collection);
    const selectedId = selection(params.transaction);

    const selectedValue = collectionMode
        ? `collection:${selectedCollection}`
        : `transaction:${selectedId}`;

    const [collections] = await db.execute<CollectionRow[]>(
        `SELECT id, name
         FROM collections
         WHERE user_id = ?
         ORDER BY name, id`,
        [user.id]
    );

    const collectionName =
        selectedCollection === "all"
            ? "All collections"
            : collections.find(
                (collection) =>
                    String(collection.id) === selectedCollection
            )?.name;

    if (collectionMode && collectionName === undefined) {
        notFound();
    }

    const [options] = await db.execute<TransactionRow[]>(
        `SELECT
            id,
            name,
            type,
            currency,
            total_amount * 100 AS amount_cents,
            DATE_FORMAT(
                occurred_at,
                '%Y-%m-%d %H:%i:%s'
            ) AS occurred_at_sql
         FROM transactions
         WHERE user_id = ?
           AND currency = 'USD'
         ORDER BY occurred_at DESC, id DESC`,
        [user.id]
    );

    const { cards, transaction } = collectionMode
        ? await loadCollectionBasket(user.id, selectedCollection)
        : await loadBasket(user.id, selectedId);

    // Shared batch lookup replaces per-card requests.
    const prices = await loadScryfallPrices(cards);

    const values = cards.map((card) => ({
        id: card.scryfall_id,
        finish: card.finish,
        quantity: Number(card.quantity),
        name:
            prices.get(card.scryfall_id)?.name ??
            card.scryfall_id,
        cents: unitCents(
            prices.get(card.scryfall_id),
            card.finish
        ),
    }));

    values.sort(
        (a, b) =>
            (b.cents ?? 0) * b.quantity -
            (a.cents ?? 0) * a.quantity
    );

    const currentCents = values.reduce(
        (sum, card) =>
            sum + (card.cents ?? 0) * card.quantity,
        0
    );

    const missing = values.reduce(
        (sum, card) =>
            sum + (card.cents === null ? card.quantity : 0),
        0
    );

    const quantity = values.reduce(
        (sum, card) => sum + card.quantity,
        0
    );

    const complete = cards.length > 0 && missing === 0;
    const hasCurrentPrices = values.some((card) => card.cents !== null);

    const paid = options
        .filter((transaction) => transaction.type === "purchase")
        .reduce(
            (sum, transaction) =>
                sum + Number(transaction.amount_cents),
            0
        );

    const received = options
        .filter((transaction) => transaction.type === "sale")
        .reduce(
            (sum, transaction) =>
                sum + Number(transaction.amount_cents),
            0
        );

    const baseline = transaction
        ? Number(transaction.amount_cents)
        : 0;

    const difference =
        transaction?.type === "sale"
            ? baseline - currentCents
            : currentCents - baseline;

    let snapshotError = false;

    if (collectionMode) {
        try {
            await recordCollectionSnapshot(
                user.id,
                selectedCollection,
                cards,
                prices
            );
        } catch (error) {
            console.error(
                "Automatic collection snapshot failed:",
                error
            );

            snapshotError = true;
        }
    }

    const history: HistoryPoint[] = transaction
        ? await loadHistory(cards, transaction.occurred_at_sql)
        : collectionMode
            ? await loadCollectionHistory(
                user.id,
                selectedCollection
            )
            : [];

    const firstPricedValue =
        history.find((point) => point.cents !== null)?.cents ??
        null;

    const historyPageSize = 10;
    const rawHistoryPage = params.historyPage;
    const requestedHistoryPage =
        typeof rawHistoryPage === "string" && /^[1-9]\d*$/.test(rawHistoryPage)
            ? Number(rawHistoryPage)
            : 1;
    const historyPageCount = Math.max(1, Math.ceil(history.length / historyPageSize));
    const historyPage = Number.isSafeInteger(requestedHistoryPage)
        ? Math.min(requestedHistoryPage, historyPageCount)
        : 1;
    const historyOffset = (historyPage - 1) * historyPageSize;
    const historyByDay = new Map(history.map((point) => [point.day, point]));
    // Calculate from the complete history so comparisons work across page boundaries.
    const historyRows = history.map((point) => {
        const previousDate = new Date(`${point.day}T00:00:00Z`);
        previousDate.setUTCDate(previousDate.getUTCDate() - 1);
        const previous = historyByDay.get(previousDate.toISOString().slice(0, 10));
        return {
            ...point,
            dailyChange:
                point.cents !== null && previous && previous.cents !== null
                    ? point.cents - previous.cents
                    : null,
        };
    }).slice(historyOffset, historyOffset + historyPageSize);

    function historyPageHref(page: number) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (key === "historyPage" || value === undefined) continue;
            if (Array.isArray(value)) {
                value.forEach((entry) => query.append(key, entry));
            } else {
                query.set(key, value);
            }
        }
        query.set("historyPage", String(page));
        return `?${query.toString()}#value-history`;
    }

    const checkedAt = new Date().toISOString();

    return (
        <div className="mt-6 space-y-6">
            <section
                aria-label="Choose value view"
                className="rounded-xl border border-border bg-surface p-5"
            >
                <ValueViewPicker
                    key={selectedValue}
                    selectedValue={selectedValue}
                    collections={collections.map(({ id, name }) => ({ id, name }))}
                    transactions={options.map((option) => ({
                        id: option.id,
                        name: option.name,
                        type: option.type,
                        date: option.occurred_at_sql.slice(0, 10),
                        amountCents: Number(option.amount_cents),
                    }))}
                />

            </section>

            {transaction ? (
                <>
                    <h2 className="text-xl font-semibold">
                        {transaction.name}
                    </h2>

                    <p className="text-sm text-muted">
                        Original transaction quantities are tracked
                        even if cards were later sold or moved.
                    </p>

                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <Metric
                            title={
                                transaction.type === "purchase"
                                    ? "Total paid"
                                    : "Sale proceeds"
                            }
                            value={money(baseline)}
                            change={baseline}
                        />

                        <Metric
                            title={
                                complete
                                    ? "Current reference value"
                                    : "Current priced portion"
                            }
                            value={hasCurrentPrices || quantity === 0 ? money(currentCents) : "No available prices"}
                            change={currentCents}
                        />

                        <Metric
                            title={
                                transaction.type === "purchase"
                                    ? complete
                                        ? "Market value minus purchase cost"
                                        : "Priced portion minus full purchase cost"
                                    : complete
                                        ? "Sale proceeds minus current reference value"
                                        : "Full sale proceeds minus priced portion"
                            }
                            value={
                                hasCurrentPrices
                                    ? signedMoney(difference)
                                    : "No available prices"
                            }
                            change={hasCurrentPrices ? difference : null}
                        />

                        <Metric
                            title={complete ? "Percentage difference" : "Partial-basket difference (%)"}
                            value={
                                hasCurrentPrices
                                    ? signedPercent(difference, baseline)
                                    : "—"
                            }
                            change={
                                hasCurrentPrices && baseline > 0
                                    ? difference
                                    : null
                            }
                        />

                        <Metric
                            title="Copies in transaction"
                            value={String(quantity)}
                        />

                        <Metric
                            title="Copies without a price"
                            value={String(missing)}
                        />
                    </div>

                    <p className="text-sm text-amber-300">
                        {transaction.type === "purchase"
                            ? "This compares the original purchased basket with today's market. It is not realized profit or remaining inventory value."
                            : "This compares sale proceeds with today's reference value of the sold basket. It is not sale profit, which requires acquisition costs."}
                        {!complete && (
                            <>
                                {" "}The priced portion excludes {missing} unpriced copies.
                                Differences compare only this priced portion with the full
                                transaction amount; they are not a complete gain or loss.
                            </>
                        )}
                    </p>
                </>
            ) : collectionMode ? (
                <>
                    <h2 className="text-xl font-semibold">
                        {collectionName}
                    </h2>

                    <div className="grid gap-4 sm:grid-cols-3">
                        <Metric
                            title={
                                missing > 0
                                    ? "Priced portion (incomplete)"
                                    : "Current collection value"
                            }
                            value={hasCurrentPrices || quantity === 0 ? money(currentCents) : "No available prices"}
                            change={currentCents}
                        />

                        <Metric
                            title="Owned copies"
                            value={String(quantity)}
                        />

                        <Metric
                            title="Copies without a price"
                            value={String(missing)}
                        />
                    </div>

                    <p
                        role={snapshotError ? "status" : undefined}
                        className={
                            snapshotError
                                ? "text-sm text-amber-300"
                                : "text-sm text-muted"
                        }
                    >
                        {snapshotError
                            ? "Today's collection snapshot could not be saved. Reload the page to try again."
                            : "Today's collection snapshot was saved automatically. Repeat visits update today's snapshot (UTC)."}
                    </p>
                </>
            ) : (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <Metric
                            title="Priced current collection value"
                            value={hasCurrentPrices || quantity === 0 ? money(currentCents) : "No available prices"}
                            change={currentCents}
                        />

                        <Metric
                            title="Total purchases (USD)"
                            value={money(paid)}
                            change={paid}
                        />

                        <Metric
                            title="Total sale proceeds (USD)"
                            value={money(received)}
                            change={received}
                        />

                        <Metric
                            title="Net cash spent"
                            value={money(paid - received)}
                            change={paid - received}
                        />

                        <Metric
                            title="Owned copies"
                            value={String(quantity)}
                        />

                        <Metric
                            title="Copies without a price"
                            value={String(missing)}
                        />
                    </div>

                    <Metric
                        title="Cash-adjusted collection balance"
                        value={signedMoney(
                            currentCents + received - paid
                        )}
                        change={
                            missing === 0
                                ? currentCents + received - paid
                                : null
                        }
                    />

                    <p className="text-sm text-amber-300">
                        Collection value + sales − purchases.
                        This is not confirmed profit: imported
                        inventory may have unknown acquisition
                        costs, and unpriced cards are excluded.
                        Only USD transactions are included.
                    </p>
                </>
            )}

            <p className="text-sm text-muted">
                USD reference prices match printing and finish;
                condition and language are not adjusted.
                Prices are cached for up to one hour.
                {" "}Lookup completed:{" "}
                <time dateTime={checkedAt}>
                    {checkedAt}
                </time>
                .
            </p>

            {transaction && (
                <AutoRecordSnapshot
                    key={String(transaction.id)}
                    transactionId={String(transaction.id)}
                />
            )}

            {(transaction || collectionMode) && (
                <section id="value-history" className="space-y-3 rounded-xl border border-border bg-surface p-5">
                    <h2 className="text-xl font-semibold">
                        {transaction ? "Transaction" : "Collection"}{" "}
                        priced value over time
                    </h2>

                    <p className="text-sm text-muted">
                        {transaction
                            ? "Last 90 days of recorded prices on or after the transaction date (UTC). Each point includes all available prices, even when some cards have no price. Unpriced cards are excluded. Partial totals are labeled, and coverage changes can affect the total."
                            : "Shows the total for cards with available prices. Unpriced cards are excluded. Coverage shows how many printing/finish variants were priced. Changes in coverage can affect the total."}
                    </p>

                    <HistoryGraph
                        history={history}
                        baseline={transaction ? baseline : null}
                        type={transaction?.type ?? "collection"}
                    />

                    {!history.length ? (
                        <p>
                            {transaction
                                ? "No snapshots yet. Available prices are recorded automatically on this visit."
                                : "No saved snapshots yet. Collection snapshots are recorded automatically when you view this page."}
                        </p>
                    ) : (
                        <div className="space-y-3">
                        <div className="overflow-x-auto rounded-xl border border-border">
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr>
                                        <th className="p-3">
                                            Date (UTC)
                                        </th>
                                        <th className="p-3">
                                            Reference value
                                        </th>
                                        <th className="p-3">
                                            {transaction
                                                ? "Priced value vs transaction total"
                                                : "Change since first priced snapshot"}
                                        </th>
                                        <th className="p-3">
                                            Change from previous day
                                        </th>
                                        <th className="p-3">
                                            Coverage
                                        </th>
                                    </tr>
                                </thead>

                                <tbody>
                                    {historyRows.map((point) => {
                                        let comparison: number | null =
                                            null;

                                        if (point.cents !== null) {
                                            if (transaction) {
                                                comparison =
                                                    transaction.type === "sale"
                                                        ? baseline - point.cents
                                                        : point.cents - baseline;
                                            } else if (
                                                firstPricedValue !== null
                                            ) {
                                                comparison =
                                                    point.cents -
                                                    firstPricedValue;
                                            }
                                        }

                                        return (
                                            <tr
                                                key={point.day}
                                                className="border-t border-border"
                                            >
                                                <td className="p-3">
                                                    {point.day}
                                                </td>

                                                <td className={`p-3 ${changeClass(point.cents)}`}>
                                                    {point.cents === null
                                                        ? "No available prices"
                                                        : money(point.cents)}
                                                    {point.cents !== null &&
                                                        point.covered < (point.variantCount ?? cards.length) && (
                                                            <span className="ml-2 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
                                                                Partial
                                                            </span>
                                                        )}
                                                </td>

                                                <td
                                                    className={`p-3 font-medium ${changeClass(
                                                        comparison
                                                    )}`}
                                                >
                                                    {comparison === null
                                                        ? "—"
                                                        : signedMoney(comparison)}
                                                    {transaction && point.cents !== null &&
                                                        point.covered < (point.variantCount ?? cards.length) && (
                                                            <span className="mt-1 block text-xs font-normal text-muted">
                                                                Priced portion vs full transaction amount
                                                            </span>
                                                        )}
                                                </td>

                                                <td
                                                    className={`p-3 font-medium ${changeClass(point.dailyChange)}`}
                                                    title={point.dailyChange === null
                                                        ? "No priced snapshot available for this date or the previous calendar day."
                                                        : undefined}
                                                >
                                                    {point.dailyChange === null
                                                        ? "—"
                                                        : signedMoney(point.dailyChange)}
                                                </td>

                                                <td className="p-3">
                                                    {point.covered}/
                                                    {point.variantCount ??
                                                        cards.length}
                                                    {" "}
                                                    printing/finish variants
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <nav aria-label="Value history pagination" className="flex flex-wrap items-center justify-between gap-3 text-sm">
                            <p className="text-muted">
                                Showing {historyOffset + 1}–{Math.min(historyOffset + historyPageSize, history.length)} of {history.length} entries
                                {" · "}Page {historyPage} of {historyPageCount}
                            </p>
                            <div className="flex gap-3">
                                {historyPage > 1 ? (
                                    <Link href={historyPageHref(historyPage - 1)} scroll={false} className="rounded border border-border px-3 py-2 hover:bg-background">
                                        Previous
                                    </Link>
                                ) : (
                                    <span aria-disabled="true" className="rounded border border-border px-3 py-2 text-muted opacity-50">Previous</span>
                                )}
                                {historyPage < historyPageCount ? (
                                    <Link href={historyPageHref(historyPage + 1)} scroll={false} className="rounded border border-border px-3 py-2 hover:bg-background">
                                        Next
                                    </Link>
                                ) : (
                                    <span aria-disabled="true" className="rounded border border-border px-3 py-2 text-muted opacity-50">Next</span>
                                )}
                            </div>
                        </nav>
                        </div>
                    )}
                </section>
            )}

            {!transaction && !collectionMode && (
                <p className="text-sm text-muted">
                    Select a transaction for its fixed-basket
                    history, or select a collection to track
                    its total value automatically over time.
                </p>
            )}

            <ValueCardsTable
                key={selectedValue}
                cards={values}
                title={
                    transaction
                        ? "Cards in transaction"
                        : "Current collection cards"
                }
            />
        </div>
    );
}