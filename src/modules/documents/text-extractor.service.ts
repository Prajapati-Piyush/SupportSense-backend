import path from "path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { BadRequestError } from "../../utils/errors.js";

export interface TextExtractionResult {
  text: string;
  wordCount: number;
  characterCount: number;
  mimeType: string;
}

export class TextExtractorService {
  /**
   * Normalizes raw text:
   * - Converts Windows CRLF to standard LF
   * - Strips null bytes and control chars that would corrupt Postgres text storage
   * - Reduces runs of 3+ consecutive newlines to 2 newlines (clean paragraphs)
   */
  static normalizeText(raw: string): string {
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\0/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Extracts clean text content from PDF, DOCX, TXT, or Markdown buffers.
   */
  static async extractText(
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<TextExtractionResult> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestError("Cannot extract text from an empty file buffer.");
    }

    const ext = path.extname(filename).toLowerCase();
    let rawText = "";

    try {
      if (ext === ".pdf" || mimeType === "application/pdf") {
        rawText = await this.extractFromPdf(buffer);
      } else if (
        ext === ".docx" ||
        mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        rawText = await this.extractFromDocx(buffer);
      } else if (
        ext === ".md" ||
        ext === ".markdown" ||
        ext === ".txt" ||
        mimeType.startsWith("text/")
      ) {
        rawText = buffer.toString("utf-8");
      } else {
        // Fallback: attempt UTF-8 text decode
        rawText = buffer.toString("utf-8");
      }
    } catch (err: any) {
      if (err instanceof BadRequestError) throw err;
      throw new BadRequestError(
        `Failed to extract text from "${filename}": ${err.message || "Unrecognized or corrupted file format"}`
      );
    }

    const normalized = this.normalizeText(rawText);

    if (!normalized || normalized.length === 0) {
      throw new BadRequestError(
        `File "${filename}" contains no readable text content.`
      );
    }

    const words = normalized.split(/\s+/).filter(Boolean);

    return {
      text: normalized,
      wordCount: words.length,
      characterCount: normalized.length,
      mimeType,
    };
  }

  private static async extractFromPdf(buffer: Buffer): Promise<string> {
    try {
      const parser = new PDFParse({ data: buffer });
      const res = await parser.getText();
      await parser.destroy();
      return res.text || "";
    } catch (err: any) {
      throw new BadRequestError(`PDF parsing failed: ${err.message || "Invalid or corrupt PDF"}`);
    }
  }

  private static async extractFromDocx(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || "";
    } catch (err: any) {
      throw new BadRequestError(`DOCX parsing failed: ${err.message || "Invalid or corrupt DOCX"}`);
    }
  }
}

