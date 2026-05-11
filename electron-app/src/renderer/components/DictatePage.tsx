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
import Placeholder from '@tiptap/extension-placeholder';
import { buildSharedExtensions } from '../../shared/tiptapExtensions';
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
import { TtsHighlightExtension } from './TtsHighlightExtension';
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

/** Wire payload version marker. Bump if the wrapper schema changes
 *  incompatibly so receivers can ignore unknown future versions. */
const COLLAB_WIRE_VERSION = 1;

interface CollabWireMeta {
  /** Note title (synced across the session — bug 3). */
  title?: string;
  /** Note emoji (synced across the session — bug 3). */
  emoji?: string;
}

/** Pack a TipTap doc + side-channel metadata (title, emoji) into a single
 *  wire string. We can't extend the IPC method signatures without breaking
 *  the meeting collab components that share these channels, so the meta
 *  rides inside the same `content` string the doc used to occupy. */
function packCollabPayload(doc: any, meta: CollabWireMeta): string {
  return JSON.stringify({
    __ironmic_collab__: COLLAB_WIRE_VERSION,
    doc,
    meta,
  });
}

/** Parse a wire payload. Accepts:
 *   - the new wrapper `{__ironmic_collab__, doc, meta}` (DictatePage peers)
 *   - a bare TipTap `{type: "doc", ...}` (older DictatePage peers)
 *   - plaintext (meeting collab components — handled by the caller)
 *  Returns null when the payload isn't recognizable JSON (so the caller
 *  can fall back to plaintext rendering). */
function parseCollabWirePayload(serialized: string): { doc: any; meta?: CollabWireMeta } | null {
  try {
    const parsed = JSON.parse(serialized);
    if (parsed && typeof parsed === 'object') {
      if (parsed.__ironmic_collab__ && parsed.doc?.type === 'doc') {
        return { doc: parsed.doc, meta: parsed.meta ?? undefined };
      }
      if (parsed.type === 'doc') {
        return { doc: parsed };
      }
    }
  } catch { /* not JSON */ }
  return null;
}

/** Wrap legacy plaintext payloads as escaped HTML — paragraph breaks on
 *  `\n\n`, `<br>` on single `\n`. We escape `&<>` first so meeting plaintext
 *  containing `<` (e.g. "5 < 10") doesn't get mis-parsed as HTML. */
function plainTextWireToTiptapHtml(s: string): string {
  return s.split(/\n\n+/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Walk a TipTap doc JSON tree and produce plain text. Used to derive text
 *  for `createEntry` / DB writes WITHOUT having to load the JSON into the
 *  live editor first (which would clobber whatever the user has on screen). */
function tiptapJsonToPlainText(node: any): string {
  if (!node) return '';
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  let out = '';
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += tiptapJsonToPlainText(child);
  }
  // Add a trailing newline after block-ish nodes so paragraph breaks survive.
  if (node.type && /^(paragraph|heading|listItem|blockquote|codeBlock|horizontalRule)$/.test(node.type)) {
    out += '\n';
  }
  return out;
}

/** Derive a `(plainText, json, meta?)` triple from a wire payload without
 *  touching the live editor. Accepts wrapped JSON, bare TipTap JSON, or a
 *  plaintext/HTML string. The json field is always a stringified TipTap doc
 *  so the caller can persist it directly into `rawTranscriptJson`. */
function deriveTextAndJsonFromWire(serialized: string): { plainText: string; json: string; meta?: CollabWireMeta } {
  const wrapped = parseCollabWirePayload(serialized);
  if (wrapped) {
    return {
      plainText: tiptapJsonToPlainText(wrapped.doc).trim(),
      json: JSON.stringify(wrapped.doc),
      meta: wrapped.meta,
    };
  }
  // Fallback: treat as plaintext (or sloppy HTML). Strip tags for text and
  // synthesise a minimal TipTap doc so the JSON column is valid.
  const stripped = String(serialized)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const synth = {
    type: 'doc',
    content: stripped.split(/\n\n+/).map(p => ({
      type: 'paragraph',
      content: p ? [{ type: 'text', text: p }] : [],
    })),
  };
  return { plainText: stripped.trim(), json: JSON.stringify(synth) };
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
  // Collab state is split: host-side (we run the server) vs. joined (we are
  // a participant on someone else's server). The IPC channel
  // `ironmic:meeting-collab-state` is shared by both managers — they push
  // different shapes (CollabServerInfo vs. CollabClientInfo), so the receive
  // handler below branches on shape.
  const [collabHostActive, setCollabHostActive] = useState(false);
  const [collabJoined, setCollabJoined] = useState(false);
  const [collabHostName, setCollabHostName] = useState<string | null>(null);
  const [collabParticipantCount, setCollabParticipantCount] = useState(0);
  // State mirror of collabBoundEntryIdRef so the sidebar can render the
  // "live" green-dot indicator on the right entry. Refs don't trigger
  // re-renders, so we keep both: the ref for hot-path checks (send/receive)
  // and the state for declarative rendering.
  const [collabBoundEntryId, setCollabBoundEntryId] = useState<string | null>(null);
  const collabHostActiveRef = useRef(false);
  const collabJoinedRef = useRef(false);
  const collabSelfIdRef = useRef<string | null>(null);
  /** The entry this collab session reads/writes. Stable across sidebar
   *  navigation. Cleared on Leave / End. F3 routes persistence to this id. */
  const collabBoundEntryIdRef = useRef<string | null>(null);
  // Derived: any kind of collab session is active.
  const collabActive = collabHostActive || collabJoined;
  const [noteEmoji, setNoteEmoji] = useState(() => pickRandomEmoji());
  // The editor's `onUpdate` closure is captured at first mount (useEditor has
  // no deps), so reading `noteEmoji` from there would be stale. Mirror into a
  // ref so the collab-draft send sees the current emoji.
  const noteEmojiRef = useRef(noteEmoji);
  useEffect(() => { noteEmojiRef.current = noteEmoji; }, [noteEmoji]);
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
  /** Monotonic save id. Incremented at the start of every saveContent call.
   *  After every awaited round-trip we re-check it: if a newer save kicked off
   *  while we were waiting, the older one bows out and lets the newer one's
   *  result be the source of truth. Protects against stale store writes when
   *  the user types fast across multiple debounce windows. */
  const saveRevRef = useRef(0);
  /** Bumped on every user keystroke (onUpdate). Snapshotted into saveContent
   *  so the reactive sync effect can tell "this store update is the echo of
   *  my own save" (lastSyncedLocalRev === localEditsRev) from "this is an
   *  external change I should apply" (newer localEditsRev or different rev). */
  const localEditsRevRef = useRef(0);
  /** Set to localEditsRevRef.current at the moment a save completes. The sync
   *  effect early-returns when this matches the current local rev AND the
   *  incoming JSON matches what the editor already holds. */
  const lastSyncedLocalRevRef = useRef(0);

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
  // Live read-back position — subscribed individually so the polling tick
  // (currentTimeMs every ~16ms) doesn't re-render anything else in the page.
  const ttsTimestamps = useTtsStore((s) => s.timestamps);
  const ttsCurrentTimeMs = useTtsStore((s) => s.currentTimeMs);
  const ttsActiveEntryId = useTtsStore((s) => s.activeEntryId);

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

  // Snapshot newNoteRequested at mount so the editor's initial `content` is
  // empty when Layout requested a fresh note (mic shield / global hotkey /
  // tray Quick Start Dictation). Without this, the stale draft loads via the
  // synchronous useRef initializer below before any effect can intervene.
  const newNoteAtMountRef = useRef(useDictationStore.getState().newNoteRequested);
  const draft = useRef(
    newNoteAtMountRef.current
      ? (clearDraft(), null)
      : loadDraft()
  );

  const editor = useEditor({
    extensions: [
      // Shared structural extensions — same set the polish-pipeline's
      // @tiptap/html generateJSON uses in main, so the JSON it produces
      // round-trips losslessly into THIS editor (Table + TaskList + the
      // standard StarterKit extensions). Drift here would corrupt rich
      // polish output silently.
      ...buildSharedExtensions(),
      // Page-specific extras: placeholder + the live-dictation overlay
      // (DraftHypothesisExtension paints the in-flight Moonshine
      // hypothesis) and the read-back highlighter.
      Placeholder.configure({ placeholder: 'Click Dictate and start speaking — words appear here live. Or type directly.' }),
      DraftHypothesisExtension,
      TtsHighlightExtension,
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
    onUpdate: ({ editor, transaction }) => {
      // Hot-path guard: ProseMirror fires onUpdate for EVERY dispatched
      // transaction, including no-op ones that only carry plugin meta (the
      // live Moonshine draft hypothesis updates many times per second via
      // DraftHypothesisExtension) or that only move the selection (focus()
      // calls). Those don't change the doc, so there's no count to refresh,
      // no edit revision to bump, and no save to debounce. Returning here
      // is what keeps dictation feeling snappy on slower machines — every
      // hypothesis tick used to run the full path including a getText()
      // over the whole doc and several React state updates.
      if (!transaction.docChanged) return;

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
      // Bump the local-edit revision so the reactive sync effect can tell our
      // own save echo from a genuine external update.
      localEditsRevRef.current += 1;
      const committedRev = localEditsRevRef.current;
      const text = editor.getText();
      setCharCount(text.length);
      setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // Snapshot editor state at fire time (NOT at closure-creation time) so
        // saveContent never reads from a stale `editor` reference. Plaintext
        // comes from getText(), not from a regex over HTML — that regex
        // collapses paragraph breaks and was the proximate cause of the
        // formatting-loss bug.
        const plainText = editor.getText().trim();
        const json = JSON.stringify(editor.getJSON());
        const html = editor.getHTML();
        void saveContent({ plainText, json, html, committedRev });
        saveDraft(html, useDictationStore.getState().entryId, useDictationStore.getState().title);
        setSaved(true);
      }, 1000);

      // Live keystroke preview for collab peers — 300 ms throttle. Folded in
      // here (not a separate effect keyed on charCount) so that remote
      // applies — which call setCharCount via applyRemoteToEditor — can't
      // re-trigger a draft send back at the original sender. The
      // `isApplyingRemoteContentRef` early-return at the top of onUpdate
      // already gates this branch, so user keystrokes are the only thing
      // that schedule a draft.
      //
      // Bound-entry guard: only broadcast when the editor is showing the
      // shared note. Otherwise typing in an unrelated note (after the user
      // navigated away in the sidebar) would replace peers' shared content
      // with this note's content.
      if (
        (collabHostActiveRef.current || collabJoinedRef.current) &&
        collabBoundEntryIdRef.current &&
        collabBoundEntryIdRef.current === useDictationStore.getState().entryId
      ) {
        if (draftThrottleRef.current) clearTimeout(draftThrottleRef.current);
        draftThrottleRef.current = setTimeout(() => {
          const meta: CollabWireMeta = {
            title: useDictationStore.getState().title ?? undefined,
            emoji: noteEmojiRef.current ?? undefined,
          };
          const wire = packCollabPayload(editor.getJSON(), meta);
          const name = (() => {
            try { return localStorage.getItem('ironmic-collab-display-name') || (collabHostActiveRef.current ? 'Host' : 'Viewer'); }
            catch { return collabHostActiveRef.current ? 'Host' : 'Viewer'; }
          })();
          if (collabHostActiveRef.current) {
            window.ironmic?.meetingCollabNotifyDraft?.(wire, name)?.catch(() => {});
          } else if (collabJoinedRef.current) {
            window.ironmic?.meetingCollabSendDraft?.(wire)?.catch(() => {});
          }
        }, 300);
      }
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
   *  the editor is entirely empty.
   *
   *  Important: takes a SNAPSHOT (plainText/json/html) so it never reads from
   *  the live `editor` ref — closing over `editor` would be a footgun (stale
   *  on first render, drifting under us if a programmatic setContent runs
   *  during a pending save). Caller passes the snapshot it captured at fire
   *  time. */
  const saveContent = useCallback(async (snapshot: {
    plainText: string;
    json: string;
    html: string;
    committedRev: number;
  }) => {
    const { plainText, json, html, committedRev } = snapshot;
    if (!plainText) return;
    const api = window.ironmic;

    // Stale-save guard: if a newer save kicks off while we're awaiting, the
    // older save bows out so it can't overwrite the newer one's store mirror.
    const myRev = ++saveRevRef.current;
    const isCurrent = () => myRev === saveRevRef.current;

    let currentId = useDictationStore.getState().entryId;

    if (!currentId) {
      // First meaningful content typed without dictating — materialize the entry.
      const state = useDictationStore.getState();
      const n = await computeNextNoteNumber();
      if (!isCurrent()) return;
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
          rawTranscriptJson: json,
          tags: JSON.stringify(tagsArr),
        } as any);
        if (!isCurrent()) return;
        currentId = (entry as any).id as string;
        useDictationStore.setState({ entryId: currentId, title });
        setLoadedEntryStatus('draft');
        saveDraft(html, currentId, title);
        lastSyncedLocalRevRef.current = committedRev;
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
        // Persist BOTH the plaintext (for FTS, timeline previews, polish input)
        // AND the rich JSON for the active side. Never write the JSON column
        // for the other side — leaving it absent preserves whatever rich
        // state it already held (e.g. user previously hand-edited polished
        // mode; we shouldn't clobber that when they edit raw).
        const updates = writingPolished
          ? { polishedText: plainText, polishedTextJson: json }
          : { rawTranscript: plainText, rawTranscriptJson: json };
        const updated = await api.updateEntry(currentId, updates as any);
        if (!isCurrent()) return;
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
        // Mark this rev as synced BEFORE we trigger any 'entries-changed'
        // event below, so the reactive sync effect (which fires when the
        // store update lands) can early-out instead of clobbering the editor.
        lastSyncedLocalRevRef.current = committedRev;
        try {
          const fresh = await api.getEntry(currentId);
          if (!isCurrent()) return;
          const sessionId = parseMeetingTag((fresh as any)?.tags ?? null);
          if (sessionId) {
            // Pass the original HTML so the meeting detail page can render the
            // user's formatting (bold, lists, headings) rather than plain text.
            await syncMeetingEntryToSession({ sessionId, plainText, htmlContent: html });
            if (!isCurrent()) return;
            // Tell MeetingDetailPage (if open) to reload the now-updated session.
            try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
          }
        } catch { /* best-effort */ }
      } catch (err) { console.error('Failed to save:', err); }
    }

    // Durable-commit hop for collab. Only broadcast when this save belongs to
    // the entry the collab session is bound to, so navigating to an unrelated
    // note doesn't leak its content to peers.
    if (isCurrent() && currentId && collabBoundEntryIdRef.current === currentId) {
      const meta: CollabWireMeta = {
        title: useDictationStore.getState().title ?? undefined,
        emoji: noteEmoji ?? undefined,
      };
      // Re-pack from the just-saved JSON so the wire payload matches the DB
      // and includes title/emoji for peers.
      let parsedDoc: any = null;
      try { parsedDoc = JSON.parse(json); } catch { /* fall back to bare json */ }
      const wire = parsedDoc ? packCollabPayload(parsedDoc, meta) : json;
      if (collabHostActiveRef.current) {
        const hostName = (() => {
          try { return localStorage.getItem('ironmic-collab-display-name') || 'Host'; }
          catch { return 'Host'; }
        })();
        window.ironmic?.meetingCollabNotifySaved?.(wire, hostName)?.catch(() => {});
      } else if (collabJoinedRef.current) {
        window.ironmic?.meetingCollabSaveNotes?.(wire)?.catch(() => {});
      }
    }
  }, [noteEmoji]);

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

  /** Wipe page state back to a fresh, empty note. Used when the user clicks
   *  the mic shield / presses the global hotkey / picks tray "Quick Start
   *  Dictation" and `newNoteRequested` is set on the store. Cancels any
   *  in-flight save and bumps the save revision so a stale debounce can't
   *  later overwrite the new blank entry. */
  const resetToBlankNote = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    saveRevRef.current += 1;

    clearDraft();
    draft.current = null;
    storeReset();
    // storeReset preserves notebookId by design (so navigating in/out of
    // Notes keeps your active notebook). For a fresh-note request we want
    // the new note to land in the user's default ("My Notes") notebook,
    // not whichever notebook the previously-open note belonged to.
    useDictationStore.setState({ notebookId: getDefaultNotebookId() });

    if (editor) {
      isApplyingRemoteContentRef.current = true;
      try {
        editor.commands.setContent('');
      } finally {
        isApplyingRemoteContentRef.current = false;
      }
    }

    setLocalTitle('');
    setIsEditingTitle(false);
    setLoadedEntryStatus(null);
    setWordCount(0);
    setCharCount(0);
    setSaved(true);
    setNoteEmoji(pickRandomEmoji());

    useDictationStore.setState({ newNoteRequested: false });
  }, [editor, storeReset]);

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
        // Read title fresh from the store rather than the closure-captured
        // `storeTitle`. The quick-action handler resets the store
        // synchronously and then calls this via setTimeout(0); the closure
        // here can still hold the previous note's title.
        const liveTitle = useDictationStore.getState().title;
        const computedTitle = liveTitle || `Note #${n}`;
        if (!liveTitle) setStoreTitle(computedTitle);
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
          const plainText = editor.getText().trim();
          const json = JSON.stringify(editor.getJSON());
          localEditsRevRef.current += 1;
          const committedRev = localEditsRevRef.current;
          saveDraft(html, useDictationStore.getState().entryId, useDictationStore.getState().title);
          await saveContent({ plainText, json, html, committedRev });
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

  /** Once-only mount consumption of the quick-start handshake. Layout sets
   *  pendingQuickStart (and optionally newNoteRequested) before navigating
   *  here. We wait for the TipTap editor to be ready, then — atomically —
   *  reset to a blank note (if requested) and auto-start dictation. The
   *  handleDictateToggleRef indirection keeps deps stable so this effect
   *  runs exactly once when editor first becomes available. */
  const consumedQuickStartRef = useRef(false);
  useEffect(() => {
    if (!editor || consumedQuickStartRef.current) return;
    if (!useDictationStore.getState().pendingQuickStart) return;

    consumedQuickStartRef.current = true;

    if (useDictationStore.getState().newNoteRequested) {
      resetToBlankNote();
    }

    useDictationStore.setState({ pendingQuickStart: false });

    // Defer so the cleared editor commits and store reset settles before
    // handleDictateToggle reads state.
    setTimeout(() => {
      if (useDictationStore.getState().status === 'idle') {
        void handleDictateToggleRef.current();
      }
    }, 80);
  }, [editor, resetToBlankNote]);

  // Event bus: mic shield click while already on this page. When Layout set
  // newNoteRequested (status was idle), reset to a blank note first — UNLESS
  // the currently-loaded note is already an untouched default-titled blank
  // (no body text + title is null or matches "Note #N"). In that case we
  // dictate straight into it instead of generating yet another empty
  // Note #N+1. Otherwise (status was recording, or no flag set) just toggle
  // to stop, leaving the in-flight note intact.
  useEffect(() => {
    const handler = () => {
      if (useDictationStore.getState().newNoteRequested) {
        const currentTitle = useDictationStore.getState().title;
        const isDefaultTitle = !currentTitle || /^Note #\d+$/.test(currentTitle);
        const bodyEmpty = !editor || editor.getText().trim() === '';
        if (isDefaultTitle && bodyEmpty) {
          // Reuse the current default-empty note — just clear the flag and
          // start dictating. No reset, no new entry, no number bump.
          useDictationStore.setState({ newNoteRequested: false });
          void handleDictateToggle();
          return;
        }
        resetToBlankNote();
        // Defer one tick so React commits the cleared editor before
        // handleDictateToggle reads its content.
        setTimeout(() => { void handleDictateToggle(); }, 0);
        return;
      }
      void handleDictateToggle();
    };
    window.addEventListener('ironmic:quick-action-dictate', handler);
    return () => window.removeEventListener('ironmic:quick-action-dictate', handler);
  }, [editor, handleDictateToggle, resetToBlankNote]);

  // Track live collab session state. The server pushes CollabServerInfo (has
  // `.active`) and the client pushes CollabClientInfo (has `.connected` +
  // `.participantId`). Branch on shape so we can drive both host and joined
  // indicators from the same channel without one shape masking the other.
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabState?.((info: any) => {
      if (typeof info?.active === 'boolean') {
        // Server push — host-side state.
        setCollabHostActive(info.active);
        collabHostActiveRef.current = info.active;
        setCollabParticipantCount(info?.participants?.length ?? 0);
        if (info.active && typeof info.sessionId === 'string' && info.sessionId.startsWith('note:')) {
          // Bind to the noteId we're hosting for. F3's handlers route
          // persistence through this so navigation in the sidebar can't
          // misroute remote saves.
          const boundId = info.sessionId.slice(5);
          collabBoundEntryIdRef.current = boundId;
          setCollabBoundEntryId(boundId);
        } else if (!info.active) {
          collabBoundEntryIdRef.current = null;
          setCollabBoundEntryId(null);
        }
        return;
      }
      if (typeof info?.connected === 'boolean') {
        // Client push — collaborator-side state.
        setCollabJoined(info.connected);
        collabJoinedRef.current = info.connected;
        setCollabHostName(info?.hostName ?? null);
        collabSelfIdRef.current = info?.participantId ?? null;
        // The collaborator-side participant count includes the host + every
        // viewer, only present when the server's presence broadcast has
        // landed. Surface it for the indicator label when available.
        if (Array.isArray(info?.participants)) {
          setCollabParticipantCount(info.participants.length);
        }
        if (!info.connected) {
          // Disconnected (Leave or host ended). Clear the binding so no
          // further remote events apply or persist anywhere.
          collabBoundEntryIdRef.current = null;
          setCollabBoundEntryId(null);
          collabSelfIdRef.current = null;
          setCollabHostName(null);
        }
      }
    });
    return () => { unsub?.(); };
  }, []);

  // Auto-stop when the last participant leaves while the modal is closed.
  // Only meaningful for the host — collaborators can't stop the server.
  useEffect(() => {
    if (!collabOpen && collabHostActive && collabParticipantCount === 0) {
      window.ironmic?.meetingCollabStop?.().catch(() => {});
    }
  }, [collabOpen, collabHostActive, collabParticipantCount]);

  // Broadcast title/emoji changes to peers even when no body text has
  // changed. The body autosave path (saveContent) already carries meta on
  // each save, but title/emoji edits via the header don't go through
  // onUpdate, so without this effect peers would only see the new title
  // after the next typing-triggered save. Use a draft (cheap, no DB hit on
  // peers) so it lands instantly. Skip on first render (when editor is null
  // or the binding doesn't include the current entry).
  useEffect(() => {
    if (!editor) return;
    if (!(collabHostActiveRef.current || collabJoinedRef.current)) return;
    if (!collabBoundEntryIdRef.current) return;
    if (collabBoundEntryIdRef.current !== entryId) return;
    const meta: CollabWireMeta = {
      title: storeTitle ?? undefined,
      emoji: noteEmoji ?? undefined,
    };
    const wire = packCollabPayload(editor.getJSON(), meta);
    const name = (() => {
      try { return localStorage.getItem('ironmic-collab-display-name') || (collabHostActiveRef.current ? 'Host' : 'Viewer'); }
      catch { return collabHostActiveRef.current ? 'Host' : 'Viewer'; }
    })();
    if (collabHostActiveRef.current) {
      window.ironmic?.meetingCollabNotifyDraft?.(wire, name)?.catch(() => {});
    } else if (collabJoinedRef.current) {
      window.ironmic?.meetingCollabSendDraft?.(wire)?.catch(() => {});
    }
  }, [storeTitle, noteEmoji, entryId, editor, collabHostActive, collabJoined]);

  /** Apply a wire payload (wrapped JSON, bare TipTap JSON, or plaintext) to
   *  the live editor. Returns plaintext + JSON + meta so the caller can
   *  persist. The isApplyingRemoteContentRef bracket suppresses onUpdate's
   *  autosave so the remote content doesn't immediately echo back. */
  const applyRemoteToEditor = useCallback((serialized: string): { plainText: string; json: string; meta?: CollabWireMeta } | null => {
    if (!editor) return null;
    const wrapped = parseCollabWirePayload(serialized);
    isApplyingRemoteContentRef.current = true;
    try {
      if (wrapped) {
        editor.commands.setContent(wrapped.doc, false);
      } else {
        editor.commands.setContent(plainTextWireToTiptapHtml(String(serialized)), false);
      }
    } finally {
      isApplyingRemoteContentRef.current = false;
    }
    // setContent(_, false) suppresses onUpdate, so update counts manually.
    const text = editor.getText();
    setCharCount(text.length);
    setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
    return {
      plainText: text.trim(),
      json: JSON.stringify(editor.getJSON()),
      meta: wrapped?.meta,
    };
  }, [editor]);

  /** Apply incoming title/emoji to the bound entry. When the bound entry is
   *  the one currently loaded in the editor, mirror the change into the
   *  dictation store + emoji state so the header re-renders immediately;
   *  otherwise just persist (DB + entry-store cache) so the sidebar shows
   *  the updated title/emoji without nuking what's on screen. */
  const applyRemoteMeta = useCallback(async (targetEntryId: string, meta: CollabWireMeta | undefined) => {
    if (!meta) return;
    const wantedTitle = typeof meta.title === 'string' ? meta.title.trim() : null;
    const wantedEmoji = typeof meta.emoji === 'string' ? meta.emoji : null;
    if (!wantedTitle && !wantedEmoji) return;

    // Reflect into the visible header if this is the on-screen entry.
    if (useDictationStore.getState().entryId === targetEntryId) {
      if (wantedTitle && useDictationStore.getState().title !== wantedTitle) {
        useDictationStore.setState({ title: wantedTitle });
      }
      if (wantedEmoji && wantedEmoji !== noteEmoji) {
        setNoteEmoji(wantedEmoji);
      }
    }

    // Persist into the entry's tags. Read fresh tags so we don't clobber
    // unrelated tags (notebook, status, meeting session id, etc.).
    try {
      const fresh = await window.ironmic.getEntry(targetEntryId);
      if (!fresh) return;
      let tagArr: string[] = [];
      try {
        const parsed = JSON.parse((fresh as any).tags || '[]');
        if (Array.isArray(parsed)) tagArr = parsed.filter((s: any) => typeof s === 'string');
      } catch { /* ignore */ }
      const existingTitle = parseTitleTag((fresh as any).tags) || '';
      const existingEmoji = parseEmojiTag((fresh as any).tags) || '';
      const titleChanged = wantedTitle && wantedTitle !== existingTitle;
      const emojiChanged = wantedEmoji && wantedEmoji !== existingEmoji;
      if (!titleChanged && !emojiChanged) return;
      if (titleChanged) {
        tagArr = tagArr.filter((s) => !s.startsWith(TITLE_TAG_PREFIX));
        tagArr.push(`${TITLE_TAG_PREFIX}${wantedTitle}`);
      }
      if (emojiChanged) {
        tagArr = tagArr.filter((s) => !s.startsWith(EMOJI_TAG_PREFIX));
        tagArr.push(`${EMOJI_TAG_PREFIX}${wantedEmoji}`);
      }
      const updated = await window.ironmic.updateEntry(targetEntryId, { tags: JSON.stringify(tagArr) } as any);
      if (updated) {
        useEntryStore.setState((s) => {
          const idx = s.entries.findIndex((e) => e.id === targetEntryId);
          const nextEntries = idx === -1 ? s.entries : (() => {
            const out = s.entries.slice();
            out[idx] = updated;
            return out;
          })();
          const nextCache = new Map(s.entryCache);
          nextCache.set(targetEntryId, updated);
          return { entries: nextEntries, entryCache: nextCache };
        });
      }
      try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
    } catch (err) {
      console.warn('[DictatePage] failed to apply remote title/emoji:', err);
    }
  }, [noteEmoji]);

  /** Persist a received `saved` payload to the bound entry's DB row, mirror
   *  it into the entry-store cache, and refresh the sidebar. Routed by
   *  collabBoundEntryIdRef.current so navigating to an unrelated note in
   *  the sidebar mid-session can't misroute remote saves. */
  const persistRemoteSaved = useCallback(async (targetEntryId: string, applied: { plainText: string; json: string }) => {
    const api = window.ironmic;
    try {
      const storeEntry = useEntryStore.getState();
      const live = storeEntry.entries.find((e) => e.id === targetEntryId)
        ?? storeEntry.entryCache.get(targetEntryId)
        ?? null;
      const writingPolished = !!live?.polishedText && live?.displayMode === 'polished';
      const updates = writingPolished
        ? { polishedText: applied.plainText, polishedTextJson: applied.json }
        : { rawTranscript: applied.plainText || ' ', rawTranscriptJson: applied.json };
      const updated = await api.updateEntry(targetEntryId, updates as any);
      if (updated) {
        useEntryStore.setState((s) => {
          const idx = s.entries.findIndex((e) => e.id === targetEntryId);
          const nextEntries = idx === -1 ? s.entries : (() => {
            const out = s.entries.slice();
            out[idx] = updated;
            return out;
          })();
          const nextCache = new Map(s.entryCache);
          nextCache.set(targetEntryId, updated);
          return { entries: nextEntries, entryCache: nextCache };
        });
      }
      // Only touch local rev tracking + draft when the bound entry is on
      // screen — otherwise we'd corrupt the rev for the unrelated entry the
      // user is currently editing.
      if (useDictationStore.getState().entryId === targetEntryId) {
        lastSyncedLocalRevRef.current = localEditsRevRef.current;
        setSaved(true);
        saveDraft(editor?.getHTML() ?? '', targetEntryId, useDictationStore.getState().title);
      }
      try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
    } catch (err) {
      console.warn('[DictatePage] failed to persist remote saved content:', err);
    }
  }, [editor]);

  // Apply incoming live drafts. Visual-only — no DB persistence (drafts are
  // ephemeral). Echo-guarded by peerId, not display name (RC6). Title/emoji
  // meta IS applied (visual + DB) so the header re-renders even on a draft.
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabDraft?.((data: any) => {
      if (!editor || data?.content == null) return;
      if (collabHostActiveRef.current && data.peerId === 'host') return;
      if (data.peerId && data.peerId === collabSelfIdRef.current) return;
      const boundId = collabBoundEntryIdRef.current;
      if (!boundId) return;
      const currentId = useDictationStore.getState().entryId;
      let applied: { plainText: string; json: string; meta?: CollabWireMeta } | null = null;
      if (boundId === currentId) {
        applied = applyRemoteToEditor(String(data.content));
      } else {
        // Off-screen bound entry — still extract meta so title/emoji can sync
        // in the sidebar even when the user is looking at a different note.
        applied = deriveTextAndJsonFromWire(String(data.content));
      }
      if (applied?.meta) void applyRemoteMeta(boundId, applied.meta);
    });
    return () => { unsub?.(); };
  }, [editor, applyRemoteToEditor, applyRemoteMeta]);

  // Apply incoming committed saves. Always persists to the bound entry's DB
  // row; only updates the editor when the bound entry is on screen. Title/
  // emoji meta is also persisted so peers see consistent header info.
  useEffect(() => {
    const unsub = window.ironmic?.onMeetingCollabNotesUpdated?.((data: any) => {
      if (!editor || !data?.notes) return;
      if (collabHostActiveRef.current && data.peerId === 'host') return;
      if (data.peerId && data.peerId === collabSelfIdRef.current) return;
      const boundId = collabBoundEntryIdRef.current;
      if (!boundId) return; // session torn down — ignore stale event
      const currentId = useDictationStore.getState().entryId;
      let payload: { plainText: string; json: string; meta?: CollabWireMeta } | null = null;
      if (boundId === currentId) {
        payload = applyRemoteToEditor(String(data.notes));
      } else {
        payload = deriveTextAndJsonFromWire(String(data.notes));
      }
      if (payload) {
        void persistRemoteSaved(boundId, payload);
        if (payload.meta) void applyRemoteMeta(boundId, payload.meta);
      }
    });
    return () => { unsub?.(); };
  }, [editor, applyRemoteToEditor, persistRemoteSaved, applyRemoteMeta]);

  const handleReadBack = useCallback(() => {
    if (!editor) return;
    if (ttsState === 'playing' || ttsState === 'paused') {
      ttsStop();
      return;
    }
    const text = editor.getText().trim();
    if (text) synthesizeAndPlay(text, entryId ?? undefined);
  }, [editor, ttsState, synthesizeAndPlay, ttsStop, entryId]);

  // Push the currently-spoken word index into the editor's TTS highlight
  // extension. The extension translates the index into an inline ProseMirror
  // decoration so the active word is highlighted in place — no separate
  // caption UI needed. Clears (-1) when this entry isn't the read-back target
  // or playback isn't running.
  useEffect(() => {
    if (!editor) return;
    const isThisEntry = !!entryId && ttsActiveEntryId === entryId;
    const isActive = isThisEntry && (ttsState === 'playing' || ttsState === 'paused');

    if (!isActive || ttsTimestamps.length === 0) {
      editor.commands.setTtsActiveWord(-1);
      return;
    }

    let activeIdx = -1;
    for (let i = 0; i < ttsTimestamps.length; i += 1) {
      const t = ttsTimestamps[i];
      if (ttsCurrentTimeMs >= t.start_ms && ttsCurrentTimeMs < t.end_ms) {
        activeIdx = i;
        break;
      }
      if (ttsCurrentTimeMs < t.start_ms) {
        activeIdx = i - 1;
        break;
      }
    }
    if (activeIdx === -1 && ttsCurrentTimeMs >= ttsTimestamps[ttsTimestamps.length - 1].end_ms) {
      activeIdx = ttsTimestamps.length - 1;
    }

    editor.commands.setTtsActiveWord(activeIdx);
  }, [editor, entryId, ttsActiveEntryId, ttsState, ttsTimestamps, ttsCurrentTimeMs]);

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
      const html = editor.getHTML();
      const plainText = editor.getText().trim();
      const json = JSON.stringify(editor.getJSON());
      localEditsRevRef.current += 1;
      const committedRev = localEditsRevRef.current;
      await saveContent({ plainText, json, html, committedRev });
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

  /** Apply the active-side rich content to the editor. Prefers TipTap JSON
   *  (round-trips formatting losslessly); falls back to plaintext-wrapped HTML
   *  for legacy notes (created before v6) or when JSON is malformed. The
   *  caller is responsible for guarding with isApplyingRemoteContentRef so
   *  onUpdate doesn't immediately persist the just-applied content back. */
  const applyEntryToEditor = useCallback((entry: Entry, mode: 'raw' | 'polished') => {
    if (!editor) return;
    const json = mode === 'polished' ? entry.polishedTextJson : entry.rawTranscriptJson;
    const plain = mode === 'polished' ? (entry.polishedText || '') : entry.rawTranscript;
    if (json) {
      try {
        const parsed = JSON.parse(json);
        editor.commands.setContent(parsed, false);
        return;
      } catch (err) {
        console.warn('[DictatePage] malformed editor JSON, falling back to plaintext', err);
      }
    }
    editor.commands.setContent(textToHtml(plain || ''), false);
  }, [editor, textToHtml]);

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

  // Reactive editor sync: applies the persisted entry to the editor when the
  // change comes from OUTSIDE the local editor — background polish completion,
  // sidebar selection from another component, mode toggle, collab updates.
  // The two early-returns below distinguish "this store update is the echo of
  // my own debounced save" (skip — editor already has the right content) from
  // "this is genuinely external" (apply).
  useEffect(() => {
    if (!editor || !entryId) return;
    if (isPolishing) return; // overlay covers content; don't fight the user.
    if (!polishedEntry) return;

    const incomingJson = effectiveMode === 'polished'
      ? polishedEntry.polishedTextJson
      : polishedEntry.rawTranscriptJson;

    // De-dupe identical re-renders: same entry, same mode, same persisted
    // updatedAt → nothing to do.
    const key = `${entryId}|${effectiveMode}|${polishedEntry.updatedAt}|${incomingJson ? 'j' : 'p'}`;
    if (lastAppliedSyncKeyRef.current === key) return;

    // Echo guard: when this update is just our own save round-tripping back
    // through the store, the editor already holds the canonical content.
    // Detect via (a) we have no pending local edits past the last synced rev,
    // and (b) the incoming JSON matches what's in the editor right now.
    if (
      lastSyncedLocalRevRef.current === localEditsRevRef.current &&
      incomingJson &&
      incomingJson === JSON.stringify(editor.getJSON())
    ) {
      lastAppliedSyncKeyRef.current = key;
      return;
    }

    // Apply. The helper handles JSON-vs-plaintext fallback and malformed JSON.
    isApplyingRemoteContentRef.current = true;
    try {
      applyEntryToEditor(polishedEntry, effectiveMode);
      lastAppliedSyncKeyRef.current = key;
    } finally {
      isApplyingRemoteContentRef.current = false;
    }
  }, [editor, entryId, effectiveMode, polishedEntry, isPolishing, applyEntryToEditor]);

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
    {
      const html = editor.getHTML();
      const plainText = editor.getText().trim();
      const json = JSON.stringify(editor.getJSON());
      localEditsRevRef.current += 1;
      const committedRev = localEditsRevRef.current;
      await saveContent({ plainText, json, html, committedRev });
    }

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

  // ── Cmd/Ctrl+S — manual save (finalize) ──
  // Routes through handleSave so the entry's __status__ tag flips to 'done',
  // the Draft pill becomes Saved, the sidebar refetches, and the bottom
  // status bar reflects the persisted state — same path as the toolbar Save
  // button. Captured at the window level so it works regardless of focus
  // (title input, toolbar, etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';
      if (!isSave) return;
      e.preventDefault();
      if (!editor) return;
      const text = editor.getText().trim();
      if (!text) {
        toast({ type: 'info', message: 'Nothing to save yet.', durationMs: 2000 });
        return;
      }
      void handleSave().then(() => {
        toast({ type: 'success', message: 'Note saved.', durationMs: 1500 });
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, handleSave, toast]);

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

  /** Auto-persist the default emoji as soon as we have an entry to attach
   *  it to. Without this, a freshly-created note shows the randomly-picked
   *  emoji in the editor but the underlying entry's `tags` never gets the
   *  `__emoji__:` row — so the sidebar (which reads from tags) renders no
   *  emoji until the user manually changes it. We only write when the
   *  entry has NO existing emoji tag, so this never clobbers a user-set
   *  emoji or one carried in from a collab peer. */
  useEffect(() => {
    if (!entryId || !noteEmoji) return;
    void (async () => {
      try {
        const fresh = await window.ironmic.getEntry(entryId);
        if (!fresh) return;
        const existing = parseEmojiTag((fresh as any).tags);
        if (existing && existing.length > 0) return; // already has one — don't overwrite
        const parsed: string[] = JSON.parse((fresh as any).tags || '[]');
        // Defensive: filter any prior empty/malformed emoji tag.
        const filtered = parsed.filter((s: string) => !s.startsWith(EMOJI_TAG_PREFIX));
        filtered.push(`${EMOJI_TAG_PREFIX}${noteEmoji}`);
        await window.ironmic.updateEntry(entryId, { tags: JSON.stringify(filtered) } as any);
        try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
      } catch { /* best effort — sidebar will just keep showing no emoji */ }
    })();
  }, [entryId, noteEmoji]);

  /** Swap the editor + store onto a specific entry, running all the
   *  bookkeeping (counts, status, emoji, draft, store mirror, edit-rev
   *  reset). Used by both the sidebar click path AND the join-collab path
   *  so they can't drift. The optional `titleOverride` lets the join path
   *  pin a "Shared with X" title regardless of what's on the entry tags. */
  const loadEntryIntoEditor = useCallback((entry: Entry, opts?: { mode?: 'raw' | 'polished'; titleOverride?: string }) => {
    if (!editor) return;
    // Flush any pending debounce for the currently-open note before we swap.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const sideMode: 'raw' | 'polished' = opts?.mode
      ?? (entry.polishedText && entry.displayMode === 'polished' ? 'polished' : 'raw');
    isApplyingRemoteContentRef.current = true;
    try {
      applyEntryToEditor(entry, sideMode);
    } finally {
      isApplyingRemoteContentRef.current = false;
    }
    const text = editor.getText();
    setCharCount(text.length);
    setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
    setSaved(true);
    // Reset edit-revision tracking so the sync effect treats the loaded
    // content as the canonical baseline.
    localEditsRevRef.current = 0;
    lastSyncedLocalRevRef.current = 0;

    const nextTitle = opts?.titleOverride ?? (parseTitleTag(entry.tags) || 'Untitled note');
    const nextNotebook = parseNotebookTag(entry.tags) || getDefaultNotebookId();
    useDictationStore.setState({
      entryId: entry.id,
      title: nextTitle,
      notebookId: nextNotebook,
      fullText: (entry.rawTranscript || '').trim(),
      // Don't touch chunkSeq — appending future chunks is still keyed off it.
      lastChunkText: '',
    });
    setLoadedEntryStatus(parseStatusTag(entry.tags));
    setNoteEmoji(parseEmojiTag(entry.tags) || pickRandomEmoji());
    saveDraft(editor.getHTML(), entry.id, nextTitle);
  }, [editor, applyEntryToEditor]);

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
    loadEntryIntoEditor(entry);
  }, [editor, status, toast, loadEntryIntoEditor]);

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
        liveCollabEntryId={collabBoundEntryId}
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
                title={
                  collabHostActive
                    ? `Hosting — ${collabParticipantCount} participant${collabParticipantCount !== 1 ? 's' : ''} connected`
                    : collabJoined
                    ? `Joined ${collabHostName ?? 'host'}'s session — open the modal to leave`
                    : 'Collaborate on this note with teammates'
                }
              >
                {collabActive
                  ? <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  : <Users className="w-3.5 h-3.5" />}
                {!windowNarrow && (
                  collabHostActive
                    ? `Live${collabParticipantCount > 0 ? ` · ${collabParticipantCount}` : ''}`
                    : collabJoined
                    ? `Joined · ${collabHostName ?? 'host'}`
                    : 'Collaborate'
                )}
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

      {/* Joined-session banner — only shows on a participant. Host gets the
          live count via the Collaborate button. */}
      {collabJoined && !collabHostActive && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-iron-border bg-green-500/10 text-[11px] text-green-300">
          <span className="flex items-center gap-1.5">
            <Users className="w-3 h-3" />
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Editing live with <strong className="font-medium">{collabHostName ?? 'host'}</strong>
          </span>
          <button
            onClick={() => window.ironmic?.meetingCollabLeave?.().catch(() => {})}
            className="px-2 py-0.5 rounded bg-green-500/20 hover:bg-green-500/30 text-green-200 text-[10px]"
            title="Disconnect from this shared note (your local copy stays)"
          >
            Leave
          </button>
        </div>
      )}

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

      {/* Editor — outer wrapper is `relative` and non-scrolling so the polish
          overlay's `absolute inset-0` covers the full viewport regardless of
          how tall the editor's content is. Previously the overlay was inside
          the scroll container; `inset-0` then resolved to the scroll content
          area, which left the lower portion of the editor uncovered. */}
      <div className="flex-1 relative overflow-hidden">
        <div className={`absolute inset-0 overflow-y-auto${status === 'recording' && draftHypothesis ? ' has-draft-hypothesis' : ''}`}>
          <EditorContent editor={editor} />
        </div>
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
          // Seed the host's session with the wrapped wire payload (doc + meta)
          // so late joiners get formatting AND the host's title/emoji via the
          // welcome message. The server stores this string verbatim and
          // forwards it on every join, and our parser unwraps it transparently.
          initialNotes={editor
            ? packCollabPayload(editor.getJSON(), {
                title: useDictationStore.getState().title ?? undefined,
                emoji: noteEmoji ?? undefined,
              })
            : ''}
          onJoined={async ({ sessionId, hostName, notes }) => {
            // 1. Derive plaintext + canonical JSON + meta from the seeded
            //    notes WITHOUT touching the live editor — if createEntry
            //    fails, the user's currently-open note must stay untouched.
            const derived = deriveTextAndJsonFromWire(String(notes ?? ''));

            // 2. Create a brand-new entry already populated with the seeded
            //    content. Never overwrite the collaborator's existing note.
            //    Adopt the host's title/emoji when available so the new
            //    entry mirrors what the host is showing.
            const seedTitle = derived.meta?.title?.trim() || `Shared with ${hostName}`;
            const seedEmoji = derived.meta?.emoji || noteEmoji;
            const tagsArr = [
              `${TITLE_TAG_PREFIX}${seedTitle}`,
              `__notebook__:${notebookId}`,
              `__status__:draft`,
              `${EMOJI_TAG_PREFIX}${seedEmoji}`,
              `__collab_session__:${sessionId}`,
            ];
            let created: any;
            try {
              created = await window.ironmic.createEntry({
                rawTranscript: derived.plainText || ' ',
                rawTranscriptJson: derived.json,
                tags: JSON.stringify(tagsArr),
              } as any);
            } catch (err) {
              console.warn('[DictatePage] could not create joined-collab entry:', err);
              toast({
                type: 'error',
                message: "Couldn't start a shared note locally. Your current note is unchanged.",
                durationMs: 4000,
              });
              return;
            }
            const newId = (created as any).id as string;

            // 3. Bind the session to this entry. F2/F3 route persistence
            //    here so sidebar navigation can't misroute remote saves.
            collabBoundEntryIdRef.current = newId;
            setCollabBoundEntryId(newId);

            // 4. Load the freshly-created entry through the canonical helper
            //    so all bookkeeping (counts, status, emoji, store, draft) runs.
            try {
              const fresh = await window.ironmic.getEntry(newId);
              if (fresh) loadEntryIntoEditor(fresh, { titleOverride: seedTitle });
            } catch (err) {
              console.warn('[DictatePage] could not reload joined-collab entry:', err);
            }
            bumpSidebar();
            try { window.dispatchEvent(new CustomEvent('ironmic:entries-changed')); } catch { /* noop */ }
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
