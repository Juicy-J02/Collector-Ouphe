import { randomBytes, createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { connection } from "next/server";
import { db } from "@/lib/server/database";

export const SESSION_COOKIE = "ouphe_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;

export const sessionCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
};

interface SessionUser extends RowDataPacket {
    id: number;
    username: string;
    email: string;
}

function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number) {
    const token = randomBytes(32).toString("hex");

    await db.execute(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))`,
        [userId, hashToken(token)]
    );

    return token;
}

export async function getSessionUser(token: string | undefined) {
    await connection();

    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        return null;
    }

    const [users] = await db.execute<SessionUser[]>(
        `SELECT u.id, u.username, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?
           AND s.expires_at > UTC_TIMESTAMP()
         LIMIT 1`,
        [hashToken(token)]
    );

    return users[0] ?? null;
}

export async function deleteSession(token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        return;
    }

    await db.execute(
        "DELETE FROM sessions WHERE token_hash = ?",
        [hashToken(token)]
    );
}