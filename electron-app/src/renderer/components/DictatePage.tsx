/**
 * DictatePage — a dictation-centric note editor.
 *
 * Behavior contract (per product spec):
 *  1. Dictation = Notes. Every dictation session IS a note, saved into a
 *     notebook (defaulting to "My Notes"). The notebook can be swapped
 *     live via the header picker while dictating.
 *  2. Text appears as you speak (streaming chunked transcription via
 *     DictationStreamer in main), not after you stop.
 *  3. Starting dictation from a blank page auto-creates a new entry with a
 *     default title "Note #N" (sequential across all entries) AND auto-
 *     assigns it to the currently-selected notebook.
 *  4. Clicking "Done" persists the current entry (giving it a #N title if
 *     still untitled), files it into the current notebook, and opens a
 *     fresh blank one.
 *  5. Tray "Quick Start Dictation" auto-triggers the dictate button on
 *     navigation here.
 *  6. Streaming state lives in useDictationStore so the sidebar mic shield
 *     (and anywhere else) reflects reality even if the user navigates
 *     away mid-dictation.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Minus, Link as LinkIcon, Highlighter, Undo2, Redo2,
  AlignLeft, AlignCenter, AlignRight, Mic, MicOff, Check,
  Volume2, Square, Pause, Play, ChevronDown,
  Pencil, Circle, BookPlus, Users, Plus,
  Loader2, Sparkles, Save,
} from 'lucide-react';
import { useTtsStore } from '../stores/useTtsStore';
import { useDictationStore } from '../stores/useDictationStore';
import { useMeetingStore } from '../stores/useMeetingStore';
import { useToastStore } from '../stores/useToastStore';
import { useEntryStore } from '../stores/useEntryStore';
import { RawPolishedToggle } from './RawPolishedToggle';
import { listNotebooks, createNotebook, getDefaultNotebookId, syncMeetingEntryToSession, type Notebook } from '../services/notebooks';
import { TITLE_TAG_PREFIX, EMOJI_TAG_PREFIX, parseTitleTag, parseNotebookTag, parseMeetingTag, parseStatusTag, parseEmojiTag, type Entry } from '../types';
import { NoteEmojiPicker, pickRandomEmoji } from './NoteEmojiPicker';
import { NotesSidebar } from './NotesSidebar';
import { NotesCollaborateModal } from './NotesCollaborateModal';
import { DraftHypothesisExtension } from './DraftHypothesisExtension';

const STORAGE_KEY = 'ironmic-dictate-draft';

function loadDraft(): { html: string; entryId: string | null; title: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveDraft(html: string, entryId: string | null, title: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ html, entryId, title }));
  } catch { /* quota exceeded — ignore */ }
}

function clearDraft() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Minimal HTML escaper for plain-text → TipTap round-trips. TipTap itself
 *  will sanitize further, but we don't want `<script>` or `<` in a user's raw
 *  transcript to slip through as real HTML when we re-inject the entry. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function titleFromTags(tagsJson: string | null | undefined): string | null {
  if (!tagsJson) return null;
  try {
    const arr = JSON.parse(tagsJson);
    if (!Array.isArray(arr)) return null;
    const t = arr.find((s: string) => typeof s === 'string' && s.startsWith(TITLE_TAG_PREFIX));
    if (!t) return null;
    return (t as string).slice(TITLE_TAG_PREFIX.length);
  } catch { return null; }
}

/** Compute the next "Note #N" by scanning existing entries' title tags. */
async function computeNextNoteNumber(): Promise<number> {
  try {
    const entries = await window.ironmic.listEntries({ limit: 500, offset: 0, archived: false });
    let maxN = 0;
    for (const e of entries) {
      const title = titleFromTags((e as any).tags);
      if (!title) continue;
      const m = title.match(/^Note\s*#(\d+)/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    return maxN + 1;
  } catch {
    return 1;
  }
}

export function DictatePage() {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collabActiveRef = useRef(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saved, setSaved] = useState(true);
  const [doneFlash, setDoneFlash] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [localTitle, setLocalTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  /** Actual status of the loaded entry — 'draft' while composing, 'done' after
   *  Done is pressed or when an already-finalized note is opened from sidebar. */
  const [loadedEntryStatus, setLoadedEntryStatus] = useState<'draft' | 'done' | null>(null);
  const [collabOpen, setCollabOpen] = useState(false);
  const [collabActive, setCollabActive] = useState(false);
  const [collabParticipantCount, setCollabParticipantCount] = useState(0);
  const [noteEmoji, setNoteEmoji] = useState(() => pickRandomEmoji());
  /** True when we're programmatically replacing editor content (polish,
   *  toggle to other display mode, sidebar entry switch). The TipTap
   *  `onUpdate` callback short-circuits its debounced auto-save when this is
   *  set so we don't immediately write the just-applied content right back —
   *  which would erase the OTHER side (raw vs polished) and create a feedback
   *  loop with the reactive sync effect below. */
  const isApplyingRemoteContentRef = useRef(false);
  /** Track the last (mode, polishedText, rawTranscript) we applied to the
   *  editor so the reactive sync effect doesn't re-apply identical content
   *  every render. */
  const lastAppliedSyncKeyRef = useRef<string>('');

  // ── Dictation state lives in the store (foolproof across navigation) ──
  const status = useDictationStore((s) => s.status);
  const entryId = useDictationStore((s) => s.entryId);
  const storeTitle = useDictationStore((s) => s.title);
  const notebookId = useDictationStore((s) => s.notebookId);
  const chunkSeq = useDictationStore((s) => s.chunkSeq);
  const lastChunkText = useDictationStore((s) => s.lastChunkText);
  const fullText = useDictationStore((s) => s.fullText);
  const draftHypothesis = useDictationStore((s) => s.draftHypothesis);
  const storeStart = useDictationStore((s) => s.start);
  const storeStop = useDictationStore((s) => s.stop);
  const storeReset = useDictationStore((s) => s.resetSession);
  const setStoreTitle = useDictationStore((s) => s.setTitle);
  const setStoreEntryFromDraft = useDictationStore.setState;
  const moveCurrentToNotebook = useDictationStore((s) => s.moveCurrentToNotebook);
  const setEntryStatus = useDictationStore((s) => s.setEntryStatus);

  // ── Polish state from useEntryStore ──
  // Lives in the store (module scope), so polish keeps running when the user
  // navigates away. Both Notes (this page) and Timeline read from the same
  // source of truth, which keeps them in sync.
  const isPolishing = useEntryStore((s) => entryId ? s.polishingIds.has(entryId) : false);
  const polishedEntry = useEntryStore((s) =>
    entryId
      ? (s.entries.find((e) => e.id === entryId) ?? s.entryCache.get(entryId) ?? null)
      : null,
  );
  const polishProvider = useEntryStore((s) =>
    entryId ? s.polishProviderByEntryId.get(entryId) : undefined,
  );
  // The DB default for display_mode is 'polished' even when polished_text is
  // null (see entries.rs CREATE without an explicit displayMode). Treat
  // 'polished with null text' as 'raw' here so the UI never tries to render
  // a non-existent polished view.
  const effectiveMode: 'raw' | 'polished' =
    polishedEntry?.polishedText ? polishedEntry.displayMode : 'raw';

  // Pull the canonical entry into the store cache when this page mounts on
  // an existing entry (sidebar selection, draft rehydration). Older notes
  // outside the timeline's first page would otherwise be invisible to
  // useEntryStore selectors.
  useEffect(() => {
    if (!entryId) return;
    void useEntryStore.getState().getEntryById(entryId);
  }, [entryId]);

  const { state: ttsState, synthesizeAndPlay, stop: ttsStop, toggle: ttsToggle } = useTtsStore();

  // Cross-feature guards: we block conflicting mic actions rather than letting
  // them race the native audio device. Dictation and meeting recording both
  // own the cpal stream exclusively, so only one can be active at a time.
  const isMeetingRecording = useMeetingStore((s) => s.isGranolaRecording);
  const isMeetingStopping = useMeetingStore((s) => s.isGranolaStopping);
  const toast = useToastStore((s) => s.show);

  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookPickerOpen, setNotebookPickerOpen] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');
  /** Incrementing counter the sidebar uses as its "please refetch" trigger. */
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarRefresh((v) => v + 1), []);

  // windowNarrow: true when viewport < 900px. Drives icon-only buttons and
  // auto-collapsed sidebar on small screens. Pure viewport signal — no localStorage.
  const [windowNarrow, setWindowNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 900 : false
  );
  useEffect(() => {
    const onResize = () => setWindowNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Sidebar collapsed pref stored in localStorage. On narrow viewports,
  // windowNarrow overrides and always collapses regardless of the stored pref.
  const SIDEBAR_COLLAPSE_KEY = 'ironmic-notes-sidebar-collapsed';
  const [sidebarCollapsedPref, setSidebarCollapsedPref] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch { /* ignore */ }
    return false;
  });
  const notesSidebarCollapsed = windowNarrow || sidebarCollapsedPref;
  const toggleNotesSidebar = useCallback(() => {
    if (windowNarrow) return;
    setSidebarCollapsedPref((v) => {
      const next = !v;
      try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [windowNarrow]);

  const draft = useRef(loadDraft());

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Click Dictate and start speaking — words appear here live. Or type directly.' }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: '' } }),
      Typography,
      DraftHypothesisExtension,
    ],
    content: draft.current?.html || '',
    editorProps: { attributes: { class: 'focus:outline-none' } },
    onCreate: ({ editor }) => {
      // Rehydrate the store if we had a draft and the store has nothing (first mount).
      if (draft.current?.entryId && !useDictationStore.getState().entryId) {
        setStoreEntryFromDraft({
          entryId: draft.current.entryId,
          title: draft.current.title,
        });
      }
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
    },
    onUpdate: ({ editor }) => {
      // When we're programmatically swapping editor content (polish complete,
      // toggle flip, sidebar selection), skip the debounced save — otherwise
      // we'd persist the just-applied content back over the OTHER side and
      // race the reactive sync effect below.
      if (isApplyingRemoteContentRef.current) {
        const text = editor.getText();
        setCharCount(text.length);
        setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
        return;
      }
      setSaved(false);
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const html = editor.getHTML();
        void saveContent(html);
        saveDraft(html, useDictationStore.getState().entryId, useDictationStore.getState().title);
        setSaved(true);
      }, 1000);
    },
  });

  // ── Load notebooks on mount ──
  useEffect(() => {
    void (async () => {
      try {
        const list = await listNotebooks();
        setNotebooks(list);
      } catch (err) {
        console.warn('[DictatePage] Failed to load notebooks:', err);
      }
    })();
  }, []);

  /** Persist editor content — creates the entry on first meaningful keystroke
   *  so that typing (without dictating) is also saved. Only skips creation when
   *  the editor is entirely empty. */
  const saveContent = useCallback(async (html: string) => {
    const api = window.ironmic;
    const plainText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plainText) return;

    let currentId = useDictationStore.getState().entryId;

    if (!currentId) {
      // First meaningful content typed without dictating — materialize the entry.
      const state = useDictationStore.getState();
      const n = await computeNextNoteNumber();
      const title = state.title || `Note #${n}`;
      const nbId = state.notebookId;
      const tagsArr = [
        `${TITLE_TAG_PREFIX}${title}`,
        `__notebook__:${nbId}`,
        `__status__:draft`,
        `${EMOJI_TAG_PREFIX}${noteEmoji}`,
      ];
      try {
        const entry = await api.createEntry({
          rawTranscript: plainText,
          tags: JSON.stringify(tagsArr),
        } as any);
        currentId = (entry as any).id as string;
        useDictationStore.setState({ entryId: currentId, title });
        setLoadedEntryStatus('draft');
        saveDraft(html, currentId, title);
        try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
      } catch (err) {
        console.error('[DictatePage] Failed to create entry on first keystroke:', err);
        return;
      }
    } else {
      try {
        // Write to whichever side the user is currently viewing. Editing in
        // 'polished' mode updates polishedText only; editing in 'raw' mode
        // updates rawTranscript only. The two stay independent so flipping
        // the toggle round-trips to whatever was last saved on each side.
        const storeEntry = useEntryStore.getState();
        const live = storeEntry.entries.find((e) => e.id === currentId)
          ?? storeEntry.entryCache.get(currentId)
          ?? null;
        const writingPolished = !!live?.polishedText && live?.displayMode === 'polished';
        const updates = writingPolished
          ? { polishedText: plainText }
          : { rawTranscript: plainText };
        const updated = await api.updateEntry(currentId, updates as any);
        // Mirror the update into the store cache so subscribers see the change.
        if (updated) {
          const fixedId = currentId as string;
          useEntryStore.setState((s) => {
            const idx = s.entries.findIndex((e) => e.id === fixedId);
            const nextEntries = idx === -1 ? s.entries : (() => {
              const out = s.entries.slice();
              out[idx] = updated;
              return out;
            })();
            const nextCache = new Map(s.entryCache);
            nextCache.set(fixedId, updated);
            return { entries: nextEntries, entryCache: nextCache };
          });
        }
        try {
          const fresh = await api.getEntry(currentId);
          const sessionId = parseMeetingTag((fresh as any)?.tags ?? null);
          if (sessionId) {
            // Pass the original HTML so the meeting detail page can render the
            // user's formatting (bold, lists, headings) rather than plain text.
            await syncMeetingEntryToSession({ sessionId, plainText, htmlContent: html });
            // Tell MeetingDetailPage (if open) to reload the now-updated session.
            try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
          }
        } catch { /* best-effort */ }
      } catch (err) { console.error('Failed to save:', err); }
    }
  }, []);

  // ── Append arriving dictation chunks to the editor ──
  // This is the renderer's half of the streaming pipeline. The store also
  // saves to the DB, so even if the user navigates away mid-dictation the
  // chunks aren't lost — they just don't show in the editor (expected).
  const lastSeenSeqRef = useRef(chunkSeq);
  useEffect(() => {
    if (!editor) return;
    if (chunkSeq === lastSeenSeqRef.current) return;
    lastSeenSeqRef.current = chunkSeq;
    if (lastChunkText) {
      editor.commands.focus('end');
      editor.commands.insertContent(lastChunkText + ' ');
    }
  }, [editor, chunkSeq, lastChunkText]);

  // ── Drive the live draft-hypothesis decoration from the store ──
  // Cleared automatically when a chunk commits (store wipes draftHypothesis
  // on every committed chunk and on resetSession).
  useEffect(() => {
    if (!editor) return;
    editor.commands.setDraftHypothesis(status === 'recording' ? draftHypothesis : '');
  }, [editor, draftHypothesis, status]);

  /** Toggle the streaming dictation (click Dictate or press Enter on toolbar). */
  const handleDictateToggle = useCallback(async () => {
    if (!editor) return;
    if (status === 'stopping') return; // debounce

    if (status === 'idle') {
      // Conflict guard: can't start dictation while a meeting owns the mic.
      // Show a toast explaining the collision rather than letting the native
      // layer throw a cryptic "already recording" error.
      if (isMeetingRecording || isMeetingStopping) {
        toast({
          type: 'info',
          message: 'Meeting recording is in progress — stop the meeting before starting dictation.',
          durationMs: 5000,
        });
        return;
      }
      try {
        const n = await computeNextNoteNumber();
        const computedTitle = storeTitle || `Note #${n}`;
        if (!storeTitle) setStoreTitle(computedTitle);
        // Pre-seed fullText with whatever the user has already typed so
        // chunks append coherently to existing text.
        const existingPlain = editor.getText().trim();
        useDictationStore.setState({ fullText: existingPlain });
        await storeStart({
          computedTitle,
          defaultPlainText: existingPlain || ' ',
        });
        setLoadedEntryStatus('draft');
      } catch (err) {
        console.error('[DictatePage] Failed to start streaming:', err);
      }
      return;
    }

    if (status === 'recording') {
      try {
        await storeStop();
        if (editor) {
          const html = editor.getHTML();
          saveDraft(html, useDictationStore.getState().entryId, useDictationStore.getState().title);
          await saveContent(html);
          setSaved(true);
        }
      } catch (err: any) {
        console.error('[DictatePage] Failed to stop streaming:', err);
      }
    }
  }, [editor, status, storeTitle, setStoreTitle, storeStart, storeStop, saveContent]);

  // Keep a stable ref to handleDictateToggle for the mount-only effect below.
  const handleDictateToggleRef = useRef(handleDictateToggle);
  useEffect(() => { handleDictateToggleRef.current = handleDictateToggle; }, [handleDictateToggle]);

  // On mount: if Layout set pendingQuickStart (user clicked mic shield from
  // another page), consume the flag and auto-start dictation now that the
  // editor is ready. Using a ref for the callback so the effect deps stay [].
  useEffect(() => {
    if (useDictationStore.getState().pendingQuickStart) {
      useDictationStore.setState({ pendingQuickStart: false });
      // Small defer to ensure TipTap editor has fully initialized.
      setTimeout(() => {
        if (useDictationStore.getState().status === 'idle') {
          void handleDictateToggleRef.current();
        }
      }, 80);
    }
  }, []); // mount only

  // Event bus: mic shield click while already on this page toggles dictation.
  useEffect(() => {
    const handler = () => { void handleDictateToggle(); };
    window.addEventListener('ironmic:quick-action-dictate', handler);
    return () => window.removeEventListener('ironmic:quick-action-dictate', handler);
  }, [handleDictateToggle]);

  // Track live collab session state for the button indicator.
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabState?.((info: any) => {
      const active = info?.active ?? false;
      setCollabActive(active);
      collabActiveRef.current = active;
      setCollabParticipantCount(info?.participants?.length ?? 0);
    });
    return () => { unsub?.(); };
  }, []);

  // Broadcast host keystrokes to participants as live draft events (300 ms throttle).
  useEffect(() => {
    if (!collabActive || !editor) return;
    if (draftThrottleRef.current) clearTimeout(draftThrottleRef.current);
    draftThrottleRef.current = setTimeout(() => {
      const content = editor.getText();
      const name = (() => { try { return localStorage.getItem('ironmic-collab-display-name') || 'Host'; } catch { return 'Host'; } })();
      window.ironmic?.meetingCollabNotifySaved?.(content, name)?.catch(() => {});
    }, 300);
    return () => { if (draftThrottleRef.current) clearTimeout(draftThrottleRef.current); };
  }, [charCount, collabActive, editor]);

  // Apply incoming draft content when we're a participant (no local server running).
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabDraft?.((data: any) => {
      if (collabActiveRef.current) return; // we're the host, ignore
      if (editor && data?.content != null) {
        const html = `<p>${String(data.content).replace(/\n/g, '</p><p>')}</p>`;
        editor.commands.setContent(html, false);
      }
    });
    return () => { unsub?.(); };
  }, [editor]);

  // Keep notes in sync while session is running but modal is closed.
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabNotesUpdated?.((data: any) => {
      if (editor && data?.notes) {
        editor.commands.setContent(`<p>${String(data.notes).replace(/\n/g, '</p><p>')}</p>`);
      }
    });
    return () => { unsub?.(); };
  }, [editor]);

  // Auto-stop when the last participant leaves while the modal is closed.
  useEffect(() => {
    if (!collabOpen && collabActive && collabParticipantCount === 0) {
      window.ironmic?.meetingCollabStop?.().catch(() => {});
    }
  }, [collabOpen, collabActive, collabParticipantCount]);

  const handleReadBack = useCallback(() => {
    if (!editor) return;
    if (ttsState === 'playing' || ttsState === 'paused') {
      ttsStop();
      return;
    }
    const text = editor.getText().trim();
    if (text) synthesizeAndPlay(text, entryId ?? undefined);
  }, [editor, ttsState, synthesizeAndPlay, ttsStop, entryId]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const startEditTitle = useCallback(() => {
    const current = storeTitle || draft.current?.title || '';
    setLocalTitle(current);
    setIsEditingTitle(true);
  }, [storeTitle]);

  const commitTitle = useCallback(async () => {
    const trimmed = localTitle.trim();
    const finalTitle = trimmed || storeTitle || draft.current?.title || 'Untitled note';
    setStoreTitle(finalTitle);
    setIsEditingTitle(false);

    let currentId = useDictationStore.getState().entryId;

    if (!currentId) {
      // Entry doesn't exist yet — create one if the title is meaningfully changed.
      const state = useDictationStore.getState();
      const tagsArr = [
        `${TITLE_TAG_PREFIX}${finalTitle}`,
        `__notebook__:${state.notebookId}`,
        `__status__:draft`,
        `${EMOJI_TAG_PREFIX}${noteEmoji}`,
      ];
      try {
        const entry = await window.ironmic.createEntry({
          rawTranscript: ' ',
          tags: JSON.stringify(tagsArr),
        } as any);
        currentId = (entry as any).id as string;
        useDictationStore.setState({ entryId: currentId, title: finalTitle });
        setLoadedEntryStatus('draft');
        try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
      } catch { /* noop */ }
      return;
    }

    try {
      const freshEntry = await window.ironmic.getEntry(currentId);
      if (freshEntry) {
        let tagArr: string[] = [];
        try {
          const parsed = JSON.parse((freshEntry as any)?.tags || '[]');
          if (Array.isArray(parsed)) tagArr = parsed.filter((s: any) => typeof s === 'string');
        } catch { /* ignore */ }
        tagArr = tagArr.filter((s: string) => !s.startsWith(TITLE_TAG_PREFIX));
        tagArr.push(`${TITLE_TAG_PREFIX}${finalTitle}`);
        await window.ironmic.updateEntry(currentId, { tags: JSON.stringify(tagArr) } as any);
        const sessionId = parseMeetingTag(JSON.stringify(tagArr));
        if (sessionId) await syncMeetingEntryToSession({ sessionId, title: finalTitle });
      }
    } catch (err) {
      console.warn('[DictatePage] Failed to persist title rename:', err);
    }
  }, [localTitle, storeTitle, setStoreTitle]);

  const finalizeAndReset = useCallback(async (finalStatus: 'draft' | 'done') => {
    if (!editor) return;
    if (status !== 'idle') {
      try { await storeStop(); } catch { /* noop */ }
    }
    const text = editor.getText().trim();

    // Flush any typed content that hasn't created an entry yet (user typed
    // quickly without dictating, debounce not fired yet).
    if (text && !useDictationStore.getState().entryId) {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      await saveContent(editor.getHTML());
    }

    const currentId = useDictationStore.getState().entryId;
    if (text && currentId) {
      try {
        const freshRaw = await window.ironmic.getEntry(currentId);
        let tagArr: string[] = [];
        try {
          const parsed = JSON.parse((freshRaw as any)?.tags || '[]');
          if (Array.isArray(parsed)) tagArr = parsed.filter((s) => typeof s === 'string');
        } catch { /* ignore */ }

        // Ensure title — fallback to Note #N if the entry somehow lacks one.
        if (!tagArr.some((s) => s.startsWith(TITLE_TAG_PREFIX))) {
          const n = await computeNextNoteNumber();
          tagArr.push(`${TITLE_TAG_PREFIX}Note #${n}`);
        }
        // Ensure notebook — match the active picker selection.
        tagArr = tagArr.filter((s) => !s.startsWith('__notebook__:'));
        tagArr.push(`__notebook__:${notebookId}`);
        // Stamp status.
        tagArr = tagArr.filter((s) => !s.startsWith('__status__:'));
        tagArr.push(`__status__:${finalStatus}`);

        await window.ironmic.updateEntry(currentId, {
          tags: JSON.stringify(tagArr),
          rawTranscript: text,
        } as any);
        const sessionId = parseMeetingTag(JSON.stringify(tagArr));
        if (sessionId) {
          const titleTag = tagArr.find((s) => s.startsWith(TITLE_TAG_PREFIX));
          const finalTitle = titleTag ? titleTag.slice(TITLE_TAG_PREFIX.length) : undefined;
          await syncMeetingEntryToSession({
            sessionId,
            plainText: text,
            htmlContent: editor.getHTML(),
            title: finalTitle,
          });
        }
      } catch (err) {
        console.warn('[DictatePage] Could not finalize note:', err);
      }
    }
    // Reset everything.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    editor.commands.clearContent();
    storeReset();
    setLoadedEntryStatus(null);
    setNoteEmoji(pickRandomEmoji());
    setWordCount(0);
    setCharCount(0);
    setSaved(true);
    clearDraft();
    draft.current = null; // clear cached ref so displayTitle shows 'New note'
    bumpSidebar();
    try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); }
    catch { /* noop */ }
  }, [editor, status, storeStop, storeReset, notebookId, bumpSidebar]);

  /** Build a TipTap-compatible HTML string from a plain-text body, preserving
   *  paragraph breaks. Plain `setContent(string)` would collapse them. */
  const textToHtml = useCallback((text: string): string => {
    if (!text) return '';
    return text
      .split(/\n\n+/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }, []);

  /** Toggle handler — flicks display mode. If polished text doesn't exist
   *  yet, kicks off polish via the store (which keeps running through any
   *  navigation). Otherwise just persists the displayMode flip. */
  const handleTogglePolish = useCallback((next: 'raw' | 'polished') => {
    if (!entryId) return;
    if (next === 'polished' && !polishedEntry?.polishedText) return;
    void useEntryStore.getState().setEntryDisplayMode(entryId, next);
  }, [entryId, polishedEntry?.polishedText]);

  const handlePolishClick = useCallback(() => {
    if (!editor || !entryId) return;
    if (isPolishing) return;
    if (status !== 'idle') {
      toast({ type: 'info', message: 'Stop dictation before polishing.', durationMs: 4000 });
      return;
    }
    const hasExisting = !!polishedEntry?.polishedText;
    if (hasExisting) {
      const confirmed = window.confirm(
        'This will replace the existing polished version with a new one. Continue?',
      );
      if (!confirmed) return;
    }
    const liveRaw = editor.getText().trim();
    void useEntryStore.getState().polishEntry(entryId, { rawOverride: liveRaw, force: hasExisting });
  }, [editor, entryId, isPolishing, polishedEntry?.polishedText, status, toast]);

  // Reactive editor sync: whenever the persisted (mode, polishedText, raw)
  // changes, swap the editor content to match — but only when the change
  // comes from outside this editor (e.g., a polish that completed in the
  // background, or the user toggling on the Timeline page). We guard the
  // programmatic setContent with isApplyingRemoteContentRef so onUpdate
  // doesn't immediately persist the shown text back over the other side.
  useEffect(() => {
    if (!editor || !entryId) return;
    if (isPolishing) return; // overlay covers content; don't fight the user.
    if (!polishedEntry) return;
    const desired = effectiveMode === 'polished' && polishedEntry.polishedText
      ? polishedEntry.polishedText
      : polishedEntry.rawTranscript;
    const key = `${entryId}|${effectiveMode}|${(desired || '').length}|${(desired || '').slice(0, 32)}`;
    if (lastAppliedSyncKeyRef.current === key) return;
    const current = editor.getText();
    if (current === desired) {
      lastAppliedSyncKeyRef.current = key;
      return;
    }
    isApplyingRemoteContentRef.current = true;
    try {
      editor.commands.setContent(textToHtml(desired || ''), false);
      lastAppliedSyncKeyRef.current = key;
    } finally {
      isApplyingRemoteContentRef.current = false;
    }
  }, [editor, entryId, effectiveMode, polishedEntry, isPolishing, textToHtml]);

  // Lock the editor while polish is running so the user can't type into a
  // view that's about to be replaced.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!isPolishing);
  }, [editor, isPolishing]);

  /** Save — persist the current note (status=done) and stay on it. */
  const handleSave = useCallback(async () => {
    if (!editor) return;
    const text = editor.getText().trim();
    if (!text) return;

    if (status !== 'idle') {
      try { await storeStop(); } catch { /* noop */ }
    }

    // Flush any pending auto-save debounce.
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    await saveContent(editor.getHTML());

    const currentId = useDictationStore.getState().entryId;
    if (currentId) {
      try {
        const freshRaw = await window.ironmic.getEntry(currentId);
        let tagArr: string[] = [];
        try {
          const parsed = JSON.parse((freshRaw as any)?.tags || '[]');
          if (Array.isArray(parsed)) tagArr = parsed.filter((s: any) => typeof s === 'string');
        } catch { /* ignore */ }

        if (!tagArr.some((s) => s.startsWith(TITLE_TAG_PREFIX))) {
          const n = await computeNextNoteNumber();
          tagArr.push(`${TITLE_TAG_PREFIX}Note #${n}`);
        }
        tagArr = tagArr.filter((s) => !s.startsWith('__notebook__:'));
        tagArr.push(`__notebook__:${notebookId}`);
        tagArr = tagArr.filter((s) => !s.startsWith('__status__:'));
        tagArr.push('__status__:done');

        await window.ironmic.updateEntry(currentId, {
          tags: JSON.stringify(tagArr),
          rawTranscript: text,
        } as any);
        setLoadedEntryStatus('done');
        setSaved(true);
        bumpSidebar();
        try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
      } catch (err) {
        console.warn('[DictatePage] Could not save note:', err);
      }
    }

    setDoneFlash(true);
    setTimeout(() => setDoneFlash(false), 1200);
  }, [editor, status, storeStop, notebookId, bumpSidebar, saveContent]);

  /** New Note — finalize the current note (status=done) and open a fresh one. */
  const handleDone = useCallback(async () => {
    await finalizeAndReset('done');
    setDoneFlash(true);
    setTimeout(() => setDoneFlash(false), 1200);
  }, [finalizeAndReset]);

  /** Sidebar's "+ new note" button — same as Done: finalize the current note
   *  and open a fresh blank canvas. */
  const handleSidebarNewNote = useCallback(() => {
    void handleDone();
  }, [handleDone]);

  const handleEmojiChange = useCallback(async (emoji: string) => {
    setNoteEmoji(emoji);
    const currentId = useDictationStore.getState().entryId;
    if (!currentId) return;
    try {
      const freshRaw = await window.ironmic.getEntry(currentId);
      const parsed: string[] = JSON.parse((freshRaw as any)?.tags || '[]');
      const filtered = parsed.filter((s: string) => !s.startsWith(EMOJI_TAG_PREFIX));
      filtered.push(`${EMOJI_TAG_PREFIX}${emoji}`);
      await window.ironmic.updateEntry(currentId, { tags: JSON.stringify(filtered) } as any);
    } catch { /* best effort */ }
  }, []);

  // ── Load an entry from the sidebar into the editor ──
  // When the user clicks a different note in the sidebar, we swap the editor
  // content + store state to that entry. Blocked if actively dictating so we
  // don't create a confusing mismatch between where chunks are landing and
  // what the user is looking at.
  const handleSelectEntry = useCallback((entry: Entry) => {
    if (!editor) return;
    if (status !== 'idle') {
      toast({
        type: 'info',
        message: 'Finish or stop dictation before switching notes.',
        durationMs: 4000,
      });
      return;
    }
    // Flush any pending debounce for the currently-open note before we swap.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const plain = (entry.rawTranscript || '').trim();
    // TipTap accepts HTML or plain text — wrap paragraphs so linebreaks survive.
    const html = plain
      ? plain.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`).join('')
      : '';
    editor.commands.setContent(html, false);
    const text = editor.getText();
    setCharCount(text.length);
    setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
    setSaved(true);

    const nextTitle = parseTitleTag(entry.tags) || 'Untitled note';
    const nextNotebook = parseNotebookTag(entry.tags) || getDefaultNotebookId();
    useDictationStore.setState({
      entryId: entry.id,
      title: nextTitle,
      notebookId: nextNotebook,
      fullText: plain,
      // Don't touch chunkSeq — appending future chunks is still keyed off it.
      lastChunkText: '',
    });
    // Reflect actual persisted status so the badge is accurate for finalized notes.
    setLoadedEntryStatus(parseStatusTag(entry.tags));
    setNoteEmoji(parseEmojiTag(entry.tags) || pickRandomEmoji());
    saveDraft(html, entry.id, nextTitle);
  }, [editor, status, toast]);

  // ── Refresh the sidebar when meaningful things happen ──
  // (a) dictation finished (status went idle with an entry present), or
  // (b) the active notebook changed (a note was reclassified).
  useEffect(() => { bumpSidebar(); }, [notebookId, bumpSidebar]);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== 'idle' && status === 'idle') bumpSidebar();
    prevStatusRef.current = status;
  }, [status, bumpSidebar]);

  // ── Notebook picker ──
  const currentNotebook = notebooks.find((n) => n.id === notebookId);
  const defaultNbId = getDefaultNotebookId();

  const handlePickNotebook = useCallback(async (nbId: string) => {
    setNotebookPickerOpen(false);
    await moveCurrentToNotebook(nbId);
  }, [moveCurrentToNotebook]);

  const handleCreateNotebook = useCallback(async () => {
    const name = newNotebookName.trim();
    if (!name) return;
    try {
      const nb = await createNotebook(name);
      const list = await listNotebooks();
      setNotebooks(list);
      setNewNotebookName('');
      setNotebookPickerOpen(false);
      await moveCurrentToNotebook(nb.id);
    } catch (err) {
      console.warn('[DictatePage] Failed to create notebook:', err);
    }
  }, [newNotebookName, moveCurrentToNotebook]);

  if (!editor) return null;

  const isRecording = status === 'recording';
  const isStopping = status === 'stopping';
  const displayTitle = storeTitle || draft.current?.title || 'New note';

  // Show live word count from store if streaming+no editor-text yet (edge case
  // when user navigated back during streaming and editor is blank).
  const effectiveWordCount = wordCount || (isRecording && fullText ? fullText.trim().split(/\s+/).length : 0);

  return (
    <div className="h-full flex bg-iron-bg">
      {/* Left: notebook/notes hierarchy */}
      <NotesSidebar
        activeEntryId={entryId}
        onSelectEntry={handleSelectEntry}
        onNewNote={handleSidebarNewNote}
        refreshSignal={sidebarRefresh}
        collapsed={notesSidebarCollapsed}
        onToggleCollapsed={toggleNotesSidebar}
      />

      {/* Right: the note editor */}
      <div className="flex-1 flex flex-col min-w-0">
      {/* Header — two-row layout with large emoji anchor */}
      <div className="px-5 pt-3 pb-2.5 border-b border-iron-border">
        <div className="flex items-center gap-4 max-w-4xl mx-auto">

          {/* Emoji — spans both rows as a visual anchor */}
          <NoteEmojiPicker
            emoji={noteEmoji}
            onChange={handleEmojiChange}
            buttonClassName="w-12 h-12 rounded-2xl text-2xl"
          />

          {/* Two-row content */}
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">

            {/* Row 1: Breadcrumb + Status */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {/* Notebook dropdown */}
                <div className="relative flex items-center flex-shrink-0">
                  <button
                    onClick={() => setNotebookPickerOpen((v) => !v)}
                    className="flex items-center gap-0.5 text-sm text-iron-text-muted hover:text-iron-text-secondary transition-colors"
                    title="Change notebook"
                  >
                    <span className="font-medium truncate max-w-[160px]">{currentNotebook?.name ?? 'My Notes'}</span>
                    <ChevronDown className="w-2.5 h-2.5 flex-shrink-0 opacity-60" />
                  </button>
                  {notebookPickerOpen && (
                    <div className="absolute left-0 top-full mt-1 w-56 bg-iron-surface border border-iron-border rounded-lg shadow-xl py-1 z-20">
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-iron-text-muted">Move to notebook</div>
                      {notebooks.map((nb) => (
                        <button
                          key={nb.id}
                          onClick={() => handlePickNotebook(nb.id)}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between ${
                            nb.id === notebookId
                              ? 'bg-iron-accent/10 text-iron-accent-light'
                              : 'text-iron-text hover:bg-iron-surface-hover'
                          }`}
                        >
                          <span className="truncate">{nb.name}</span>
                          {nb.id === notebookId && <Check className="w-3 h-3 flex-shrink-0" />}
                          {nb.id === defaultNbId && nb.id !== notebookId && (
                            <span className="text-[9px] text-iron-text-muted">default</span>
                          )}
                        </button>
                      ))}
                      <div className="border-t border-iron-border mt-1 pt-1 px-2 pb-1">
                        <div className="flex items-center gap-1">
                          <input
                            value={newNotebookName}
                            onChange={(e) => setNewNotebookName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateNotebook(); }}
                            placeholder="New notebook…"
                            className="flex-1 text-xs bg-iron-bg border border-iron-border rounded px-2 py-1 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50"
                          />
                          <button
                            onClick={handleCreateNotebook}
                            disabled={!newNotebookName.trim()}
                            className="p-1 rounded text-iron-accent-light hover:bg-iron-accent/10 disabled:opacity-30"
                            title="Create notebook"
                          >
                            <BookPlus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <span className="text-iron-text-muted/40 text-sm font-light flex-shrink-0">/</span>

                {/* Editable title */}
                {isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    value={localTitle}
                    onChange={(e) => setLocalTitle(e.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitTitle(); }
                      if (e.key === 'Escape') setIsEditingTitle(false);
                    }}
                    className="text-sm font-semibold bg-transparent border-b border-iron-accent/50 text-iron-text focus:outline-none min-w-0 flex-1"
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={startEditTitle}
                    className="text-sm font-semibold text-iron-text truncate hover:text-iron-accent-light text-left group flex items-center gap-1.5 min-w-0"
                    title="Click to rename"
                  >
                    <span className="truncate">{displayTitle}</span>
                    <Pencil className="w-3 h-3 text-iron-text-muted opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0" />
                  </button>
                )}
              </div>

              {/* Status badge */}
              {entryId && (
                <div className="flex items-center flex-shrink-0">
                  {loadedEntryStatus !== 'done' && (
                    <span
                      className="inline-flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded leading-none"
                      title="Draft — click Save to finalize"
                    >
                      <Circle className="w-1.5 h-1.5 fill-current flex-shrink-0" />
                      Draft
                    </span>
                  )}
                  {loadedEntryStatus === 'done' && (
                    <span className="inline-flex items-center text-[9px] font-medium uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded leading-none">
                      Saved
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Row 2: All action controls */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {entryId && (
                <>
                  {polishedEntry?.polishedText && (
                    <>
                      <button
                        type="button"
                        onClick={handlePolishClick}
                        disabled={isPolishing || !editor?.getText().trim()}
                        className={`p-1.5 rounded-xl transition-all ${
                          isPolishing
                            ? 'text-iron-accent-light cursor-wait'
                            : 'text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10'
                        } disabled:opacity-30 disabled:cursor-not-allowed`}
                        title="Re-polish this note"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                      </button>
                      <RawPolishedToggle
                        displayMode={isPolishing ? 'polished' : effectiveMode}
                        isPolishing={isPolishing}
                        providerBadge={polishProvider}
                        onToggle={handleTogglePolish}
                      />
                    </>
                  )}
                  {!polishedEntry?.polishedText && (
                    <button
                      type="button"
                      onClick={handlePolishClick}
                      disabled={isPolishing || !editor?.getText().trim()}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                        isPolishing
                          ? 'text-iron-accent-light cursor-wait'
                          : 'text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10 border border-iron-border hover:border-iron-accent/30'
                      } disabled:opacity-30 disabled:cursor-not-allowed`}
                      title="Polish this note"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {!windowNarrow && 'Polish'}
                    </button>
                  )}
                </>
              )}

              <button
                onClick={handleDictateToggle}
                disabled={isStopping}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                  isRecording
                    ? 'bg-iron-danger text-white shadow-glow-danger animate-pulse-recording'
                    : isStopping
                    ? 'bg-iron-warning text-white shadow-glow'
                    : 'bg-gradient-accent text-white hover:shadow-glow'
                }`}
                title={isRecording ? 'Stop recording' : 'Start live dictation'}
              >
                {isRecording ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {!windowNarrow && (isRecording ? 'Stop' : isStopping ? 'Stopping…' : 'Dictate')}
              </button>

              <button
                onClick={() => setCollabOpen(true)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                  collabActive
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20'
                    : 'text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10 border border-iron-border hover:border-iron-accent/30'
                }`}
                title={collabActive
                  ? `Live session — ${collabParticipantCount} participant${collabParticipantCount !== 1 ? 's' : ''} connected`
                  : 'Collaborate on this note with teammates'}
              >
                {collabActive
                  ? <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  : <Users className="w-3.5 h-3.5" />}
                {!windowNarrow && (collabActive
                  ? `Live${collabParticipantCount > 0 ? ` · ${collabParticipantCount}` : ''}`
                  : 'Collaborate')}
              </button>

              <button
                onClick={ttsState === 'playing' || ttsState === 'paused' ? () => ttsToggle() : handleReadBack}
                disabled={ttsState === 'synthesizing' || (!editor?.getText().trim() && ttsState === 'idle')}
                className={`p-1.5 rounded-xl text-xs font-medium transition-all ${
                  ttsState === 'playing'
                    ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                    : ttsState === 'paused'
                    ? 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
                    : ttsState === 'synthesizing'
                    ? 'text-iron-text-muted opacity-50 cursor-wait'
                    : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
                } disabled:opacity-30 disabled:cursor-not-allowed`}
                title={ttsState === 'playing' ? 'Pause read-back' : ttsState === 'paused' ? 'Resume read-back' : 'Read Back'}
              >
                {ttsState === 'playing' ? <Pause className="w-3.5 h-3.5" /> :
                 ttsState === 'paused' ? <Play className="w-3.5 h-3.5" /> :
                 <Volume2 className="w-3.5 h-3.5" />}
              </button>

              {(ttsState === 'playing' || ttsState === 'paused') && (
                <button
                  onClick={handleReadBack}
                  className="p-1.5 rounded-xl text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all"
                  title="Stop read-back"
                >
                  <Square className="w-3 h-3" />
                </button>
              )}

              <button
                onClick={handleSave}
                className={`p-1.5 rounded-xl transition-all ${
                  doneFlash
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'text-iron-text-muted hover:text-emerald-400 hover:bg-emerald-500/10'
                }`}
                title="Save this note"
              >
                <Save className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={handleDone}
                className="p-1.5 rounded-xl text-iron-text-muted hover:text-iron-accent-light hover:bg-iron-accent/10 transition-all"
                title="Save and start a new note"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-iron-border bg-iron-surface/40 flex-wrap">
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo" />
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} icon={<Heading1 className="w-3.5 h-3.5" />} title="Heading 1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} icon={<Heading2 className="w-3.5 h-3.5" />} title="Heading 2" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} icon={<Heading3 className="w-3.5 h-3.5" />} title="Heading 3" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} icon={<Bold className="w-3.5 h-3.5" />} title="Bold" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} icon={<Italic className="w-3.5 h-3.5" />} title="Italic" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} icon={<UnderlineIcon className="w-3.5 h-3.5" />} title="Underline" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} icon={<Strikethrough className="w-3.5 h-3.5" />} title="Strikethrough" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} icon={<Highlighter className="w-3.5 h-3.5" />} title="Highlight" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} icon={<List className="w-3.5 h-3.5" />} title="Bullet list" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} icon={<ListOrdered className="w-3.5 h-3.5" />} title="Ordered list" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} icon={<Quote className="w-3.5 h-3.5" />} title="Quote" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} icon={<Code className="w-3.5 h-3.5" />} title="Code" />
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} icon={<Minus className="w-3.5 h-3.5" />} title="Divider" />
        <ToolbarDivider />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} icon={<AlignLeft className="w-3.5 h-3.5" />} title="Align left" />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} icon={<AlignCenter className="w-3.5 h-3.5" />} title="Align center" />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} icon={<AlignRight className="w-3.5 h-3.5" />} title="Align right" />
        <ToolbarDivider />
        <ToolbarBtn onClick={setLink} active={editor.isActive('link')} icon={<LinkIcon className="w-3.5 h-3.5" />} title="Link" />
      </div>

      {/* Editor */}
      <div className={`flex-1 overflow-y-auto relative${status === 'recording' && draftHypothesis ? ' has-draft-hypothesis' : ''}`}>
        <EditorContent editor={editor} />
        {isPolishing && (
          <div
            className="absolute inset-0 bg-iron-bg/70 backdrop-blur-[2px] flex items-center justify-center z-10 pointer-events-auto"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-iron-surface border border-iron-border shadow-lg">
              <Loader2 className="w-4 h-4 animate-spin text-iron-accent-light" />
              <span className="text-sm font-medium text-iron-text">Generating polished version…</span>
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-5 py-1.5 border-t border-iron-border bg-iron-surface/30 text-[10px] text-iron-text-muted">
        <div className="flex items-center gap-3">
          <span>{effectiveWordCount} words</span>
          <span>{charCount} characters</span>
          {isRecording && (
            <span className="text-iron-danger flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-iron-danger animate-pulse" />
              Live
            </span>
          )}
        </div>
        <span>{saved ? 'Saved' : 'Saving...'}</span>
      </div>
      </div>

      {collabOpen && (
        <NotesCollaborateModal
          noteId={entryId}
          initialNotes={editor?.getText() ?? ''}
          onNotesUpdated={(notes) => {
            if (editor) editor.commands.setContent(`<p>${notes.replace(/\n/g, '</p><p>')}</p>`);
          }}
          onJoined={({ notes }) => {
            if (editor) editor.commands.setContent(`<p>${notes.replace(/\n/g, '</p><p>')}</p>`);
          }}
          onClose={() => setCollabOpen(false)}
        />
      )}
    </div>
  );
}

function ToolbarBtn({ onClick, active, disabled, icon, title }: {
  onClick: () => void; icon: React.ReactNode; title: string; active?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${
        active
          ? 'bg-iron-accent/15 text-iron-accent-light'
          : disabled
          ? 'text-iron-text-muted/30 cursor-not-allowed'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      }`}
    >
      {icon}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-4 bg-iron-border mx-1" />;
}
