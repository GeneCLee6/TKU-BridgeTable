import Anthropic, { toFile } from '@anthropic-ai/sdk'
import { ClubError } from './service.ts'

/**
 * AI import for TKU BridgeBook (淡江橋譜): Claude reads a club document (a PDF, or the text the
 * handbook took out of a .doc/.docx file) and returns its conventions in the handbook's content
 * model. The handbook's import page streams the reply, turns it into conventions and opens them in
 * its editor; nothing is published until someone saves it there.
 *
 * Structured outputs cannot describe recursive schemas, so the reply is flat: sections point to
 * their parent with `parentId`, and list items carry a `level`. The handbook rebuilds the tree
 * (TKU-BridgeBook src/lib/importResult.ts) and that file must change together with this schema.
 *
 * The same upload can instead make articles for the library (BridgeHall e5-t08, `target:
 * 'articles'`): then `categories` are the library's series, the catalogue lists the articles, and
 * the reply is `articleImportSchema`'s, which the handbook turns into articles (importResult.ts
 * fromArticleReply) for its article editor.
 */

export interface ImportCategory {
  id: string
  label: string
  description: string
}

/** What the file becomes: the handbook's conventions, or articles for the library (e5-t08) */
export type ImportTarget = 'conventions' | 'articles'

export interface ImportRequest {
  target: ImportTarget
  fileName: string
  /** What the admin wants the AI to keep in mind, e.g. 「這份是舊版，與特約衝突時以特約為準」 */
  instructions: string
  /** The handbook's current conventions (or articles), one per line, so the AI can tell a new one from an update */
  catalogue: string
  /** The handbook's categories, or the library's series for articles */
  categories: ImportCategory[]
  source: { kind: 'pdf'; file: Blob } | { kind: 'text'; text: string }
}

/** Starts the analysis and returns the Messages API's server-sent events as they come */
export type Importer = (request: ImportRequest) => Promise<Response>

export const IMPORT_MODEL = 'claude-opus-5-5'

const text = (description: string) => ({ type: 'string', description })

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

const pending = text('Doubt about the source in Traditional Chinese, or empty')

/** The blocks a convention's section and an article both have */
function sharedBlocks() {
  return [
    object({ kind: { const: 'paragraph' }, text: text('Verbatim passage'), pending }),
    object({
      kind: { const: 'rules' },
      ordered: { type: 'boolean', description: 'True for 1. 2. 3. or 一、二、' },
      items: {
        type: 'array',
        items: object({
          level: { type: 'integer', description: '0 for a top item, 1 for its sub-item, 2 below that' },
          text: text('Verbatim item'),
          pending,
        }),
      },
    }),
    object({
      kind: { const: 'responses' },
      caption: text('Short caption above the table, or empty'),
      seats: { type: 'array', items: { type: 'string' }, description: 'Four seat headings of the auction, or [] without one' },
      calls: {
        type: 'array',
        description: 'Auction calls filled row by row from the first seat; [] without an auction',
        items: object({ call: text("ASCII call, '?', '---' or '' for an empty cell"), note: text('Annotation of the call, or empty') }),
      },
      rows: {
        type: 'array',
        items: object({
          call: text('ASCII call'),
          meaning: text('Verbatim meaning with suit symbols'),
          note: text('Remark under the meaning, or empty'),
          pending,
        }),
      },
    }),
    object({ kind: { const: 'note' }, tone: { type: 'string', enum: ['info', 'warning'] }, text: text('Verbatim note') }),
    object({
      kind: { const: 'hand' },
      label: text('Label, or empty'),
      spades: text('Cards like AKT52, or - for a void'),
      hearts: text('Cards'),
      diamonds: text('Cards'),
      clubs: text('Cards'),
    }),
  ]
}

/** The reply's JSON schema; `categories` become the allowed category ids */
export function importSchema(categories: string[]) {
  const block = sharedBlocks()
  const section = object({
    id: text('Lowercase English words joined by hyphens, unique within the convention'),
    parentId: text("Id of the parent section; '' at the top level"),
    title: text('Heading'),
    originalTitle: text('The heading exactly as written when title differs, or empty'),
    summary: text('One line, or empty'),
    pending,
    blocks: { type: 'array', items: { anyOf: block } },
  })
  const convention = object({
    action: { type: 'string', enum: ['new', 'update'] },
    replaces: text("Slug of the existing convention this updates, or ''"),
    slug: text('Lowercase English with hyphens'),
    nameZh: text('Chinese name'),
    nameEn: text('English name'),
    aliases: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: categories },
    tags: { type: 'array', items: { type: 'string' } },
    summary: text('One sentence in Traditional Chinese'),
    sourceTitle: text('Source document title'),
    sourceNote: text('Remark about the source, or empty'),
    sections: { type: 'array', items: section, description: 'Document order, every parent before its children' },
  })
  return object({
    conventions: { type: 'array', items: convention },
    reviewNotes: text('Notes for the reviewer in Traditional Chinese'),
  })
}

const SEAT = { type: 'string', enum: ['N', 'E', 'S', 'W'] }

/** One seat's cards in a deal; all four empty when the document does not show that seat */
const dealHand = (seat: string) =>
  object({
    spades: text(`${seat}: spades like AKT52, - for a void, '' when the hand is not shown`),
    hearts: text('Cards'),
    diamonds: text('Cards'),
    clubs: text('Cards'),
  })

/**
 * The reply's JSON schema for articles (e5-t08): the shared blocks plus the article's own
 * (heading, quote, deal, play). `series` become the allowed series ids. Pictures cannot be made
 * from a file; the reply mentions them in reviewNotes.
 */
export function articleImportSchema(series: string[]) {
  const block = [
    object({ kind: { const: 'heading' }, level: { type: 'integer', description: '2 for a heading, 3 for a sub-heading' }, text: text('Verbatim heading') }),
    ...sharedBlocks(),
    object({ kind: { const: 'quote' }, text: text('Verbatim quotation'), cite: text('Who or what it quotes, or empty') }),
    object({
      kind: { const: 'deal' },
      caption: text('Verbatim caption or board heading, or empty'),
      dealer: SEAT,
      vul: { type: 'string', enum: ['None', 'NS', 'EW', 'Both'] },
      north: dealHand('North'),
      east: dealHand('East'),
      south: dealHand('South'),
      west: dealHand('West'),
    }),
    object({
      kind: { const: 'play' },
      caption: text('Verbatim caption, or empty'),
      contract: text("Contract like 4S, 3N, 4HX or 6NXX"),
      declarer: SEAT,
      tricks: {
        type: 'array',
        description: 'Tricks in order, each starting with the card led',
        items: text('One trick: cards separated by spaces, as S2 SA S5 SK (suit letter then rank, 10 is T)'),
      },
    }),
  ]
  const article = object({
    action: { type: 'string', enum: ['new', 'update'] },
    replaces: text("Slug of the existing article this updates, or ''"),
    slug: text('Lowercase English with hyphens'),
    title: text('Verbatim title'),
    authors: { type: 'array', items: { type: 'string' }, description: 'Authors as written, or []' },
    series: { type: 'string', enum: series },
    summary: text('One or two sentences in Traditional Chinese'),
    blocks: { type: 'array', items: { anyOf: block } },
  })
  return object({
    articles: { type: 'array', items: article },
    reviewNotes: text('Notes for the reviewer in Traditional Chinese'),
  })
}

export const IMPORT_SYSTEM = `You turn documents of 淡江橋藝社 (the Tamkang University bridge club) into entries for TKU BridgeBook (淡江橋譜), the club's online handbook of its bidding system and conventions. An officer reviews your result in an editor before anything is published.

# Fidelity comes first
- Transcribe verbatim. Keep every call, meaning, point range, example and wording exactly as written, in the document's language (Traditional Chinese with English bridge terms). Never add, drop, reorder or "correct" bidding content from your own bridge knowledge. Everything in the document must appear somewhere in your output: do not summarise, and do not skip tables that look repetitive.
- Only two conversions are allowed:
  1. Calls are ASCII: 1C 1D 1H 1S 1NT ... 7NT, X (double), XX (redouble), P (pass). The site draws them as 2♦, Pass and so on. In an auction, a dash written as --- stays '---', the call being decided is '?' (also for ？), and an empty cell is ''.
  2. In meanings and other text, letters that stand for suits become symbols: 'H不fit' → '♥不fit', '迫叫至3H' → '迫叫至3♥', 'C短' → '♣短'. Letters that are not suits stay as they are: A K Q J as cards (問A), HCP, NT, RKCB, P/C, F and so on.
- Text marked bold in the input (**like this**) stays wrapped in ** **. Add no other formatting.
- Where the source is ambiguous, contradicts itself, has an obvious typo or breaks off, keep the original text and explain the doubt in that item's pending field, in Traditional Chinese. Never fix it silently.
- If you turn a heading into a clearer title, put the heading exactly as written in originalTitle; otherwise leave originalTitle empty.

# Structure: title, subtitles and modules
- A document is usually one convention. Its title becomes nameZh; nameEn is the English name the document uses or the convention's standard English name (Lebensohl, Jacoby 2NT), else a short English rendering.
- Headings become sections and sub-headings their child sections (parentId is the parent's id, '' at the top). List sections in document order, each parent before its children.
- The content under a heading becomes blocks, in order:
  - paragraph: a passage of explanation.
  - rules: a bulleted or numbered list. ordered is true for 1. 2. 3. or 一、二、; level is 0 for an item, 1 for its sub-item.
  - responses: a bidding sequence with the possible calls and their meanings, such as '2H=P/C' or '3C --- 6張F'. seats are the four column headings of the auction in the document's order (開叫者 敵方 答叫者 敵方, or N E S W); calls fill the auction row by row from the first seat, with '' for empty cells and a note when the document annotates a call in the auction, e.g. 2C（一門未知牌組）. When the document writes the sequence on one line (like '1H 2NT ?'), build the auction from it, starting with 開叫者 for our opening; if the seats cannot be told, put the sequence in caption and leave seats and calls empty. Each row is a call and its verbatim meaning.
  - note: a P.S. or 注意; tone 'warning' for cautions, otherwise 'info'.
  - hand: an example hand, cards as AKQJT98765432 (10 is T), '-' for a void.
- Section ids are lowercase English words joined by hyphens that describe the section (opener-rebids, after-1h-2nt), unique within the convention.
- slug: lowercase English with hyphens. tags: a few short search tags (calls like 1NT, topics like 競叫). summary: one sentence in Traditional Chinese on what the convention is for; your own words are fine there. aliases: other names people search for. sourceTitle: the document's title or file name without extension; sourceNote: empty unless something about the source matters (舊版, a date).

# Filing
- Pick the category whose description fits best.
- Compare with the site's current conventions listed in the request. If the document is a version of one of them, set action 'update', replaces and slug to that slug, and reuse its section ids where the sections match so links keep working. Otherwise action 'new' with replaces ''.
- Output several conventions only when the document clearly holds several independent conventions or chapters, such as a whole system handbook: one per chapter.
- Tell the reviewer briefly in reviewNotes, in Traditional Chinese, which convention you matched and why, anything you could not read, and what you marked as pending.`

export const ARTICLE_IMPORT_SYSTEM = `You turn documents of 淡江橋藝社 (the Tamkang University bridge club) into articles for the library of TKU BridgeHall (淡江橋館 叢書): lesson notes, columns on play and defence, bidding theory, club history. An officer reviews your result in an editor before anything is published.

# Fidelity comes first
- Transcribe verbatim. Keep every sentence, call, card, point range, example and wording exactly as written, in the document's language. Never add, drop, reorder, summarise, rewrite or "correct" anything from your own bridge knowledge, and never improve the style. Everything in the document must appear somewhere in your output.
- Only two conversions are allowed:
  1. Calls in auctions and response tables are ASCII: 1C 1D 1H 1S 1NT ... 7NT, X (double), XX (redouble), P (pass); '?' for the call being decided, '---' for a dash, '' for an empty cell.
  2. In text, letters that stand for suits become symbols ('H不fit' → '♥不fit'); other letters stay (A K Q J as cards, HCP, NT).
- Text marked bold in the input (**like this**) stays wrapped in ** **. Add no other formatting.
- Where the source is ambiguous, contradicts itself, has an obvious typo, cannot be read or breaks off, keep the original text and explain the doubt in that block's pending field (paragraphs, list items and table rows have one), in Traditional Chinese; for other blocks say so in reviewNotes. Never fix it silently.

# Blocks, in document order
- heading: the article's own headings; level 2 for a heading, 3 for a sub-heading. The document's title is the article's title, not a heading.
- paragraph: a passage. rules: a bulleted or numbered list (level 0 an item, 1 its sub-item). note: a P.S. or 注意 (tone 'warning' for cautions). quote: a passage the document quotes from someone else, with cite.
- responses: a bidding sequence with the possible calls and their meanings, as in the club's handbook (seats, calls and rows as the schema says).
- hand: a single example hand, cards as AKQJT98765432 (10 is T), '-' for a void.
- deal: a diagram of two to four hands. Fill each seat shown; leave every suit of a seat that is not shown ''. Write '-' for a shown void. dealer and vul as the document gives them; when it does not, dealer N and vul None, and say so in reviewNotes. A caption or board heading next to the diagram goes in caption, verbatim.
- play: only when the document lists the play trick by trick. Each trick is the cards in the order played, starting with the card led, as suit letter plus rank (SA, HT, D2). Stop where the document stops. If the document only describes the play in prose, keep the prose as paragraphs and make no play block.
- Pictures, photos and drawings that are not card diagrams cannot be carried over: list them in reviewNotes with where they were.

# Filing
- title: the document's title as written. authors: the authors the document names, else []. series: the shelf whose description fits best. summary: one or two sentences in Traditional Chinese on what the article is about; your own words are fine there and only there. slug: lowercase English with hyphens.
- Compare with the library's articles listed in the request. If the document is a version of one of them, set action 'update' and replaces and slug to that slug; otherwise action 'new' with replaces ''.
- Make several articles only when the document clearly holds several independent articles or chapters.
- Tell the reviewer briefly in reviewNotes, in Traditional Chinese, which article you matched and why, anything you could not read or carry over, and what you marked as pending.`

export function articleImportPrompt(request: ImportRequest) {
  const series = request.categories.map((c) => `- ${c.id}：${c.label}（${c.description}）`).join('\n')
  return [
    `檔名：${request.fileName}`,
    `叢書的系列：\n${series}`,
    `叢書目前的文章：\n${request.catalogue || '（沒有）'}`,
    `管理員的補充說明：${request.instructions.trim() || '（沒有）'}`,
    '請依系統說明，把上面的文件逐字轉成叢書的文章資料。',
  ].join('\n\n')
}

export function importPrompt(request: ImportRequest) {
  const categories = request.categories.map((c) => `- ${c.id}：${c.label}（${c.description}）`).join('\n')
  return [
    `檔名：${request.fileName}`,
    `網站的分類：\n${categories}`,
    `網站目前的特約：\n${request.catalogue || '（沒有）'}`,
    `管理員的補充說明：${request.instructions.trim() || '（沒有）'}`,
    '請依系統說明，把上面的文件轉成網站的特約資料。',
  ].join('\n\n')
}

/** `baseURL` is only for tests and API gateways; by default the SDK talks to api.anthropic.com */
export function claudeImporter(apiKey: string, model = IMPORT_MODEL, baseURL?: string): Importer {
  const client = new Anthropic({ apiKey, ...(baseURL && { baseURL }) })
  return async (request) => {
    try {
      return await analyse(client, model, request)
    } catch (error) {
      if (error instanceof Anthropic.APIError)
        throw new ClubError('importFailed', { reason: `${error.status ?? ''} ${error.message}`.trim().slice(0, 300) }, 502)
      throw error
    }
  }
}

async function analyse(client: Anthropic, model: string, request: ImportRequest) {
  const title = request.fileName || 'document'
  const document =
    request.source.kind === 'pdf'
      ? {
          type: 'document' as const,
          title,
          // Uploaded as a file, so the Worker never has to base64-encode a large PDF itself
          source: {
            type: 'file' as const,
            file_id: (
              await client.files.upload({
                file: await toFile(request.source.file, title.endsWith('.pdf') ? title : `${title}.pdf`, {
                  type: 'application/pdf',
                }),
                expires_in_seconds: 3600,
              })
            ).id,
          },
        }
      : {
          type: 'document' as const,
          title,
          source: { type: 'text' as const, media_type: 'text/plain' as const, data: request.source.text },
        }
  const articles = request.target === 'articles'
  const ids = request.categories.map((c) => c.id)
  return client.beta.messages
    .create({
      model,
      max_tokens: 128_000,
      stream: true,
      // A refused request is retried on a fallback model in the same call
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: articles ? articleImportSchema(ids) : importSchema(ids) },
      },
      system: articles ? ARTICLE_IMPORT_SYSTEM : IMPORT_SYSTEM,
      messages: [
        { role: 'user', content: [document, { type: 'text', text: articles ? articleImportPrompt(request) : importPrompt(request) }] },
      ],
    })
    .asResponse()
}
