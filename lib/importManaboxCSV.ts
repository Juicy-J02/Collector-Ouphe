import Papa from "papaparse";
import type { ManaboxRow } from "@/types/manabox";

export function importManaboxCSV(csv: string): ManaboxRow[] {
    const result = Papa.parse<ManaboxRow>(csv, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (header) =>
            header.replace(/^\uFEFF/, "").trim(),
    });

    if (result.errors.length > 0) {
        throw new Error(
            `Could not parse CSV: ${result.errors[0].message}`
        );
    }

    const headers = result.meta.fields ?? [];

    for (const required of ["Name", "Set code"]) {
        if (!headers.includes(required)) {
            throw new Error(
                `The CSV is missing the "${required}" column.`
            );
        }
    }

    for (const [index, row] of result.data.entries()) {
        if (!row.Name?.trim() || !row["Set code"]?.trim()) {
            throw new Error(
                `CSV card row ${index + 1}: Name and Set code are required.`
            );
        }
    }

    return result.data;
}

export async function CSVToDB(
    rows: ManaboxRow[],
    collectionId: number
) {
    const response = await fetch("/api/collections/import", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectionId, rows }),
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
        throw new Error(
            "The collection import API did not return JSON."
        );
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error ?? "Could not save collection."
        );
    }

    return data;
}