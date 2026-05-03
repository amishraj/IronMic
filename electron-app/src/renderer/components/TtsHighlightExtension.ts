/**
 * TtsHighlightExtension — highlights the currently-spoken word in-place
 * inside the TipTap editor while TTS read-back is active.
 *
 * Approach: an inline ProseMirror Decoration wraps the Nth whitespace-
 * delimited word in the document with a CSS class. The N comes from a
 * `setTtsActiveWord(index)` command driven by a React effect that subscribes
 * to useTtsStore. Pass -1 to clear.
 *
 * Word indexing matches `editor.getText().trim()` split on whitespace —
 * which is exactly the string handed to the TTS engine — so the index
 * lines up with the timestamps array returned by the synthesizer.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const META_KEY = 'ttsHighlight';
export const ttsHighlightPluginKey = new PluginKey<{ wordIndex: number }>(META_KEY);

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ttsHighlight: {
      setTtsActiveWord: (wordIndex: number) => ReturnType;
    };
  }
}

export const TtsHighlightExtension = Extension.create({
  name: 'ttsHighlight',

  addCommands() {
    return {
      setTtsActiveWord: (wordIndex: number) => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(ttsHighlightPluginKey, { wordIndex });
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<{ wordIndex: number }>({
        key: ttsHighlightPluginKey,
        state: {
          init: () => ({ wordIndex: -1 }),
          apply: (tr, value) => {
            const meta = tr.getMeta(ttsHighlightPluginKey);
            if (meta && typeof meta.wordIndex === 'number') return { wordIndex: meta.wordIndex };
            return value;
          },
        },
        props: {
          decorations(state) {
            const pluginState = ttsHighlightPluginKey.getState(state);
            const target = pluginState?.wordIndex ?? -1;
            if (target < 0) return DecorationSet.empty;

            // Walk text nodes in document order, matching whitespace-delimited
            // chunks. When we hit the Nth chunk, return an inline decoration
            // spanning it.
            const wordRe = /\S+/g;
            let count = 0;
            let from = -1;
            let to = -1;

            state.doc.descendants((node, pos) => {
              if (from !== -1) return false; // already found
              if (!node.isText || !node.text) return true;
              wordRe.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = wordRe.exec(node.text)) !== null) {
                if (count === target) {
                  from = pos + m.index;
                  to = pos + m.index + m[0].length;
                  return false;
                }
                count += 1;
              }
              return true;
            });

            if (from === -1) return DecorationSet.empty;

            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: 'tts-active-word' }),
            ]);
          },
        },
      }),
    ];
  },
});
