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
 */

export interface ImportCategory {
  id: string
  label: string
  description: string
}

export interface ImportRequest {
  fileName: string
  /** What the admin wants the AI to keep in mind, e.g. 「這份是舊版，與特約衝突時以特約為準」 */
  instructions: string
  /** The handbook's current conventions, one per line, so the AI can tell a new one from an update */
  catalogue: string
  categories: ImportCategory[]
  source: { kind: 'pdf'; file: Blob } | { kind: 'text'; text: string }
}

/** Starts the analysis and returns the Messages API's server-sent events as they come */
export type Importer = (request: ImportRequest) => Promise<Response>

export const IMPORT_MODEL = 'claude-opus-5-5'

const text = (description: string) => ({ type: 'string', description })

/** The reply's JSON schema; `categories` become the allowed category ids */
export function importSchema(categories: string[]) {
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  })
  const pending = text('Doubt about the source in Traditional Chinese, or empty')
  const block = [
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

export function claudeImporter(apiKey: string, model = IMPORT_MODEL): Importer {
  const client = new Anthropic({ apiKey })
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
        format: { type: 'json_schema', schema: importSchema(request.categories.map((c) => c.id)) },
      },
      system: IMPORT_SYSTEM,
      messages: [{ role: 'user', content: [document, { type: 'text', text: importPrompt(request) }] }],
    })
    .asResponse()
}
