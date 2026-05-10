import { useEffect, useRef, useCallback, useState } from 'react';
import { useDictationStore } from '../stores/useDictationStore';
import { useTtsStore } from '../stores/useTtsStore';
import { type Editor } from '@tiptap/react';
import { Volume2, Pause } from 'lucide-react';
import { NoteTtsCaption } from './NoteTtsCaption';
import { RichTextEditorShell } from './RichTextEditorShell';
import { htmlToText } from '../services/tiptapText';

export function NoteEditor() {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntryId = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [activeNoteId, setActiveNoteIdState] = useState<string | null>(null);
  // Single setter that keeps the ref (read by async save callbacks) and the
  // state (read by render — the play button needs to know which note is
  // currently loaded so it can compare against the TTS store's activeEntryId).
  const setNoteId = useCallback((id: string | null) => {
    currentEntryId.current = id;
    setActiveNoteIdState(id);
  }, []);
  const [valueHtml, setValueHtml] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saved, setSaved] = useState(true);

  const recomputeCounts = useCallback((html: string) => {
    const text = htmlToText(html);
    setCharCount(text.length);
    setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
  }, []);

  const saveContent = useCallback(async (html: string) => {
    const api = window.ironmic;
    const plainText = htmlToText(html);
    if (!plainText) return;
    try {
      if (currentEntryId.current) {
        await api.updateEntry(currentEntryId.current, { rawTranscript: plainText });
      } else {
        const entry = await api.createEntry({
          rawTranscript: plainText,
          polishedText: undefined,
          durationSeconds: undefined,
          sourceApp: 'IronMic Editor',
        } as any);
        setNoteId(entry.id);
      }
    } catch (err) { console.error('Failed to save note:', err); }
  }, [setNoteId]);

  const handleChange = useCallback((html: string) => {
    setValueHtml(html);
    setSaved(false);
    recomputeCounts(html);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveContent(html);
      setSaved(true);
    }, 1000);
  }, [recomputeCounts, saveContent]);

  // Capture the editor instance so we can do imperative inserts (dictate
  // append, blank-canvas resets) without wiring more props through the
  // shell. onReady fires once on mount and again with `null` on unmount.
  const handleReady = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);

  // On mount: either open a blank canvas (new-note quick action) or
  // rehydrate the most recently edited entry.
  useEffect(() => {
    const { newNoteRequested } = useDictationStore.getState();
    if (newNoteRequested) {
      useDictationStore.setState({ newNoteRequested: false });
      setNoteId(null);
      setValueHtml('');
      setWordCount(0);
      setCharCount(0);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const entries = await window.ironmic.listEntries({ limit: 1, offset: 0, archived: false });
        if (cancelled || entries.length === 0) return;
        setNoteId(entries[0].id);
        setValueHtml(entries[0].rawTranscript || '');
        recomputeCounts(entries[0].rawTranscript || '');
      } catch { /* fresh start */ }
    })();
    return () => { cancelled = true; };
  }, [setNoteId, recomputeCounts]);

  // When the user clicks the shield while already on the notes page, open a blank note.
  useEffect(() => {
    const handler = () => {
      setNoteId(null);
      setValueHtml('');
      setWordCount(0);
      setCharCount(0);
      setSaved(true);
      editorRef.current?.commands.focus();
    };
    window.addEventListener('ironmic:quick-action-dictate', handler);
    return () => window.removeEventListener('ironmic:quick-action-dictate', handler);
  }, [setNoteId]);

  // Append the most recent transcript when the dictation pipeline returns
  // to idle. Prefers the rich JSON projection (polishedTextJson) so headings,
  // bold, lists, code, and tables from the LLM render with their formatting.
  // Falls back to plain text for legacy entries / plain mode.
  useEffect(() => {
    const cleanup = window.ironmic.onPipelineStateChanged((state: string) => {
      if (state !== 'idle') return;
      setTimeout(async () => {
        try {
          const entries = await window.ironmic.listEntries({ limit: 1, offset: 0, archived: false });
          const editor = editorRef.current;
          if (entries.length > 0 && entries[0].id !== currentEntryId.current && editor) {
            const entry = entries[0];
            const richJson = (entry as any).polishedTextJson;
            if (richJson) {
              try {
                const doc = JSON.parse(richJson);
                // The polish pipeline produces a full ProseMirror doc (root
                // node type 'doc' with a content[] of block nodes). To append
                // we want the block nodes themselves — passing the doc would
                // try to nest a doc inside a doc.
                const fragment = doc?.content && Array.isArray(doc.content)
                  ? doc.content
                  : doc;
                editor.commands.insertContent(fragment);
                return;
              } catch (err) {
                // Malformed JSON — fall through to plain text path.
                console.warn('[NoteEditor] polishedTextJson parse failed, falling back to plain text:', err);
              }
            }
            const text = entry.polishedText || entry.rawTranscript;
            editor.commands.insertContent(text + ' ');
          }
        } catch { /* ignore */ }
      }, 100);
    });
    return cleanup;
  }, []);

  return (
    <div className="h-full flex flex-col bg-iron-bg">
      <RichTextEditorShell
        valueHtml={valueHtml}
        onChangeHtml={handleChange}
        placeholder="Start dictating or type here..."
        onReady={handleReady}
        rightToolbarSlot={<EditorPlayButton noteId={activeNoteId} editorRef={editorRef} />}
        className="flex-1 flex flex-col bg-iron-bg min-h-0"
      />

      {/* Live caption strip — appears while THIS note is being read aloud.
          Implements word-by-word highlighting since TipTap's rich-text doc
          can't be highlighted in-place without invasive Decoration plumbing. */}
      <NoteTtsCaption noteId={activeNoteId} />

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-iron-border bg-iron-surface/30 text-[11px] text-iron-text-muted shrink-0">
        <div className="flex items-center gap-3">
          <span>{wordCount} words</span>
          <span>{charCount} characters</span>
        </div>
        <span>{saved ? 'Saved' : 'Saving...'}</span>
      </div>
    </div>
  );
}

/* ─── Editor Play Button ─── */

/**
 * Read-aloud button for the currently-loaded note.
 *
 * State machine:
 *  - `THIS` note is the active TTS target AND playing → button shows Pause.
 *  - `THIS` note is the active TTS target AND paused  → button shows Play (resumes).
 *  - `THIS` note is the active TTS target AND synthesizing → spinner.
 *  - Some OTHER note is currently playing, OR nothing is → button shows
 *    "Read aloud". Clicking it tears down the previous synth and starts
 *    fresh on this note's text.
 */
function EditorPlayButton({
  noteId,
  editorRef,
}: {
  noteId: string | null;
  editorRef: React.MutableRefObject<Editor | null>;
}) {
  const { state, synthesizeAndPlay, pause, play, activeEntryId } = useTtsStore();
  const isThisNote = !!noteId && activeEntryId === noteId;
  const isPlayingThis = isThisNote && state === 'playing';
  const isPausedThis = isThisNote && state === 'paused';
  const isSynthThis = isThisNote && state === 'synthesizing';

  const handleClick = async () => {
    if (isPlayingThis) { await pause(); return; }
    if (isPausedThis) { await play(); return; }
    // Either nothing is playing, or a DIFFERENT note is playing. Either way:
    // start fresh synthesis for this note. The store's synthesizeAndPlay
    // calls ttsStop() internally before kicking off, so any previous stream
    // is replaced cleanly. Read live editor text so unsaved typing is
    // included in playback (matches pre-shell behavior).
    const text = editorRef.current?.getText() || '';
    if (text.trim()) {
      await synthesizeAndPlay(text, noteId || undefined);
    }
  };

  const Icon = isPlayingThis ? Pause : Volume2;
  const title = isPlayingThis
    ? 'Pause'
    : isPausedThis
    ? 'Resume'
    : isThisNote
    ? 'Read aloud'
    : activeEntryId
    ? 'Read aloud (replaces current playback)'
    : 'Read aloud';

  return (
    <button
      onClick={handleClick}
      disabled={isSynthThis}
      title={title}
      className={`p-1.5 rounded-md transition-all ${
        isPlayingThis || isPausedThis
          ? 'bg-emerald-500/15 text-emerald-400'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      } disabled:opacity-40`}
    >
      {isSynthThis ? (
        <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
      ) : (
        <Icon className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
