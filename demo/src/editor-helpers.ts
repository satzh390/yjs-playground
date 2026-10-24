import * as delta from 'lib0/delta'
import type * as Y from '@y/y'

type SharedText = ReturnType<Y.Doc['get']>

export const readText = (sharedText: SharedText): string => sharedText.toDelta().toJSON().children
  ?.flatMap(operation => 'insert' in operation && typeof operation.insert === 'string' ? [operation.insert] : [])
  .join('') || ''

export const applyInputChange = (sharedText: SharedText, nextText: string): void => {
  const previousText = readText(sharedText)
  if (previousText === nextText) return

  let prefix = 0
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < previousText.length - prefix &&
    suffix < nextText.length - prefix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix++
  }

  const change = delta.create().retain(prefix)
  const deletedLength = previousText.length - prefix - suffix
  if (deletedLength > 0) change.delete(deletedLength)
  const insertedText = nextText.slice(prefix, nextText.length - suffix)
  if (insertedText.length > 0) change.insert(insertedText)
  sharedText.applyDelta(change.done())
}
