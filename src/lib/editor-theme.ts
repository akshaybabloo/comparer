import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Dark editor chrome, tuned to the same surfaces as the rest of the app so the
 * editors read as panels rather than embedded widgets.
 */
export const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '12.5px',
      backgroundColor: 'var(--color-surface-0)',
      color: 'var(--color-ink)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'var(--color-accent)', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--color-accent) 26%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-surface-0)',
      color: 'var(--color-ink-faint)',
      border: 'none',
      borderRight: '1px solid var(--color-surface-2)',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--color-surface-2) 45%, transparent)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--color-ink-dim)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '3ch' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-surface-2)',
      border: 'none',
      color: 'var(--color-ink-dim)',
    },
    '.cm-panels': { backgroundColor: 'var(--color-surface-1)', color: 'var(--color-ink)' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in oklch, var(--color-accent) 24%, transparent)',
      outline: '1px solid color-mix(in oklch, var(--color-accent) 50%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in oklch, var(--color-accent) 45%, transparent)',
    },
    '.cm-selectionMatch': { backgroundColor: 'var(--color-surface-2)' },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'var(--color-surface-3)',
      outline: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-surface-2)',
      border: '1px solid var(--color-surface-3)',
      color: 'var(--color-ink)',
    },
  },
  { dark: true },
);

/**
 * Syntax colours. Deliberately restrained: three hues plus the base ink, so a
 * code file stays readable rather than turning into confetti.
 */
export const editorHighlight = HighlightStyle.define(
  [
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'oklch(0.56 0.014 260)', fontStyle: 'italic' },
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'oklch(0.74 0.13 305)' },
    { tag: [t.operator, t.operatorKeyword], color: 'oklch(0.76 0.07 305)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'oklch(0.79 0.12 145)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'oklch(0.8 0.1 65)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'oklch(0.8 0.11 235)' },
    { tag: [t.propertyName], color: 'oklch(0.84 0.05 235)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'oklch(0.82 0.09 195)' },
    { tag: [t.tagName], color: 'oklch(0.76 0.11 20)' },
    { tag: [t.attributeName], color: 'oklch(0.8 0.1 65)' },
    { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--color-ink)' },
    { tag: [t.definition(t.propertyName)], color: 'oklch(0.88 0.04 235)' },
    { tag: [t.heading], color: 'oklch(0.82 0.09 235)', fontWeight: '600' },
    { tag: [t.link, t.url], color: 'oklch(0.78 0.1 235)', textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: '600' },
    { tag: [t.strikethrough], textDecoration: 'line-through' },
    { tag: [t.invalid], color: 'oklch(0.72 0.17 20)' },
    { tag: [t.meta, t.processingInstruction], color: 'var(--color-ink-faint)' },
    { tag: [t.escape, t.character], color: 'oklch(0.8 0.1 65)' },
    { tag: [t.labelName], color: 'oklch(0.84 0.05 235)' },
    { tag: [t.separator, t.punctuation, t.bracket], color: 'var(--color-ink-dim)' },
  ],
  { themeType: 'dark' },
);

export const darkEditorExtensions = [editorTheme, syntaxHighlighting(editorHighlight)];
