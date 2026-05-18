/**
 * DraftHypothesisExtension — renders the live Moonshine session hypothesis
 * inline at the END of the editor document as muted/grey text, without ever
 * inserting it into the actual document content.
 *
 * Why a ProseMirror Decoration.widget (and not insertContent):
 *   - insertContent would persist the hypothesis to the doc, save to DB, and
 *     duplicate when the chunk eventually commits as real text.
 *   - A widget is rendered by ProseMirror as a sibling DOM node inside the
 *     editor view. It IS visually inline with the doc but lives outside the
 *     content model entirely.
 *
 * Update mechanism: the extension exposes a `setDraftHypothesis(text)` command
 * that dispatches a transaction with a meta key the plugin reads to update
 * its decoration set. Cheap (no doc mutation), debounced naturally to React.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const META_KEY = 'draftHypothesis';
export const draftHypothesisPluginKey = new PluginKey<{ text: string }>(META_KEY);

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    draftHypothesis: {
      setDraftHypothesis: (text: string) => ReturnType;
    };
  }
}

export const DraftHypothesisExtension = Extension.create({
  name: 'draftHypothesis',

  addCommands() {
    return {
      setDraftHypothesis: (text: string) => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(draftHypothesisPluginKey, { text });
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<{ text: string }>({
        key: draftHypothesisPluginKey,
        state: {
          init: () => ({ text: '' }),
          apply: (tr, value) => {
            const meta = tr.getMeta(draftHypothesisPluginKey);
            if (meta && typeof meta.text === 'string') return { text: meta.text };
            return value;
          },
        },
        props: {
          decorations(state) {
            const pluginState = draftHypothesisPluginKey.getState(state);
            const text = pluginState?.text ?? '';
            if (!text) return DecorationSet.empty;

            // Place the widget at the end of the document — that's where the
            // about-to-commit text will land, so the preview lines up visually.
            const endPos = state.doc.content.size;

            const widget = Decoration.widget(endPos, () => {
              const span = document.createElement('span');
              span.className = 'draft-hypothesis-widget';
              span.setAttribute('data-draft-hypothesis', '');
              span.contentEditable = 'false';
              span.style.opacity = '0.45';
              span.style.fontStyle = 'italic';
              span.style.userSelect = 'none';
              span.style.pointerEvents = 'none';
              // Leading space so the preview doesn't slam into the previous
              // committed word.
              span.textContent = (text.startsWith(' ') ? '' : ' ') + text;
              return span;
            }, { side: 1, ignoreSelection: true });

            return DecorationSet.create(state.doc, [widget]);
          },
        },
      }),
    ];
  },
});
