import * as fs from "fs";
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
  PDF_TARGET_RAW_SIZE,
} from "../../constants/api_limits.js";
import type { ReadPdfOutput, ReadPdfPagesOutput } from "./types.js";

export function parsePdfPageRange(pages: string): { start: number; end: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return { start: n, end: n };
  }
  const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1]!, 10);
  const end = parseInt(m[2]!, 10);
  if (start > end) return null;
  return { start, end };
}

type PdfParseFn = (buf: Buffer) => Promise<{ numpages?: number; text?: string }>;

async function loadPdfParse(): Promise<PdfParseFn | null> {
  try {
    const mod = await import("pdf-parse");
    return (mod.default ?? mod) as PdfParseFn;
  } catch {
    return null;
  }
}

export async function getPdfPageCount(absPath: string): Promise<number | null> {
  try {
    const buf = fs.readFileSync(absPath);
    const pdfParse = await loadPdfParse();
    if (!pdfParse) {
      return Math.max(1, Math.ceil(buf.length / (100 * 1024)));
    }
    const data = await pdfParse(buf);
    return data.numpages ?? null;
  } catch {
    return null;
  }
}

export async function readPdfFile(
  absPath: string,
  displayPath: string,
  pages?: string,
): Promise<ReadPdfOutput | ReadPdfPagesOutput> {
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`);
  }
  const stat = fs.statSync(absPath);
  const buf = fs.readFileSync(absPath);
  const pageCount = await getPdfPageCount(absPath);

  if (pages) {
    const range = parsePdfPageRange(pages);
    if (!range) {
      throw new Error(`Invalid pages parameter: "${pages}". Use "3" or "1-5".`);
    }
    const count = range.end - range.start + 1;
    if (count > PDF_MAX_PAGES_PER_READ) {
      throw new Error(`Maximum ${PDF_MAX_PAGES_PER_READ} pages per request (requested ${count}).`);
    }
    const pdfParse = await loadPdfParse();
    let text: string;
    if (pdfParse) {
      const data = await pdfParse(buf);
      const full = data.text ?? "";
      text = full
        ? `[PDF pages ${range.start}-${range.end} text extract]\n${full.slice(0, 120_000)}`
        : `(PDF pages ${range.start}-${range.end}: no extractable text)`;
    } else {
      text = `(PDF text extraction unavailable — install pdf-parse. Requested pages ${range.start}-${range.end}.)`;
    }
    return {
      type: "pdf_pages",
      file: {
        filePath: displayPath,
        pages: pages.trim(),
        text,
        pageCount: count,
      },
    };
  }

  if (pageCount != null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
    throw new Error(
      `This PDF has ${pageCount} pages, which is too many to read at once. Use the pages parameter (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    );
  }

  if (stat.size > PDF_TARGET_RAW_SIZE) {
    throw new Error(
      `PDF is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds inline limit. Use pages parameter to read specific ranges.`,
    );
  }

  return {
    type: "pdf",
    file: {
      filePath: displayPath,
      base64: buf.toString("base64"),
      originalSize: stat.size,
      pageCount,
    },
  };
}

export async function tryGetPdfReference(
  absPath: string,
  displayPath: string,
): Promise<{
  type: "pdf_reference";
  filename: string;
  displayPath: string;
  pageCount: number;
  fileSize: number;
} | null> {
  try {
    const stat = fs.statSync(absPath);
    const pageCount = await getPdfPageCount(absPath);
    const effective = pageCount ?? Math.ceil(stat.size / (100 * 1024));
    if (effective <= PDF_AT_MENTION_INLINE_THRESHOLD) return null;
    return {
      type: "pdf_reference",
      filename: absPath,
      displayPath,
      pageCount: effective,
      fileSize: stat.size,
    };
  } catch {
    return null;
  }
}
