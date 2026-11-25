import type { Range } from '@tiptap/core'
import {
  combineTransactionSteps,
  findChildrenInRange,
  getChangedRanges,
  getMarksBetween,
} from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import type { MarkType } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { MultiToken } from 'linkifyjs'
import { tokenize } from 'linkifyjs'

import { unlinkTrailingWhitespace } from './unlinkTrailingWhitespace.js'
import { UNICODE_WHITESPACE_PATTERN } from './whitespace.js'

const UNICODE_NON_WHITESPACE_PATTERN = UNICODE_WHITESPACE_PATTERN.replace(/^\[/, '[^')

/**
 * Word immediately before trailing whitespace, including at a line end.
 * This is the fork's autolink improvement (single capture instead of splitting
 * the whole block). The class is upstream's unicode whitespace, so NBSP and
 * the other spaces that terminate a link still do.
 */
const LAST_WORD_BEFORE_TRAILING_WHITESPACE = new RegExp(
  `${UNICODE_WHITESPACE_PATTERN}*(${UNICODE_NON_WHITESPACE_PATTERN}+)${UNICODE_WHITESPACE_PATTERN}+$`,
  'gm',
)

/**
 * Check if the provided tokens form a valid link structure, which can either be a single link token
 * or a link token surrounded by parentheses or square brackets.
 *
 * This ensures that only complete and valid text is hyperlinked, preventing cases where a valid
 * top-level domain (TLD) is immediately followed by an invalid character, like a number. For
 * example, with the `find` method from Linkify, entering `example.com1` would result in
 * `example.com` being linked and the trailing `1` left as plain text. By using the `tokenize`
 * method, we can perform more comprehensive validation on the input text.
 */
function isValidLinkStructure(tokens: Array<ReturnType<MultiToken['toObject']>>) {
  if (tokens.length === 1) {
    return tokens[0].isLink
  }

  if (tokens.length === 3 && tokens[1].isLink) {
    return ['()', '[]'].includes(tokens[0].value + tokens[2].value)
  }

  return false
}

type AutolinkOptions = {
  type: MarkType
  defaultProtocol: string
  validate: (url: string) => boolean
  shouldAutoLink: (url: string) => boolean
}

/**
 * This plugin allows you to automatically add links to your editor.
 * @param options The plugin options
 * @returns The plugin instance
 */
export function autolink(options: AutolinkOptions): Plugin {
  return new Plugin({
    key: new PluginKey('autolink'),
    appendTransaction: (transactions, oldState, newState) => {
      /**
       * Does the transaction change the document?
       */
      const docChanges =
        transactions.some(transaction => transaction.docChanged) && !oldState.doc.eq(newState.doc)

      /**
       * Prevent autolink if the transaction is not a document change or if the transaction has the meta `preventAutolink`.
       */
      const preventAutolink = transactions.some(transaction =>
        transaction.getMeta('preventAutolink'),
      )

      /**
       * Prevent autolink if the transaction is not a document change
       * or if the transaction has the meta `preventAutolink`.
       */
      if (!docChanges || preventAutolink) {
        return
      }

      const { tr } = newState
      const transform = combineTransactionSteps(oldState.doc, [...transactions])
      if (!transactions.some(isHistoryTransaction)) {
        const insertedRanges: Range[] = []

        transform.steps.forEach((step, index) => {
          if (!(step instanceof ReplaceStep) || !step.slice.size) {
            return
          }

          const mapping = transform.mapping.slice(index + 1)
          const from = mapping.map(step.from, 1)
          const to = mapping.map(step.from + step.slice.size, -1)

          if (from < to) {
            insertedRanges.push({ from, to })
          }
        })

        // Unlink later spaces before checking whether earlier spaces end a link.
        insertedRanges.sort((left, right) => right.to - left.to)
        insertedRanges.forEach(range => unlinkTrailingWhitespace(tr, range, options.type))
      }

      const changes = getChangedRanges(transform)

      changes.forEach(({ newRange }) => {
        // Now let’s see if we can add new links.
        const nodesInChangedRanges = findChildrenInRange(
          newState.doc,
          newRange,
          node => node.isTextblock,
        )

        // Grab the first node within the changed ranges (ex. the first of two paragraphs when hitting enter).
        const textBlock = nodesInChangedRanges[0]

        if (!textBlock) {
          return
        }

        // One path for every edit: scan from the start of that textblock through
        // the end of the changed range, with hard breaks and block boundaries as
        // spaces, and take the word immediately before trailing whitespace.
        const textBeforeWhitespace = newState.doc.textBetween(
          textBlock.pos,
          newRange.to,
          ' ',
          ' ',
        )

        if (textBeforeWhitespace) {
          // A shared /g regexp starts at lastIndex. Keep each scan at the beginning.
          LAST_WORD_BEFORE_TRAILING_WHITESPACE.lastIndex = 0
          const lastMatch = Array.from(
            textBeforeWhitespace.matchAll(LAST_WORD_BEFORE_TRAILING_WHITESPACE),
          ).at(-1)

          if (lastMatch === undefined || lastMatch.length < 2) {
            return
          }

          const lastWordBeforeSpace = lastMatch[1]
          const lastWordAndBlockOffset =
            textBlock.pos + textBeforeWhitespace.lastIndexOf(lastWordBeforeSpace)

          if (!lastWordBeforeSpace) {
            return false
          }

          const linksBeforeSpace = tokenize(lastWordBeforeSpace).map(t =>
            t.toObject(options.defaultProtocol),
          )

          if (!isValidLinkStructure(linksBeforeSpace)) {
            return false
          }

          linksBeforeSpace
            .filter(link => link.isLink)
            // Calculate link position.
            .map(link => ({
              ...link,
              from: lastWordAndBlockOffset + link.start + 1,
              to: lastWordAndBlockOffset + link.end + 1,
            }))
            // ignore link inside code mark
            .filter(link => {
              if (!newState.schema.marks.code) {
                return true
              }

              return !newState.doc.rangeHasMark(link.from, link.to, newState.schema.marks.code)
            })
            // validate link
            .filter(link => options.validate(link.value))
            // check whether should autolink
            .filter(link => options.shouldAutoLink(link.value))
            // Add link mark.
            .forEach(link => {
              if (
                getMarksBetween(link.from, link.to, newState.doc).some(
                  item => item.mark.type === options.type,
                )
              ) {
                return
              }

              tr.addMark(
                link.from,
                link.to,
                options.type.create({
                  href: link.href,
                }),
              )
            })
        }
      })

      if (!tr.steps.length) {
        return
      }

      return tr
    },
  })
}
