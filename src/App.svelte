<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';
  import Notebook from './lib/components/Notebook.svelte';
  import RightSidebar from './lib/components/RightSidebar.svelte';
  import CommandPalette from './lib/components/CommandPalette.svelte';
  import TabStrip from './lib/components/TabStrip.svelte';
  import FileMenu from './lib/components/FileMenu.svelte';
  import PanelRail from './lib/components/PanelRail.svelte';
  import RunMenu from './lib/components/RunMenu.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import ExportDialog from './lib/components/ExportDialog.svelte';
  import {
    currentNotebook,
    notebookFiles,
    createNewNotebook,
    markNotebookClean,
    notebookDirty,
    staleCells,
    reactiveMode,
    runProgress,
    addCellAfter,
    createNewCell,
    selectedCellId,
    undoDeleteCell,
    resetExecutionCounter,
    recomputeStaleCells,
    updateCellContent,
    outputPosition,
    kernelMode,
    notebookWidth,
    currentOrigin
  } from './lib/stores/notebook';
  import { extractCodeFromMessage } from './lib/utils/cellEdit';
  import { startOfflineCache } from './lib/utils/offlineCache';
  import { freezeEnvironment, loadEnvironment, unfreezeEnvironment } from './lib/stores/environment';
  import { pinNotebookImports } from './lib/stores/pinImports';
  import {
    BACKUP_SNOOZE_KEY,
    LAST_BACKUP_KEY,
    backupState,
    createLibraryBackup,
    markBackedUp,
    restoreLibraryBackup,
  } from './lib/stores/backup';
  import { looksLikeObservableNotebook, summarizeLosses, type Loss } from './lib/utils/observableFormat';
  import { frontmatterId, pathNotebookId } from '../cli/notebookPaths';
  import { kernel, kernelBusy, kernelFor } from './lib/utils/kernelClient';
  import { executorFor } from './lib/utils/mainExecutor';
  import {
    activeSessionId,
    closeSession,
    current as currentSession,
    openSession,
    rekeySession,
    resetRunState,
    sessionById,
    sessions,
    setActive,
    startPersistingSessions,
  } from './lib/stores/sessions';
  import { theme, toggleTheme } from './lib/utils/theme';
  import { isDesktopApp, openFolder } from './lib/utils/desktop';
  import { handleGlobalKeydown } from './lib/utils/keyboardShortcuts';
  import {
    saveNotebook,
    exportNotebookSource,
    parseJSNotebook,
    parseNotebookFile,
    serializeForPath,
    slugify,
    downloadBytes,
    importNotebookFromFile,
  } from './lib/utils/fileOperations';
  import {
    deleteNotebook,
    getNotebookRecord,
    lastOpenSessions,
    libraryEntries,
    libraryPersistent,
    migrateLegacyAutosave,
    putNotebook,
    refreshLibrary,
    type LibraryEntry,
    type NotebookOrigin,
  } from './lib/utils/notebookLibrary';
  import { parseImportRequest, decodeRedirect, fetchNotebookFromUrl, notebooksEquivalent, type ImportRequest } from './lib/utils/urlImport';
  import {
    connectSync,
    isSyncConnected,
    openSyncFile,
    saveThroughSync,
    syncFiles,
    syncRoot,
    syncStatus,
    type LoadReason,
  } from './lib/utils/serverSync';
  import type { Notebook as NotebookDoc } from './lib/types/notebook';
  import type { PanelTab } from './lib/types/panel';

  /**
   * Whether the side panel starts open.
   *
   * On a wide screen it does: there is room for the notebook column and the
   * panel side by side, and the panel is where the notebook's variables, console
   * and storage live — people who work that way opened it every single time.
   * Closing it is a choice, and a choice is remembered, so it stays closed for
   * someone who prefers it that way. Below a working width it always starts
   * closed, whatever was stored, because a panel opened by memory on a narrow
   * window takes the room the notebook needs.
   */
  const PANEL_OPEN_KEY = 'tangent-panel-open';
  /** The notebook column (820) plus the default panel (348) plus breathing room. */
  const WIDE_ENOUGH = 1280;
  /** Below this, a remembered "open" would squeeze the notebook too far. */
  const TOO_NARROW = 900;

  function initialPanelOpen(): boolean {
    if (typeof window === 'undefined') return false;
    const width = window.innerWidth;
    if (width < TOO_NARROW) return false;
    try {
      const stored = localStorage.getItem(PANEL_OPEN_KEY);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      // Storage unavailable: fall through to the width default.
    }
    return width >= WIDE_ENOUGH;
  }

  let rightSidebarOpen = $state(initialPanelOpen());

  /** Open or close the panel because the user asked to, and remember it. */
  function setPanelOpen(open: boolean) {
    rightSidebarOpen = open;
    try {
      localStorage.setItem(PANEL_OPEN_KEY, String(open));
    } catch {
      // Not remembered, but still done.
    }
  }
  // Files, not Info: what is here before what it is made of. Info is read once,
  // and the panel's first job is to answer "where is the rest of my folder".
  let rightSidebarTab = $state<PanelTab>('storage');

  /**
   * Resolves once the notebook library has migrated the legacy autosave slot
   * and listed itself. Everything that opens or restores a notebook awaits it,
   * so nothing races the migration. It never rejects.
   */
  let libraryReady: Promise<void> = Promise.resolve();


  /**
   * Open the panel on `tab`, or close it if it is already showing that tab.
   * Every panel entry point (header buttons, shortcuts, command palette) goes
   * through here, so there is one panel with one open/close behaviour.
   */
  function togglePanelTab(tab: PanelTab) {
    if (rightSidebarOpen && rightSidebarTab === tab) {
      setPanelOpen(false);
      return;
    }
    rightSidebarTab = tab;
    setPanelOpen(true);
    // Chat is prose and needs more room than the tool tabs. Widen once if the
    // panel is too narrow to read in, never shrink what the user chose.
    if (tab === 'chat' && rightSidebarWidth < CHAT_MIN_WIDTH) {
      rightSidebarWidth = CHAT_MIN_WIDTH;
      localStorage.setItem(PANEL_WIDTH_KEY, String(rightSidebarWidth));
    }
  }

  // Right panel width: user-resizable by dragging its left edge, persisted.
  const PANEL_WIDTH_KEY = 'tangent-panel-width';
  const PANEL_MIN = 240;
  const PANEL_MAX = 720;
  const CHAT_MIN_WIDTH = 380;
  const clampPanel = (w: number) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
  // The default has to fit the whole tab row without scrolling. 300 was too
  // narrow for five tabs (302px at a 16px root), 320 was too narrow once the
  // rule between the notebook-level tabs and the app-level ones was added, and
  // 348 clears both with a little room.
  const PANEL_DEFAULT = 348;
  /** Defaults this app has shipped, so a stored one can be told from a choice. */
  const PREVIOUS_DEFAULTS = new Set([300, 320]);

  function initialPanelWidth(): number {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (!stored) return PANEL_DEFAULT;
    // A width equal to an older default was never chosen — it was simply
    // stored the first time the panel opened. Honouring it would leave every
    // existing reader with the truncated row that prompted the change, while
    // a width they actually dragged to is left exactly where they put it.
    if (PREVIOUS_DEFAULTS.has(stored)) return PANEL_DEFAULT;
    return clampPanel(stored);
  }

  let rightSidebarWidth = $state(initialPanelWidth());

  function startPanelResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightSidebarWidth;
    const onMove = (e: PointerEvent) => {
      // Dragging left widens the panel (it is docked to the right edge).
      rightSidebarWidth = clampPanel(startWidth + (startX - e.clientX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      localStorage.setItem(PANEL_WIDTH_KEY, String(rightSidebarWidth));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  let showExportDialog = $state(false);
  let showCommandPalette = $state(false);
  let showShortcuts = $state(false);

  // Transient status message (e.g. a failed save), shown as a dismissible toast
  // instead of a blocking window.alert.
  let toast: { message: string; tone: 'error' | 'info' } | null = $state(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(message: string, tone: 'error' | 'info' = 'info') {
    toast = { message, tone };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, 5000);
  }

  const SHORTCUTS: { keys: string; action: string }[] = [
    { keys: '⌘/Ctrl + K', action: 'Command palette' },
    { keys: '⌘/Ctrl + /', action: 'Toggle AI chat' },
    { keys: '⌘/Ctrl + S', action: 'Save notebook' },
    { keys: '⌘/Ctrl + Shift + S', action: 'Save notebook as…' },
    { keys: '⌘/Ctrl + F', action: 'Find in notebook' },
    { keys: 'Ctrl + H  ·  ⌘ + ⌥ + F', action: 'Replace in notebook' },
    { keys: '⌘/Ctrl + N', action: 'New notebook' },
    { keys: '⌘/Ctrl + O', action: 'Open notebook' },
    { keys: '⌘/Ctrl + Enter', action: 'Run cell' },
    { keys: 'Shift + Enter', action: 'Run cell, select next' },
    { keys: 'Alt + Enter', action: 'Run cell, insert below' },
    { keys: '⌘/Ctrl + `', action: 'Toggle console' },
    { keys: '⌘/Ctrl + Shift + D', action: 'Toggle data panel' },
    { keys: '⌘/Ctrl + Z', action: 'Undo cell delete' },
  ];

  // The frozen environment belongs to the folder, so it follows the notebook on
  // screen: opening a frozen folder freezes the cache, leaving it thaws.
  $effect(() => {
    $currentOrigin;
    $syncStatus;
    void loadEnvironment();
  });

  // Mirror the notebook name into the browser tab so multiple notebooks are
  // tellable apart; falls back to the app name.
  $effect(() => {
    const name = $currentNotebook?.name?.trim();
    document.title = name ? `${name} · tangent/note` : 'tangent/note';
  });

  export function runAllCells() {
    window.dispatchEvent(new CustomEvent('run-all-cells'));
  }

  onMount(() => {
    // Keep the libraries cells load, so a notebook still runs with no network.
    startOfflineCache();
    // Deep links (/gh/… on GitHub Pages) arrive via the 404.html shim as
    // /?p=<original path>; restore the real URL before routing.
    const redirect = decodeRedirect(window.location.search);
    if (redirect) {
      history.replaceState(null, '', redirect.pathname + redirect.search);
    }
    const target = redirect ?? { pathname: window.location.pathname, search: window.location.search };
    const importRequest = parseImportRequest(target.pathname, target.search);

    // Everything that opens a notebook needs the library first: the legacy
    // single-slot autosave is folded into it, and what to restore is looked up
    // in it. Failures are non-fatal — the library degrades to memory and says
    // so — so this promise never rejects.
    libraryReady = migrateLegacyAutosave()
      .then(() => refreshLibrary())
      .catch((error) => {
        console.warn('Notebook library unavailable:', error);
      });

    // A `note serve` companion owns files on disk, and they win over the
    // library copy: they are what git tracks. When none answers, nothing
    // changes and the app stays in download mode.
    connectSync({
      onLoad: (path, content, reason) => applySyncedContent(path, content, reason),
      onConflict: (path) => handleSyncConflict(path),
      onSaved: (path) => {
        if (finishSaveAs(path)) return;
        sessionForPath(path)?.dirty.set(false);
        showToast(`Saved ${path}`, 'info');
      },
      onRefused: (path, message) => {
        if (saveAs && pendingSaveAs && path === pendingSaveAs.path) {
          saveAs = { ...saveAs, error: message };
          pendingSaveAs = null;
          return;
        }
        showToast(path ? `${path}: ${message}` : message, 'error');
      },
      onExists: (path) => {
        if (!saveAs || !pendingSaveAs || path !== pendingSaveAs.path) return;
        pendingSaveAs = null;
        saveAs = { ...saveAs, exists: true, error: null };
      },
    }).then(async (hello) => {
      await libraryReady;

      if (hello) {
        // A single-file invocation names the notebook to open. A directory
        // names none, so the tabs from last time come back and any of them
        // backed by a file on disk is refreshed from it.
        if (hello.initial) {
          openSyncFile(hello.initial);
        } else {
          // Never fall back to the bundled example here: the companion is
          // serving real, git-tracked notebooks, and loading the example would
          // put a second copy of a file it already serves into the library —
          // the same notebook listed twice, once as "example" and once as a
          // file. Its first file is the better greeting.
          await restoreSessions({ fallback: hello.files.length > 0 ? 'none' : 'sample' });
          if (get(sessions).length === 0 && hello.files.length > 0) {
            openSyncFile(hello.files[0].path);
          }
        }
        for (const session of get(sessions)) {
          const origin = get(session.origin);
          if (origin.kind === 'disk') openSyncFile(origin.path);
        }
      } else if (importRequest) {
        await loadNotebookFromUrl(importRequest);
      } else {
        await restoreSessions();
      }

      // Only now may the session index be written: until this point it is
      // still the record of what to restore.
      startPersistingSessions();
    });

    loadNotebookFiles();

    // Warn before closing the tab only when something is genuinely at risk.
    // Edits reach the library on their own, so a "modified" notebook is not
    // unsaved work — it just differs from the file on disk. The exception is a
    // session whose library had to fall back to memory: there, closing really
    // does lose it.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      // Across every open tab, not just the one on screen.
      const anyUnwritten =
        isSyncConnected() && get(sessions).some((session) => get(session.dirty));
      const atRisk = !get(libraryPersistent) || anyUnwritten;
      if (atRisk) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);

    const onImportRequest = () => handleImportNotebook();
    window.addEventListener('request-import-notebook', onImportRequest);
    const onNewRequest = () => handleNewNotebook();
    window.addEventListener('request-new-notebook', onNewRequest);

    // Any component can surface a toast instead of a blocking alert().
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (detail.message) showToast(detail.message, detail.tone === 'error' ? 'error' : 'info');
    };
    window.addEventListener('tangent-toast', onToast);

    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('request-import-notebook', onImportRequest);
      window.removeEventListener('request-new-notebook', onNewRequest);
      window.removeEventListener('tangent-toast', onToast);
      clearTimeout(toastTimer);
    };
  });

  /**
   * Adopt `notebook` as a tab, or focus the tab already holding it.
   *
   * Every path that opens a notebook — boot, restore, companion, URL link,
   * file import, new, the palette — goes through here, so "opened" means one
   * thing: a session exists for it, it is on screen, and the library has it
   * under its origin's key.
   *
   * There is no kernel to clear on the way in any more. Each notebook owns its
   * own worker and its own scope, so what used to be a mandatory reset — and,
   * before that, a silent leak of one notebook's variables into the next — is
   * simply not a question that arises.
   */
  async function openNotebook(
    notebook: NotebookDoc,
    origin: NotebookOrigin,
    opts: { replaceContent?: boolean; focus?: boolean } = {}
  ) {
    const session = openSession(notebook, origin, { replaceContent: opts.replaceContent });
    if (opts.focus === false) setActive(get(activeSessionId));
    await libraryReady;
    await putNotebook(get(session.notebook), get(session.origin), { opened: true });
  }

  /**
   * Reopen the tabs this browser had, in order. Falls back to the newest entry
   * in the library, then to the sample: an empty screen is never the answer to
   * "the pointer named something that has since been deleted".
   */
  async function restoreSessions(opts: { fallback?: 'sample' | 'none' } = {}) {
    await libraryReady;
    const { open, active } = lastOpenSessions();

    let restored = 0;
    for (const id of open) {
      const record = await getNotebookRecord(id);
      if (!record) continue;
      await openNotebook(record.notebook, record.origin);
      restored++;
    }

    if (restored > 0) {
      if (active && sessionById(active)) setActive(active);
      console.info(`Restored ${restored} notebook${restored === 1 ? '' : 's'} from the library`);
      return;
    }

    if (opts.fallback === 'none') return;

    const [newest] = get(libraryEntries);
    const fallback = newest ? await getNotebookRecord(newest.id) : undefined;
    if (fallback) {
      await openNotebook(fallback.notebook, fallback.origin);
      return;
    }

    await loadSampleNotebook();
  }

  /**
   * Close a tab. The notebook stays in the library — closing is not deleting —
   * but its kernel does not: the worker is terminated rather than left running
   * for a notebook nobody can see.
   */
  function closeTab(id: string) {
    closeSession(id);
    if (get(sessions).length === 0) void loadSampleNotebook();
  }

  /**
   * Open one of the companion's files. The content comes from disk, not from
   * the library: a file under version control outranks a copy this browser
   * happens to be holding, and taking the library's copy would quietly hide an
   * edit made in an editor since.
   */
  function openDiskFile(path: string) {
    const existing = sessionForPath(path);
    if (existing) {
      setActive(existing.id);
      return;
    }
    if (!openSyncFile(path)) {
      showToast('The companion is no longer connected.', 'error');
    }
  }

  /** Open a library entry by key, from the picker or the Storage panel. */
  async function openFromLibrary(id: string) {
    const record = await getNotebookRecord(id);
    if (!record) {
      showToast('That notebook is no longer in the library.', 'error');
      await refreshLibrary();
      return;
    }
    await openNotebook(record.notebook, record.origin);
    showToast(`Opened “${record.name}”`, 'info');
  }

  /**
   * Clear what this origin keeps in localStorage besides the library: the chat
   * transcript, the AI key (stored unencrypted, and until now with no way out
   * of the app) and the UI preferences. Notebooks and datasets are in
   * IndexedDB and are deliberately untouched — they have their own rows.
   */
  /** Download everything this browser holds, and remember that it was done. */
  async function backupLibrary(opts: { includeLibraries?: boolean } = {}) {
    try {
      const { bytes, filename, notebooks, datasets: count, files, libraries } =
        await createLibraryBackup(new Date(), opts);
      downloadBytes(bytes, filename, 'application/zip');
      markBackedUp();
      const parts = [`${notebooks} notebook${notebooks === 1 ? '' : 's'}`];
      if (count) parts.push(`${count} dataset${count === 1 ? '' : 's'}`);
      if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
      if (libraries) parts.push(`${libraries} library file${libraries === 1 ? '' : 's'}`);
      showToast(
        `Backed up ${parts.join(', ')} to ${filename}. Keep it somewhere other than this browser.`,
        'info'
      );
    } catch (error: any) {
      console.error('Backup failed:', error);
      showToast(`Couldn’t make the backup: ${error?.message ?? error}`, 'error');
    }
  }

  /** Pick an archive and restore it; nothing newer here is overwritten. */
  function restoreLibrary() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const lines = await restoreLibraryBackup(new Uint8Array(await file.arrayBuffer()));
        conversionReport = {
          title: file.name,
          heading: 'Backup restored',
          intro: `From ${file.name}. Nothing newer in this browser was replaced.`,
          lines,
        };
      } catch (error: any) {
        console.error('Restore failed:', error);
        showToast(`Couldn’t restore ${file.name}: ${error?.message ?? error}`, 'error');
      }
    };
    input.click();
  }

  /**
   * Rewrite this notebook's unpinned imports to the versions they resolve to
   * now, so the notebook stays itself when a library moves.
   */
  async function pinImports() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    showToast('Looking up versions…', 'info');
    try {
      const report = await pinNotebookImports();
      const lines = [
        ...report.pinned,
        ...report.unresolved.map((spec) => `${spec} — nothing said what it resolves to; left as it is.`),
      ];
      if (report.alreadyPinned > 0) {
        lines.push(`${report.alreadyPinned} import${report.alreadyPinned === 1 ? '' : 's'} already named a version.`);
      }
      if (lines.length === 0) lines.push('This notebook imports nothing from a CDN.');
      conversionReport = {
        title: notebook.name,
        heading: report.pinned.length > 0 ? 'Imports pinned' : 'Imports checked',
        intro:
          report.pinned.length > 0
            ? 'These now name the exact version they were loading. Run the cells to check, then save.'
            : 'Nothing was changed.',
        lines,
      };
    } catch (error: any) {
      console.error('Pinning imports failed:', error);
      showToast(`Couldn’t pin the imports: ${error?.message ?? error}`, 'error');
    }
  }

  function clearBrowserData() {
    if (!confirm('Clear the chat history, AI key and preferences kept in this browser? Notebooks and datasets are not affected.')) return;
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('tangent-')) continue;
        // The library's pointer to the open notebook is not "browser data" in
        // this sense: dropping it would silently reopen something else.
        if (key === 'tangent-active-notebook') continue;
        // Nor is when the notebooks were last backed up: they are not what
        // this clears, and forgetting it would nag about a backup already made.
        if (key === LAST_BACKUP_KEY || key === BACKUP_SNOOZE_KEY) continue;
        localStorage.removeItem(key);
      }
      showToast('Cleared. Reload to start from defaults.', 'info');
    } catch (error) {
      console.warn('Could not clear local storage:', error);
      showToast('Could not clear this browser’s stored data.', 'error');
    }
  }

  /**
   * Delete a library entry for good. When it is the open one, the notebook
   * stays on screen — deleting the stored copy is not the same as closing what
   * you are working in — but it is no longer the notebook to restore.
   */
  async function removeFromLibrary(entry: LibraryEntry) {
    // Its tab, if open, goes too: a tab onto a notebook that no longer exists
    // would autosave it straight back into the library on the next keystroke.
    if (sessionById(entry.id)) closeTab(entry.id);
    await deleteNotebook(entry.id);
    showToast(`Removed “${entry.name}” from the library`, 'info');
  }

  /**
   * Give an imported notebook a new identity when one you already have would
   * otherwise be replaced.
   *
   * A notebook's id travels in its `.js` frontmatter, so a link can carry the
   * id of something already in this library. Identity used to include where a
   * notebook came from, which kept the two apart — at the cost of splitting one
   * notebook into several rows and several tabs. Forking here does the same job
   * without that: two notebooks that have genuinely diverged become two
   * notebooks, once, at the moment they diverge; a link to something you have
   * not touched still opens the entry you have.
   */
  async function forkIfItWouldOverwrite(incoming: NotebookDoc): Promise<NotebookDoc> {
    const existing = await getNotebookRecord(incoming.id);
    if (!existing || notebooksEquivalent(existing.notebook, incoming)) return incoming;
    return { ...incoming, id: `${incoming.id}-${Date.now().toString(36)}` };
  }

  /**
   * Open a notebook a link points at.
   *
   * This used to ask "opening this link replaces your notebook, save first?",
   * because the single autosave slot meant the link really did overwrite the
   * only copy. It no longer can: everything open is already in the library, and
   * a link carrying the id of something you have edited forks rather than
   * lands on it (see forkIfItWouldOverwrite). So the link just opens.
   */
  /**
   * What a conversion could not carry, shown after the notebook is open.
   *
   * A modal rather than a toast, and after rather than instead: the notebook is
   * usable either way, and the reader needs to be able to read the list, not
   * catch it going past. Nothing to say means nothing on screen.
   */
  let conversionReport: { title: string; lines: string[]; heading?: string; intro?: string } | null = $state(null);

  function reportLosses(name: string, losses: Loss[]) {
    const lines = summarizeLosses(losses);
    if (lines.length > 0) conversionReport = { title: name, lines };
  }

  async function loadNotebookFromUrl(request: ImportRequest) {
    await libraryReady;
    // Keep something on screen while the link is fetched — and something to
    // fall back to if it fails.
    const hadNotebook = get(currentNotebook) !== null;
    if (!hadNotebook) await restoreSessions();

    try {
      const { notebook, losses } = await fetchNotebookFromUrl(request);
      const hostname = new URL(request.fetchUrl).hostname;
      await openNotebook(await forkIfItWouldOverwrite(notebook), {
        kind: 'url',
        href: request.fetchUrl,
      });
      // Drop the import URL so a refresh reopens the library copy — with any
      // edits made since — instead of re-fetching over them.
      history.replaceState(null, '', '/');
      showToast(`Loaded “${notebook.name}” from ${hostname}`, 'info');
      reportLosses(notebook.name, losses);
    } catch (err: any) {
      console.error('URL import failed:', err);
      showToast(`Couldn’t open the notebook from the link: ${err.message}.`, 'error');
      if (!get(currentNotebook)) loadSampleNotebook();
    }
  }

  async function loadSampleNotebook() {
    try {
      const res = await fetch('/sample-notebooks/getting-started.js');
      if (res.ok) {
        const text = await res.text();
        // The sample's id comes from its own frontmatter, so it lands on the
        // same library entry every time instead of piling up copies.
        await openNotebook(parseJSNotebook(text, 'getting-started.js'), { kind: 'sample' });
        return;
      }
    } catch (e) {
      console.warn('Could not load the sample notebook:', e);
    }
    await openNotebook(createNewNotebook(), { kind: 'local' });
  }

  async function loadNotebookFiles() {
    notebookFiles.set([]);
  }

  // No unsaved-work guard on either of these any more: whatever is open is
  // already in the library, so opening something else cannot lose it.
  function handleNewNotebook() {
    void openNotebook(createNewNotebook(), { kind: 'local' });
  }

  function handleImportNotebook() {
    importNotebookFromFile((notebook, filename, losses) => {
      // The id travels in the file's frontmatter, so re-importing a file you
      // already have reopens its entry rather than forking a duplicate.
      void openNotebook(notebook, { kind: 'import', filename: filename ?? `${notebook.name}.js` });
      reportLosses(notebook.name, losses);
    });
  }

  function handleExportNotebook() {
    showExportDialog = true;
  }

  function onKeydown(event: KeyboardEvent) {
    handleGlobalKeydown(event, {
      showCommandPalette: () => { showCommandPalette = !showCommandPalette; },
      toggleChat: () => togglePanelTab('chat'),
      toggleData: () => togglePanelTab('storage'),
      toggleConsole: () => togglePanelTab('console'),
      save: () => performSaveShortcut(),
      saveAs: () => openSaveAs(),
      find: (replace) => window.dispatchEvent(new CustomEvent('open-find', { detail: { replace } })),
      newNotebook: () => handleNewNotebook(),
      importNotebook: () => handleImportNotebook(),
      openFolder: isDesktopApp() ? () => void openFolder() : undefined,
      undo: () => handleUndo(),
    });
  }

  /** The open tab linked to `path`, if any. */
  function sessionForPath(path: string) {
    return get(sessions).find((session) => {
      const origin = get(session.origin);
      return origin.kind === 'disk' && origin.path === path;
    }) ?? null;
  }

  /**
   * Take content the companion sent for one file.
   *
   * An external edit lands in the tab that holds that file, wherever the
   * reader happens to be looking — the notebook on screen is no longer the
   * only one a disk edit could be about.
   */
  function applySyncedContent(path: string, content: string, reason: LoadReason) {
    const session = sessionForPath(path);
    // An external edit must not silently discard work in progress in the tab
    // that holds it.
    if (reason === 'disk-change' && session && get(session.dirty)) {
      showToast(`${path} changed on disk. Save or reload that tab to take the new version.`, 'error');
      return;
    }
    // A file nobody opened is none of this browser's business. The companion
    // announces every notebook it sees change, new ones included; taking them
    // in would copy the whole folder into the library one editor save at a
    // time, and leave a row behind for every file later deleted. The list of
    // served files already shows them, as "not opened yet".
    if (reason === 'disk-change' && !session) return;
    const name = path.split('/').pop() ?? 'notebook.js';
    // Discovery offers Observable `.html` notebooks too, so the parser follows
    // the file rather than assuming Tangent's own format.
    let notebook: any;
    let losses: Loss[];
    try {
      ({ notebook, losses } = parseNotebookFile(content, name));
    } catch (err: any) {
      showToast(`Couldn’t read ${path}: ${err.message}.`, 'error');
      return;
    }
    // A file with no id of its own takes its path as its identity, exactly as
    // discovery does. Otherwise an Observable notebook was keyed by its title:
    // it never matched its own row in Storage, and two files both titled
    // "untitled" were one notebook.
    const ownId = looksLikeObservableNotebook(content.slice(0, 2000))
      ? null
      : frontmatterId(content);
    if (!ownId) notebook.id = pathNotebookId(path);
    // The companion owns this file, so its content replaces the tab already on
    // it rather than opening a second tab onto the same path.
    void openNotebook(notebook, { kind: 'disk', path }, { replaceContent: true });
    if (reason === 'disk-change') showToast(`Reloaded ${path} from disk`, 'info');
    reportLosses(notebook.name, losses);
  }

  function handleSyncConflict(path: string) {
    showToast(`${path} changed on disk since you opened it. Save again to overwrite.`, 'error');
    conflictedPaths.add(path);
  }

  /** Paths the companion has refused once; a second save overwrites on purpose. */
  const conflictedPaths = new Set<string>();

  async function performSaveShortcut() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    try {
      // With a companion, save writes this notebook's own file in place so git
      // sees the diff. A tab that came from a link or the library has no file
      // to write to and still exports a download.
      const origin = get(currentOrigin);
      if (isSyncConnected() && origin.kind === 'disk') {
        // Write back the format the file is in. Saving Tangent's `.js` source
        // into someone's Observable `.html` would destroy it.
        const { content, losses } = serializeForPath(notebook, origin.path);
        // A second save after a conflict warning overwrites deliberately.
        if (saveThroughSync(origin.path, content, conflictedPaths.has(origin.path))) {
          conflictedPaths.delete(origin.path);
          // Only an Observable file can lose anything, and only when it holds
          // something the format has no word for.
          reportLosses(notebook.name, losses);
          return;
        }
      }
      await saveNotebook(notebook);
      markNotebookClean();
      console.info('Notebook checkpoint exported as .js');
    } catch (err) {
      console.error('Save failed', err);
      showToast('Couldn’t export the notebook. See the console for details.', 'error');
    }
  }

  /**
   * Save As: write this notebook to a new file and move the tab onto it.
   *
   * Not an export. An export makes a copy somewhere else while you carry on in
   * the original; Save As changes where this document lives, so later saves go
   * to the new file and the old one is left exactly as it was on disk. The
   * extension picks the format — `.js` for Tangent's, `.html` for Observable's
   * — which is how an Observable notebook becomes a Tangent one, and back.
   *
   * Only the companion can write a file. Without it there is nowhere to save
   * *to*, so this hands over to the Export dialog, which downloads.
   */
  let saveAs: {
    path: string;
    /** What the target format cannot carry; shown once, before writing. */
    losses: string[] | null;
    /** The target exists; the next confirm overwrites it. */
    exists: boolean;
    error: string | null;
  } | null = $state(null);

  /**
   * What Save will do for the notebook on screen, said in the File menu: write
   * its own file when the companion links it to one, download otherwise. The
   * same keystroke does either, so the menu is where that gets spelled out.
   */
  const saveLabel = $derived(
    $syncStatus === 'connected' && $currentOrigin.kind === 'disk'
      ? `Save to ${$currentOrigin.path.split('/').pop()}`
      : 'Download .js'
  );

  /** The write in flight, so the companion's reply can be matched to it. */
  let pendingSaveAs: { path: string; oldId: string; notebook: NotebookDoc } | null = null;

  function openSaveAs() {
    const notebook = get(currentNotebook);
    if (!notebook) return;
    if (!isSyncConnected()) {
      showToast('Saving to a file needs note serve. Exporting a download instead.', 'info');
      showExportDialog = true;
      return;
    }
    const origin = get(currentOrigin);
    // Next to the file it came from, in the other format: converting is the
    // usual reason to reach for this. A notebook with no file yet goes at the
    // root, named after itself.
    const suggestion = origin.kind === 'disk'
      ? origin.path.replace(/\.(js|html)$/i, (ext) => (ext.toLowerCase() === '.html' ? '.js' : '.html'))
      : `${slugify(notebook.name || 'notebook')}.js`;
    saveAs = { path: suggestion, losses: null, exists: false, error: null };
  }

  function confirmSaveAs() {
    const notebook = get(currentNotebook);
    const session = currentSession();
    if (!saveAs || !notebook || !session) return;

    const path = saveAs.path.trim().replace(/^\.\//, '');
    if (!/\.(js|html)$/i.test(path)) {
      saveAs = { ...saveAs, error: 'The name has to end in .js (Tangent) or .html (Observable).' };
      return;
    }
    if (path.startsWith('/') || path.split('/').includes('..')) {
      saveAs = { ...saveAs, error: 'Give a path inside the served directory.' };
      return;
    }

    const origin = get(currentOrigin);
    if (origin.kind === 'disk' && origin.path === path) {
      // The file this tab already is: that is a plain save.
      saveAs = null;
      void performSaveShortcut();
      return;
    }
    const holder = sessionForPath(path);
    if (holder && holder.id !== session.id) {
      saveAs = { ...saveAs, error: `${path} is open in another tab. Close it first.` };
      return;
    }

    // A new file is a new notebook to the library: keeping the old id would
    // make two files one notebook, and opening either would replace the other.
    const renamed: NotebookDoc = { ...notebook, id: pathNotebookId(path) };
    const { content, losses } = serializeForPath(renamed, path);

    const lines = summarizeLosses(losses);
    if (lines.length > 0 && saveAs.losses === null) {
      saveAs = { ...saveAs, path, losses: lines, error: null };
      return;
    }

    pendingSaveAs = { path, oldId: session.id, notebook: renamed };
    // `exists` means the reader has already been told the file is there and
    // confirmed; only then is the write forced over it.
    if (!saveThroughSync(path, content, saveAs.exists, true)) {
      pendingSaveAs = null;
      saveAs = { ...saveAs, error: 'The companion is no longer connected.' };
    }
  }

  /** The companion wrote the Save As target: move the tab onto it. */
  function finishSaveAs(path: string): boolean {
    if (!pendingSaveAs || pendingSaveAs.path !== path) return false;
    const { oldId, notebook } = pendingSaveAs;
    pendingSaveAs = null;
    saveAs = null;
    const moved = rekeySession(oldId, notebook, { kind: 'disk', path });
    if (moved) void putNotebook(get(moved.notebook), get(moved.origin), { opened: true });
    showToast(`Saved as ${path}`, 'info');
    return true;
  }

  function handleUndo() {
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return undoDeleteCell(notebook);
    });
  }

  function handleCommand({ id: commandId }: { id: string }) {
    // The palette lists the library alongside its fixed commands, so opening
    // another notebook is "Ctrl+K, type its name".
    if (commandId.startsWith('open-library:')) {
      void openFromLibrary(commandId.slice('open-library:'.length));
      return;
    }
    switch (commandId) {
      case 'new-notebook':
        handleNewNotebook();
        break;
      case 'open-notebook':
        handleImportNotebook();
        break;
      case 'close-notebook': {
        const id = get(activeSessionId);
        if (id) closeTab(id);
        break;
      }
      case 'save-notebook':
        performSaveShortcut();
        break;
      case 'save-notebook-as':
        openSaveAs();
        break;
      case 'pin-imports':
        void pinImports();
        break;
      case 'backup-library':
        void backupLibrary();
        break;
      case 'restore-library':
        restoreLibrary();
        break;
      case 'freeze-environment':
        void (async () => {
          try {
            const { count } = await freezeEnvironment();
            showToast(`Frozen: ${count} ${count === 1 ? 'file' : 'files'} pinned in tangent.lock.`, 'info');
          } catch (error: any) {
            showToast(error?.message ?? 'Could not freeze.', 'error');
          }
        })();
        break;
      case 'unfreeze-environment':
        void (async () => {
          try {
            await unfreezeEnvironment();
            showToast('Unfrozen. This folder follows the network again.', 'info');
          } catch (error: any) {
            showToast(error?.message ?? 'Could not unfreeze.', 'error');
          }
        })();
        break;
      case 'restart-kernel':
        restartKernel();
        break;
      case 'restart-kernel-run-all':
        restartKernel({ runAll: true });
        break;
      case 'find-in-notebook':
      case 'replace-in-notebook':
        window.dispatchEvent(new CustomEvent('open-find', { detail: { replace: commandId === 'replace-in-notebook' } }));
        break;
      case 'export-notebook':
        handleExportNotebook();
        break;
      case 'run-all':
        runAllCells();
        break;
      case 'toggle-reactive':
        reactiveMode.update(v => !v);
        break;
      case 'toggle-output-position': {
        const next = get(outputPosition) === 'above' ? 'below' : 'above';
        outputPosition.set(next);
        showToast(`Cell outputs now appear ${next} the code`, 'info');
        break;
      }
      case 'cycle-notebook-width': {
        const order = ['normal', 'wide', 'full'] as const;
        const next = order[(order.indexOf(get(notebookWidth)) + 1) % order.length];
        notebookWidth.set(next);
        showToast(next === 'full'
          ? 'Notebook width: full. Cells fill the pane.'
          : `Notebook width: ${next}.`, 'info');
        break;
      }
      case 'toggle-kernel-mode': {
        const next = get(kernelMode) === 'worker' ? 'main' : 'worker';
        kernelMode.set(next);
        showToast(next === 'worker'
          ? 'Kernel: background worker. The page stays responsive and runs can be stopped.'
          : 'Kernel: main thread. Outputs can run their own scripts, but long runs freeze the page.', 'info');
        break;
      }
      case 'add-code-cell':
        addNewCell('code');
        break;
      case 'add-markdown-cell':
        addNewCell('markdown');
        break;
      case 'toggle-chat':
        togglePanelTab('chat');
        break;
      case 'open-storage':
        togglePanelTab('storage');
        break;
      case 'open-console':
        togglePanelTab('console');
        break;
      case 'clear-outputs':
        clearAllOutputs();
        break;
      case 'keyboard-shortcuts':
        showShortcuts = true;
        break;
    }
  }

  function addNewCell(type: 'code' | 'markdown') {
    const notebook = get(currentNotebook);
    if (!notebook) return;

    const currentSelectedId = get(selectedCellId);
    const targetCell = currentSelectedId
      ? notebook.cells.find(c => c.id === currentSelectedId)
      : null;
    const targetCellId = targetCell
      ? targetCell.id
      : notebook.cells[notebook.cells.length - 1].id;

    currentNotebook.update(nb => {
      if (!nb) return nb;
      const updatedNotebook = addCellAfter(nb, targetCellId, type);

      const newCell = updatedNotebook.cells.find(cell =>
        !nb.cells.some(oldCell => oldCell.id === cell.id)
      );
      if (newCell) {
        selectedCellId.set(newCell.id);
      }

      return updatedNotebook;
    });
  }

  /**
   * Restart the kernel of the notebook on screen.
   *
   * Variables go, and so do the execution numbers: `[12]` means "ran in the
   * kernel you have now", which stops being true the moment it restarts. The
   * counter starts again at 1 and nothing counts as stale. Outputs stay — they
   * are still worth reading, and Clear outputs is there for the rest.
   *
   * On the worker kernel this is a real restart: the worker is terminated and a
   * fresh one started, which also stops a runaway cell. On the main thread there
   * is no process to replace, so the notebook's variables are cleared but
   * anything a cell attached to the page itself (a timer, a playing audio
   * context) keeps going; reloading the page is the full reset there.
   */
  function restartKernel(opts: { runAll?: boolean } = {}) {
    const session = currentSession();
    if (!session) return;
    if (get(kernelMode) === 'worker') {
      kernelFor(session.id).interrupt();
    } else {
      executorFor(session.id).resetScope();
    }
    resetRunState(session);
    if (opts.runAll) {
      window.dispatchEvent(new CustomEvent('run-all-cells'));
    } else {
      showToast(
        get(kernelMode) === 'worker'
          ? 'Kernel restarted. Variables cleared; run cells to rebuild them.'
          : 'Variables cleared. Anything a cell started on the page (audio, timers) keeps running until you reload.',
        'info'
      );
    }
  }

  function clearAllOutputs() {
    resetExecutionCounter();
    currentNotebook.update(notebook => {
      if (!notebook) return notebook;
      return {
        ...notebook,
        cells: notebook.cells.map(cell => ({
          ...cell,
          output: undefined,
          executionOrder: undefined
        })),
        updatedAt: Date.now()
      };
    });
  }

  function handleInsertCode({ code }: { code: string }) {
    const notebook = get(currentNotebook);
    if (!notebook) return;

    const cellCode = extractCodeFromMessage(code);

    // Insert after the selected cell so the new cell lands where you're
    // working; fall back to the end of the notebook if nothing is selected.
    const selectedId = get(selectedCellId);
    const anchor =
      notebook.cells.find(c => c.id === selectedId) ??
      notebook.cells[notebook.cells.length - 1];

    const updatedNotebook = addCellAfter(notebook, anchor.id, 'code');
    const anchorIdx = updatedNotebook.cells.findIndex(c => c.id === anchor.id);
    const newCell = updatedNotebook.cells[anchorIdx + 1];
    newCell.content = cellCode;

    currentNotebook.set(updatedNotebook);
    selectedCellId.set(newCell.id);
  }

  /**
   * Write a cell's content on the chat's behalf — applying a proposed rewrite,
   * or putting the previous version back.
   *
   * It goes through updateCellContent like a keystroke does, so the notebook is
   * marked dirty and autosaved on the usual path; nothing here reaches the file
   * on disk, which still changes only on Ctrl/Cmd+S. Staleness is recomputed
   * because a rewritten cell's dependents are now out of date, and that is the
   * signal telling the reader what to re-run.
   */
  function handleEditCell({ cellId, content }: { cellId: string; content: string }) {
    currentNotebook.update(notebook =>
      notebook ? updateCellContent(notebook, cellId, content) : notebook
    );
    selectedCellId.set(cellId);
    recomputeStaleCells(get(currentNotebook));
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app-container">
  <!-- Observable-style header -->
  <header class="app-header">
    {#if $runProgress}
      <div
        class="run-progress"
        class:complete={$runProgress.done >= $runProgress.total}
        style="transform: scaleX({$runProgress.total ? $runProgress.done / $runProgress.total : 0})"
        role="progressbar"
        aria-valuenow={$runProgress.done}
        aria-valuemax={$runProgress.total}
        aria-label="Running cells"
        transition:fade={{ duration: 250 }}
      ></div>
    {/if}
    <div class="header-left">
      <button class="notebooks-btn" onclick={() => showCommandPalette = true} title="Command Palette (Ctrl+K)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 8h10M8 3l5 5-5 5"/>
        </svg>
        <kbd class="kbd-hint">⌘K</kbd>
      </button>
      <FileMenu
        saveLabel={saveLabel}
        canClose={$activeSessionId !== null}
        onnew={handleNewNotebook}
        onopen={handleImportNotebook}
        onopenfolder={isDesktopApp() ? () => void openFolder() : undefined}
        onsave={() => void performSaveShortcut()}
        onsaveas={openSaveAs}
        onexport={handleExportNotebook}
        onclose={() => { const id = get(activeSessionId); if (id) closeTab(id); }}
      />
    </div>

    <TabStrip
      onclose={({ id }) => closeTab(id)}
      onnew={handleNewNotebook}
    />

    <div class="header-right">
      {#if $currentNotebook}
        <RunMenu
          busy={$kernelBusy}
          reactive={$reactiveMode}
          stale={$staleCells.size}
          onrunall={() => window.dispatchEvent(new CustomEvent('run-all-cells'))}
          onrunstale={() => window.dispatchEvent(new CustomEvent('run-stale-cells'))}
          onstop={() => restartKernel()}
          onrestart={() => restartKernel()}
          onrestartrunall={() => restartKernel({ runAll: true })}
          ontogglereactive={() => reactiveMode.update((v) => !v)}
        />
      {/if}
    </div>
  </header>

  <div class="content-wrapper">
    <main class="main-content">
      <Notebook />
    </main>

    {#if rightSidebarOpen}
      <aside class="right-sidebar-container" style="width: {rightSidebarWidth}px">
        <div
          class="panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onpointerdown={startPanelResize}
        ></div>
        <RightSidebar
          bind:activeTab={rightSidebarTab}
          oninsertCode={handleInsertCode}
          oneditCell={handleEditCell}
          onopenNotebook={({ id }) => openFromLibrary(id)}
          onopenDiskFile={({ path }) => openDiskFile(path)}
          ondeleteNotebook={({ entry }) => removeFromLibrary(entry)}
          onclearBrowserData={clearBrowserData}
          onbackup={({ includeLibraries }) => void backupLibrary({ includeLibraries })}
          onrestore={restoreLibrary}
        />
      </aside>
    {/if}

    <PanelRail
      activeTab={rightSidebarTab}
      open={rightSidebarOpen}
      dark={$theme === 'dark'}
      backupDue={$backupState.due}
      ontheme={toggleTheme}
      onselect={togglePanelTab}
    />
  </div>

  <StatusBar
    origin={$currentOrigin}
    connected={$syncStatus === 'connected'}
    cells={$currentNotebook ? $currentNotebook.cells.length : null}
    dirty={$notebookDirty}
    busy={$kernelBusy}
    reactive={$reactiveMode}
    stale={$staleCells.size}
    kernel={$kernelMode}
    onrunstale={() => window.dispatchEvent(new CustomEvent('run-stale-cells'))}
    ontogglereactive={() => reactiveMode.update((v) => !v)}
    onkernel={() => { setPanelOpen(true); rightSidebarTab = 'info'; }}
  />

  <CommandPalette
    bind:visible={showCommandPalette}
    oncommand={handleCommand}
  />

  {#if showExportDialog}
    <ExportDialog onclose={() => showExportDialog = false} />
  {/if}

  {#if showShortcuts}
    <div
      class="unsaved-overlay"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) showShortcuts = false; }}
    >
      <div class="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="shortcuts-head">
          <h3 id="shortcuts-title">Keyboard shortcuts</h3>
          <button class="shortcuts-close" onclick={() => showShortcuts = false} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3l8 8M11 3l-8 8"/>
            </svg>
          </button>
        </div>
        <ul class="shortcuts-list">
          {#each SHORTCUTS as s}
            <li>
              <span class="shortcuts-action">{s.action}</span>
              <kbd class="shortcuts-keys">{s.keys}</kbd>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if saveAs}
    <div
      class="unsaved-overlay"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) { saveAs = null; pendingSaveAs = null; } }}
    >
      <div class="shortcuts-modal report-modal" role="dialog" aria-modal="true" aria-labelledby="save-as-title">
        <div class="shortcuts-head">
          <h3 id="save-as-title">Save notebook as</h3>
          <button class="shortcuts-close" onclick={() => { saveAs = null; pendingSaveAs = null; }} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3l8 8M11 3l-8 8"/>
            </svg>
          </button>
        </div>
        <form onsubmit={(e) => { e.preventDefault(); confirmSaveAs(); }}>
          <label class="save-as-label" for="save-as-path">
            File, inside <code>{$syncRoot ?? 'the served directory'}</code>
          </label>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            id="save-as-path"
            class="save-as-input"
            bind:value={saveAs.path}
            oninput={() => { if (saveAs) saveAs = { ...saveAs, losses: null, exists: false, error: null }; }}
            autofocus
            spellcheck="false"
          />
          <p class="report-intro">
            <code>.js</code> saves in Tangent's format, <code>.html</code> in Observable's.
            The tab moves to the new file; the file it came from is left as it is.
          </p>
          {#if saveAs.error}
            <p class="save-as-error" role="alert">{saveAs.error}</p>
          {/if}
          {#if saveAs.exists}
            <p class="save-as-error" role="alert">{saveAs.path} already exists. Saving again replaces it.</p>
          {/if}
          {#if saveAs.losses}
            <p class="report-intro">Observable's format has no room for:</p>
            <ul class="report-list">
              {#each saveAs.losses as line}
                <li>{line}</li>
              {/each}
            </ul>
          {/if}
          <div class="save-as-actions">
            <button type="button" class="save-as-cancel" onclick={() => { saveAs = null; pendingSaveAs = null; }}>Cancel</button>
            <button type="submit" class="save-as-confirm">
              {saveAs.exists ? 'Replace file' : saveAs.losses ? 'Save anyway' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  {#if conversionReport}
    <div
      class="unsaved-overlay"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) conversionReport = null; }}
    >
      <div class="shortcuts-modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div class="shortcuts-head">
          <h3 id="report-title">{conversionReport.heading ?? 'Imported with notes'}</h3>
          <button class="shortcuts-close" onclick={() => conversionReport = null} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3l8 8M11 3l-8 8"/>
            </svg>
          </button>
        </div>
        <p class="report-intro">
          {#if conversionReport.intro}
            {conversionReport.intro}
          {:else}
            “{conversionReport.title}” is open. Observable and Tangent run notebooks
            differently, so some things came across as text rather than behaviour:
          {/if}
        </p>
        <ul class="report-list">
          {#each conversionReport.lines as line}
            <li>{line}</li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if toast}
    <div class="toast {toast.tone}" role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button class="toast-close" onclick={() => toast = null} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 3l8 8M11 3l-8 8"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-color: var(--bg);
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 1.25rem;
    background-color: var(--surface);
    border-bottom: 1px solid var(--border);
    height: 44px;
    position: relative;
    z-index: 50;
  }

  /* Thin batch-run progress bar, sitting on the header's bottom edge. It fills
     left-to-right as cells finish; a gentle pulse marks that a cell is still
     running, and it fades out when the run completes. */
  .run-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    transform-origin: left center;
    background: var(--accent-solid);
    transition: transform 0.3s ease;
    z-index: 51;
    pointer-events: none;
  }
  .run-progress:not(.complete) {
    animation: run-progress-pulse 1.1s ease-in-out infinite;
  }
  @keyframes run-progress-pulse {
    0%, 100% { opacity: 0.72; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .run-progress { transition: none; animation: none; }
  }

  /* The header is one row at every width (see the layout fix in 49c2f7d), and
     putting a variable-width tab strip in it is only safe if the strip is the
     one thing that gives: the button groups never shrink, the strip absorbs
     whatever is left and scrolls inside itself. */
  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .notebooks-btn {
    background: transparent;
    border: none;
    padding: 0.4rem 0.65rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-pill);
    transition: all 0.15s ease;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .notebooks-btn:hover {
    background-color: var(--surface-hover);
    color: var(--heading);
  }

  .kbd-hint {
    padding: 0.125rem 0.375rem;
    background-color: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }

  /* Header controls never wrap their own text into two lines; when the row
     gets tight the media query below drops the labels instead. */
  .notebooks-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  /* Awkward middle widths (sidebar open, split screens): collapse the
     button labels to icons well before anything is forced to wrap. The
     ≤640px block below tightens paddings further for phones. */
  @media (max-width: 960px) {
    .btn-label,
    .kbd-hint {
      display: none;
    }
    .notebooks-btn {
      gap: 0;
    }
  }

  /* Mobile: collapse the header to icons so it fits narrow screens. */
  @media (max-width: 640px) {
    .app-header { padding: 0.4rem 0.5rem; }
    .header-left,
    .header-right { gap: 0.1rem; }
    .btn-label,
    .kbd-hint { display: none; }
    .notebooks-btn { padding: 0.4rem 0.45rem; gap: 0; }
  }

  .content-wrapper {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .main-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    /* De-chromed cells sit directly on the paper surface (both themes' vars
       keep the page/surface layering consistent in dark mode). */
    background-color: var(--surface);
    /* Named size container: #wide/#full output layers size themselves with
       cqw units against the actual notebook area, so open sidebars and
       narrow windows shrink breakouts instead of overflowing. */
    container-type: inline-size;
  }

  .right-sidebar-container {
    position: relative;
    border-left: 1px solid var(--border);
    background-color: var(--bg);
    /* Each tool scrolls its own content (Files, Info, the console): a
       scrolling container around them put a second scrollbar beside the
       first. */
    overflow: hidden;
    flex-shrink: 0;
  }

  /* Invisible grab strip over the left border; teal on hover/drag. */
  .panel-resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
    z-index: 10;
  }

  .panel-resize-handle:hover,
  .panel-resize-handle:active {
    background: var(--accent);
    opacity: 0.35;
  }

  @media (max-width: 768px) {
    .right-sidebar-container {
      position: fixed;
      /* Floating over the notebook, but never over the rail: the icon that
         opened the panel is the one that closes it. */
      right: 44px;
      top: 48px;
      bottom: 0;
      z-index: 30;
      box-shadow: var(--shadow-md);
      /* Never wider than the viewport, whatever width was dragged on desktop. */
      max-width: calc(100vw - 44px);
    }
  }

  @media (max-width: 640px) {
    .right-sidebar-container {
      right: 38px;
      max-width: calc(100vw - 38px);
    }
  }

  /* Modal backdrop. Named for the save-before-you-navigate dialog it was
     written for; that dialog is gone (the library made it unnecessary) and the
     shortcuts sheet is the remaining user. */
  .unsaved-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .shortcuts-modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    width: 90%;
    max-width: 440px;
    padding: 1.25rem 1.5rem 1.5rem;
    box-shadow: var(--shadow-lg);
  }

  .shortcuts-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .shortcuts-head h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--heading);
  }

  .shortcuts-close {
    display: flex;
    padding: 0.3rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .shortcuts-close:hover { background: var(--surface-hover); color: var(--heading); }

  .save-as-label {
    display: block;
    margin-bottom: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .save-as-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--heading);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
  }

  .save-as-input:focus { outline: none; border-color: var(--accent); }

  .save-as-error {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    color: var(--danger-fg);
  }

  .save-as-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }

  .save-as-cancel,
  .save-as-confirm {
    padding: 0.45rem 0.9rem;
    border-radius: var(--radius-pill);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
  }

  .save-as-cancel {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
  }

  .save-as-confirm {
    background: var(--accent-solid);
    color: var(--accent-on-solid);
    border: 1px solid var(--accent-solid);
  }

  /* The conversion report is prose, not a key table, so it gets room to be
     read — the point of showing it at all is that it can be acted on. */
  .report-modal { max-width: 560px; }

  .report-intro {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .report-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }

  .report-list li {
    padding: 0.5rem 0;
    border-top: 1px solid var(--border);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text);
  }

  .shortcuts-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .shortcuts-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }

  .shortcuts-action {
    font-size: 0.875rem;
    color: var(--text);
  }

  .shortcuts-keys {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-input);
    padding: 0.15rem 0.45rem;
    white-space: nowrap;
  }

  .toast {
    position: fixed;
    bottom: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: min(90vw, 420px);
    padding: 0.65rem 0.75rem 0.65rem 1rem;
    border-radius: var(--radius-input);
    font-size: 0.85rem;
    box-shadow: var(--shadow-md);
    z-index: 1100;
  }

  .toast.error {
    background: var(--danger-bg);
    color: var(--danger-fg);
    border: 1px solid var(--danger-border);
  }

  .toast.info {
    background: var(--heading);
    color: var(--bg);
    border: 1px solid var(--heading);
  }

  .toast-close {
    display: flex;
    padding: 0.2rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    color: currentColor;
    opacity: 0.7;
    cursor: pointer;
  }

  .toast-close:hover { opacity: 1; }
</style>
