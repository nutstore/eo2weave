/**
 * Shared BM25 utilities used by both search_tools and search_skills.
 *
 * Extracted from external-tool-bridge.ts so both search paths use the same
 * tokenizer + scoring algorithm.
 */

/** BM25 parameters */
export const K1 = 1.2
export const B = 0.75
export const NAME_BOOST = 2.0

/**
 * Tokenize text for BM25 indexing / querying.
 * Splits on whitespace + common separators (underscore, colon, dot, slash, dash).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_:./-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/** Detect CJK characters — triggers full semantic search path. */
export function hasCJK(text: string): boolean {
  if (!text) return false
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

/** Pre-computed BM25 index over a corpus of documents. */
export class BM25Index {
  private docTokenLists: string[][] = []
  private docLengths: number[] = []
  private avgDocLen: number = 0
  private totalDocs: number = 0
  private df = new Map<string, number>()

  /** Build the index from an array of text documents. */
  build(documents: string[]): void {
    this.totalDocs = documents.length
    this.docTokenLists = documents.map((d) => tokenize(d))
    this.docLengths = this.docTokenLists.map((tokens) => tokens.length)
    this.avgDocLen = this.docLengths.reduce((a, b) => a + b, 0) / (this.totalDocs || 1)

    this.df = new Map()
    for (const tokens of this.docTokenLists) {
      const uniqueTerms = new Set(tokens)
      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) || 0) + 1)
      }
    }
  }

  private idf(term: string): number {
    const dfVal = this.df.get(term) || 0
    return Math.log((this.totalDocs - dfVal + 0.5) / (dfVal + 0.5) + 1)
  }

  private tfNorm(freq: number, docLen: number): number {
    return (freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * docLen) / this.avgDocLen))
  }

  /** Score a single document against a query. Returns BM25 score + name-match boost. */
  score(docIndex: number, queryTokens: string[], nameText: string): number {
    const docTokens = this.docTokenLists[docIndex]!
    const docLen = this.docLengths[docIndex]!
    const queryTokenSet = new Set(queryTokens)

    const tf = new Map<string, number>()
    for (const token of docTokens) {
      tf.set(token, (tf.get(token) || 0) + 1)
    }

    let score = 0
    for (const qt of queryTokenSet) {
      const freq = tf.get(qt) || 0
      if (freq === 0) continue
      score += this.idf(qt) * this.tfNorm(freq, docLen)
    }

    // Boost for matches in the name field
    const nameTokens = new Set(tokenize(nameText))
    for (const qt of queryTokenSet) {
      if (nameTokens.has(qt)) {
        score += NAME_BOOST
      }
    }

    return score
  }
}

/** Generic BM25 search helper. Works for any catalog type. */
export function bm25Search<T>(
  catalog: T[],
  query: string,
  n: number,
  getSearchText: (item: T) => string,
  getNameText: (item: T) => string,
): Array<{ item: T; score: number }> {
  if (!query.trim()) return []

  const index = new BM25Index()
  index.build(catalog.map(getSearchText))

  const queryTokens = tokenize(query)
  return catalog
    .map((item, i) => ({
      item,
      score: index.score(i, queryTokens, getNameText(item)),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}
