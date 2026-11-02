export interface DocumentChunk {
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
}

export interface ChunkerOptions {
  targetMinTokens?: number; // default: 300
  targetMaxTokens?: number; // default: 500
  overlapTokens?: number;   // default: 60
  rootTitle?: string;       // root document title fallback
}

export class ChunkerService {
  public static readonly DEFAULT_MIN_TOKENS = 300;
  public static readonly DEFAULT_MAX_TOKENS = 500;
  public static readonly DEFAULT_OVERLAP_TOKENS = 60;

  /**
   * Estimates token count using standard whitespace-split * 1.32 ratio.
   * Matches token estimation across the SupportSense architecture.
   */
  static estimateTokenCount(text: string): number {
    if (!text || !text.trim()) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean);
    return Math.max(1, Math.ceil(words.length * 1.32));
  }

  /**
   * Splits a document into structure-aware chunks.
   * 1. Preserves markdown heading structure and hierarchy ("Parent > Child").
   * 2. Targets 300–500 tokens per chunk.
   * 3. Splitting large sections respects paragraph boundaries (\n\n) and sentence boundaries.
   * 4. Applies configurable overlap (~60 tokens) between split chunks for context continuity.
   * 5. Discards any empty chunks and assigns sequential chunkIndex (0, 1, 2...).
   */
  static chunkDocument(text: string, options: ChunkerOptions = {}): DocumentChunk[] {
    const minTokens = options.targetMinTokens ?? this.DEFAULT_MIN_TOKENS;
    const maxTokens = options.targetMaxTokens ?? this.DEFAULT_MAX_TOKENS;
    const overlapTokens = options.overlapTokens ?? this.DEFAULT_OVERLAP_TOKENS;
    const rootTitle = options.rootTitle?.trim() || null;

    if (!text || !text.trim()) {
      return [];
    }

    // 1. Break the text into heading-based sections
    const rawSections = this.splitIntoHeadingSections(text, rootTitle);

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const section of rawSections) {
      const sectionText = section.content.trim();
      if (!sectionText) continue;

      const sectionTokens = this.estimateTokenCount(sectionText);

      if (sectionTokens <= maxTokens) {
        // Fits within single chunk target
        chunks.push({
          chunkIndex: chunkIndex++,
          content: sectionText,
          headingPath: section.headingPath,
          tokenCount: sectionTokens,
        });
      } else {
        // Section exceeds maxTokens: split on paragraph/sentence boundaries with overlap
        const subChunks = this.splitSectionIntoChunks(
          sectionText,
          section.headingPath,
          minTokens,
          maxTokens,
          overlapTokens,
          chunkIndex
        );

        for (const sub of subChunks) {
          chunks.push(sub);
          chunkIndex++;
        }
      }
    }

    return chunks;
  }

  /**
   * Parses markdown headings (# through ######) and groups body text under hierarchical paths.
   */
  private static splitIntoHeadingSections(
    text: string,
    defaultRootTitle: string | null
  ): Array<{ headingPath: string | null; content: string }> {
    const lines = text.split("\n");
    const sections: Array<{ headingPath: string | null; content: string }> = [];

    // Heading hierarchy stack: array of { level: number, title: string }
    const headingStack: Array<{ level: number; title: string }> = [];

    let currentHeadingPath: string | null = defaultRootTitle;
    let currentContentLines: string[] = [];

    const headingRegex = /^(#{1,6})\s+(.+)$/;

    for (const line of lines) {
      const match = line.match(headingRegex);

      if (match) {
        // Flush previous section if it has content
        const prevContent = currentContentLines.join("\n").trim();
        if (prevContent) {
          sections.push({
            headingPath: currentHeadingPath,
            content: prevContent,
          });
          currentContentLines = [];
        }

        const level = match[1].length; // 1 for #, 2 for ##, etc.
        const title = match[2].trim();

        // Adjust heading stack for hierarchy
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }

        headingStack.push({ level, title });
        currentHeadingPath = headingStack.map((h) => h.title).join(" > ");

        // Include the heading line in content for local context
        currentContentLines.push(line);
      } else {
        currentContentLines.push(line);
      }
    }

    // Flush last section
    const lastContent = currentContentLines.join("\n").trim();
    if (lastContent) {
      sections.push({
        headingPath: currentHeadingPath,
        content: lastContent,
      });
    }

    return sections;
  }

  /**
   * Splits a large text section into chunks within [minTokens, maxTokens]
   * with boundary overlap across consecutive chunks.
   */
  private static splitSectionIntoChunks(
    text: string,
    headingPath: string | null,
    minTokens: number,
    maxTokens: number,
    overlapTokens: number,
    startingIndex: number
  ): DocumentChunk[] {
    // Split text into paragraph units
    const rawParagraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

    // If paragraphs themselves are huge, break them into sentence units
    const units: string[] = [];
    for (const para of rawParagraphs) {
      const paraTokens = this.estimateTokenCount(para);
      if (paraTokens > maxTokens) {
        const sentences = para
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
        units.push(...sentences);
      } else {
        units.push(para);
      }
    }

    const chunks: DocumentChunk[] = [];
    let currentChunkUnits: string[] = [];
    let currentChunkTokens = 0;
    let currentIndex = startingIndex;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const unitTokens = this.estimateTokenCount(unit);

      // Check if adding unit exceeds maxTokens
      if (currentChunkTokens + unitTokens > maxTokens && currentChunkUnits.length > 0) {
        const chunkContent = currentChunkUnits.join("\n\n").trim();
        if (chunkContent) {
          chunks.push({
            chunkIndex: currentIndex++,
            content: chunkContent,
            headingPath,
            tokenCount: this.estimateTokenCount(chunkContent),
          });
        }

        // Calculate overlap units from the end of current chunk
        const overlapUnits: string[] = [];
        let accumulatedOverlap = 0;

        for (let j = currentChunkUnits.length - 1; j >= 0; j--) {
          const revUnit = currentChunkUnits[j];
          const revTokens = this.estimateTokenCount(revUnit);
          if (accumulatedOverlap + revTokens <= overlapTokens || overlapUnits.length === 0) {
            overlapUnits.unshift(revUnit);
            accumulatedOverlap += revTokens;
          } else {
            break;
          }
        }

        // Start new chunk with overlap units + current unit
        currentChunkUnits = [...overlapUnits, unit];
        currentChunkTokens = this.estimateTokenCount(currentChunkUnits.join("\n\n"));
      } else {
        currentChunkUnits.push(unit);
        currentChunkTokens += unitTokens;
      }
    }

    // Flush final chunk
    if (currentChunkUnits.length > 0) {
      const finalContent = currentChunkUnits.join("\n\n").trim();
      if (finalContent) {
        // If final chunk is tiny and we have a previous chunk in this section, merge if it fits within maxTokens
        if (
          chunks.length > 0 &&
          this.estimateTokenCount(finalContent) < minTokens / 2 &&
          this.estimateTokenCount(chunks[chunks.length - 1].content + "\n\n" + finalContent) <= maxTokens
        ) {
          const prev = chunks[chunks.length - 1];
          prev.content = `${prev.content}\n\n${finalContent}`.trim();
          prev.tokenCount = this.estimateTokenCount(prev.content);
        } else {
          chunks.push({
            chunkIndex: currentIndex++,
            content: finalContent,
            headingPath,
            tokenCount: this.estimateTokenCount(finalContent),
          });
        }
      }
    }

    return chunks;
  }
}

