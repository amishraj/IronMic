import { useState, useEffect } from 'react';
import { Database, Trash2, Clock, AlertTriangle } from 'lucide-react';
import { Card, Toggle, Button } from './ui';

export function DataManager() {
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const [autoDelete, setAutoDelete] = useState(false);
  const [autoDeleteDays, setAutoDeleteDays] = useState(14);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => { loadState(); }, []);

  async function loadState() {
    try {
      const entries = await window.ironmic.listEntries({ limit: 1000, offset: 0 });
      setEntryCount(entries?.length ?? 0);
      const autoDeleteSetting = await window.ironmic.getSetting('auto_delete_enabled');
      const autoDeleteDaysSetting = await window.ironmic.getSetting('auto_delete_days');
      setAutoDelete(autoDeleteSetting === 'true');
      if (autoDeleteDaysSetting) setAutoDeleteDays(parseInt(autoDeleteDaysSetting, 10));
    } catch { /* ignore */ }
  }

  async function handleClearAll() {
    if (!confirming) { setConfirming(true); return; }
    setClearing(true);
    try {
      await window.ironmic.deleteAllEntries();
      setEntryCount(0);
    } catch (err) { console.error('Failed to clear entries:', err); }
    finally { setClearing(false); setConfirming(false); }
  }

  async function handleAutoDeleteToggle() {
    const newValue = !autoDelete;
    setAutoDelete(newValue);
    await window.ironmic.setSetting('auto_delete_enabled', String(newValue));
  }

  async function handleAutoDeleteDaysChange(days: number) {
    setAutoDeleteDays(days);
    await window.ironmic.setSetting('auto_delete_days', String(days));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-iron-text-muted" />
        <h3 className="text-sm font-semibold text-iron-text">Data Management</h3>
      </div>

      {entryCount !== null && (
        <p className="text-xs text-iron-text-muted">
          {entryCount} dictation{entryCount !== 1 ? 's' : ''} stored locally.
        </p>
      )}

      {/* Auto-delete */}
      <Card variant="default" padding="md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Clock className="w-4 h-4 text-iron-text-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-iron-text">Auto-delete old dictations</p>
              <p className="text-xs text-iron-text-muted mt-0.5">Remove entries older than a set window</p>
            </div>
          </div>
          <Toggle checked={autoDelete} onChange={handleAutoDeleteToggle} />
        </div>

        {autoDelete && (
          <div className="flex items-center gap-2 mt-3 pl-7">
            <span className="text-xs text-iron-text-muted">Delete after</span>
            <select
              value={autoDeleteDays}
              onChange={(e) => handleAutoDeleteDaysChange(parseInt(e.target.value, 10))}
              className="text-xs px-2 py-1 bg-iron-bg border border-iron-border rounded-md text-iron-text focus:outline-none focus:border-iron-accent/50 appearance-none"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
        )}
      </Card>

      {/* Clear all */}
      <Card variant="default" padding="md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Trash2 className="w-4 h-4 text-iron-text-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-iron-text">Clear all dictations</p>
              <p className="text-xs text-iron-text-muted mt-0.5">Permanently delete all stored data</p>
            </div>
          </div>
          <Button
            variant={confirming ? 'danger' : 'secondary'}
            size="sm"
            onClick={handleClearAll}
            disabled={clearing || entryCount === 0}
            loading={clearing}
            icon={confirming ? <AlertTriangle className="w-3 h-3" /> : undefined}
          >
            {confirming ? 'Confirm' : 'Clear all'}
          </Button>
        </div>
        {confirming && (
          <div className="mt-2.5 flex items-center gap-2 pl-7">
            <p className="text-xs text-iron-danger flex-1">
              This cannot be undone. {entryCount} dictation{entryCount !== 1 ? 's' : ''} will be deleted.
            </p>
            <button onClick={() => setConfirming(false)} className="text-xs text-iron-text-muted hover:text-iron-text-secondary transition-colors">
              Cancel
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
