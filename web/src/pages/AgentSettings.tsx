import { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';

import { Button } from 'ui/components/Button';
import { Card, CardContent } from 'ui/components/Card';
import { ConfirmDialog } from 'ui/components/ConfirmDialog';
import { Label } from 'ui/components/Label';
import { Select, SelectItem } from 'ui/components/Select';
import { Skeleton } from 'ui/components/Skeleton';
import { TextField } from 'ui/components/TextField';
import { Textarea } from 'ui/components/Textarea';
import { toast } from 'ui/components/Toast';

import { CommandError, call } from '../lib/api';
import { PageShell } from '../components/PageShell';

interface AgentSettingsData {
  id: string;
  name: string;
  personality: string;
  model: string | null;
  effort: string | null;
}

// `default` = clear the override (empty value); `custom` reveals a free-text id field.
// All other ids are the literal model value stored in the container config.
const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest' },
  { id: 'custom', label: 'Custom model id…' },
];
const MODEL_PRESET_IDS = new Set(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);

const EFFORT_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low — fastest, cheapest' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max — deepest reasoning' },
];

/**
 * The agent's profile (name, personality, model) and the danger zone.
 * Channels live under Connections; abilities under Integrations.
 */
export function AgentSettings() {
  const { groupId } = useParams({ from: '/agents/$groupId/settings' });
  const navigate = useNavigate();

  const [settings, setSettings] = useState<AgentSettingsData | null>(null);
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
  const [model, setModel] = useState('');
  // Dropdown key: 'default', a preset id, or 'custom' when the id is free-typed.
  const [modelChoice, setModelChoice] = useState('default');
  const [effort, setEffort] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call<AgentSettingsData>('agent-get', { id: groupId })
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setName(s.name);
        setPersonality(s.personality);
        const m = s.model ?? '';
        setModel(m);
        setModelChoice(m === '' ? 'default' : MODEL_PRESET_IDS.has(m) ? m : 'custom');
        setEffort(s.effort ?? '');
      })
      .catch((err) => toast.error(err instanceof CommandError ? err.message : 'Could not load this agent'));
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const dirty =
    settings !== null &&
    (name.trim() !== settings.name ||
      personality.trim() !== settings.personality ||
      model.trim() !== (settings.model ?? '') ||
      effort !== (settings.effort ?? ''));

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const result = await call<{ restarted: number }>('agent-update', {
        id: groupId,
        name: name.trim(),
        personality: personality.trim(),
        model: model.trim(),
        effort,
      });
      setSettings({
        ...settings,
        name: name.trim(),
        personality: personality.trim(),
        model: model.trim() || null,
        effort: effort || null,
      });
      toast.success(result.restarted > 0 ? 'Saved — your agent restarted with the changes' : 'Saved');
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function deleteAgent() {
    setDeleting(true);
    try {
      await call('groups-delete', { id: groupId });
      toast.success('Agent deleted');
      navigate({ to: '/' });
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : 'Could not delete the agent');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (settings === null) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6" aria-hidden>
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <PageShell width="narrow" className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4 py-5">
          <TextField label="Name" value={name} onChange={setName} maxLength={60} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-personality">Personality &amp; instructions</Label>
            <Textarea
              id="agent-personality"
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="What should this agent be like? What is it for?"
              className="min-h-32"
            />
          </div>

          <Select
            label="Model"
            selectedKey={modelChoice}
            onSelectionChange={(k) => {
              const key = String(k);
              setModelChoice(key);
              // Preset keys are the model id itself; 'default' clears; 'custom' keeps the typed value.
              if (key === 'default') setModel('');
              else if (key !== 'custom') setModel(key);
            }}
            description="The model this agent runs on. Leave as Default unless you have a reason to change it."
          >
            {MODEL_OPTIONS.map((o) => (
              <SelectItem key={o.id} id={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </Select>

          {modelChoice === 'custom' && (
            <TextField
              label="Custom model id"
              value={model}
              onChange={setModel}
              placeholder="e.g. claude-sonnet-4-5"
              description="Any provider-specific model id supported by this agent's provider."
            />
          )}

          <Select
            label="Reasoning effort"
            selectedKey={effort || 'default'}
            onSelectionChange={(k) => setEffort(String(k) === 'default' ? '' : String(k))}
            description="How hard the model thinks before replying. Higher is slower and costs more."
          >
            {EFFORT_OPTIONS.map((o) => (
              <SelectItem key={o.id} id={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </Select>

          <div className="flex justify-end">
            <Button onPress={save} isDisabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" className="border-destructive/40">
        <CardContent className="flex items-center justify-between gap-3 py-4">
          <div>
            <div className="font-medium">Delete this agent</div>
            <div className="text-muted-foreground text-sm">Removes the agent and its conversations. No undo.</div>
          </div>
          <Button variant="destructive" size="sm" onPress={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </CardContent>
      </Card>

      {confirmDelete && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => !open && setConfirmDelete(false)}
          title={`Delete ${settings.name}?`}
          description="This removes the agent, its wiring, and its sessions. There is no undo."
          confirmLabel="Delete agent"
          isPending={deleting}
          onConfirm={() => void deleteAgent()}
        />
      )}
    </PageShell>
  );
}
