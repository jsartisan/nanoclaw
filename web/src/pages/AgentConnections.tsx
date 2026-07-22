import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { IconBrandSlack, IconBrandTelegram, IconPlugConnected } from '@tabler/icons-react';

import { Button } from 'ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from 'ui/components/Card';
import { ConfirmDialog } from 'ui/components/ConfirmDialog';
import { Modal } from 'ui/components/Modal';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from 'ui/components/Dialog';
import { Select, SelectItem } from 'ui/components/Select';
import { Skeleton } from 'ui/components/Skeleton';
import { TextField } from 'ui/components/TextField';
import { toast } from 'ui/components/Toast';

import { CommandError, custom, list } from '../lib/api';
import { CHANNEL_CATALOG } from '../lib/channels';
import { PageShell } from '../components/PageShell';
import { IntegrationsCard } from '../components/IntegrationsCard';

type EngageMode = 'mention' | 'mention-sticky' | 'pattern';

interface ChannelAccount {
  id: string;
  channel_type: string;
  account_id: string;
  default_agent_group_id: string | null;
  engage_mode: EngageMode;
  engage_pattern: string | null;
}

const ENGAGE_OPTIONS: { id: EngageMode; label: string; hint: string }[] = [
  { id: 'mention', label: 'Mention only', hint: '@mention to engage. DMs always reply.' },
  { id: 'mention-sticky', label: 'Mention-sticky', hint: 'Mention once, then keep replying in that thread.' },
  { id: 'pattern', label: 'Pattern', hint: 'Reply when the message text matches a regex.' },
];

/** Short human label for a connection's current engagement setting. */
function engageSummary(acc: ChannelAccount): string {
  if (acc.engage_mode === 'pattern') return `Pattern: ${acc.engage_pattern || '.'}`;
  return ENGAGE_OPTIONS.find((o) => o.id === acc.engage_mode)?.label ?? 'Mention only';
}

function channelIcon(channelType: string) {
  if (channelType === 'telegram') return <IconBrandTelegram className="size-5" />;
  if (channelType === 'slack') return <IconBrandSlack className="size-5" />;
  return <IconPlugConnected className="size-5" />;
}

/* Neutral editorial tile — the channel name carries the identity. */
function channelTile(channelType: string): string {
  if (channelType === 'telegram' || channelType === 'slack')
    return 'bg-secondary text-secondary-foreground';
  return 'bg-primary/8 text-primary';
}

/**
 * Everything that links this agent to the outside world, in one place:
 *  - "Reachable from" — the platform channels (Telegram, Slack, …) it
 *    answers on, besides web chat.
 *  - "Abilities" — the integrations (MCP tools) it can use.
 */
export function AgentConnections() {
  const { groupId } = useParams({ from: '/agents/$groupId/connections' });
  const navigate = useNavigate();

  const [connections, setConnections] = useState<ChannelAccount[] | null>(null);
  const [removing, setRemoving] = useState<ChannelAccount | null>(null);
  const [editingEngage, setEditingEngage] = useState<ChannelAccount | null>(null);

  const refresh = useCallback(async () => {
    const accounts = await list<ChannelAccount>('channel-accounts').catch(() => [] as ChannelAccount[]);
    setConnections(accounts.filter((a) => a.default_agent_group_id === groupId));
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function disconnect(account: ChannelAccount) {
    try {
      await custom('channel-accounts', 'delete', { id: account.id });
      toast.success('Disconnected');
      await refresh();
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : 'Failed to disconnect');
    } finally {
      setRemoving(null);
    }
  }

  if (connections === null) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6" aria-hidden>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  const connectedTypes = new Set(connections.map((c) => c.channel_type));

  return (
    <PageShell width="narrow" className="flex flex-col gap-6">
      <Card variant="outline">
        <CardHeader>
          <CardTitle className="text-base">Reachable from</CardTitle>
          <CardDescription>Where this agent answers, besides web chat.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {connections.map((acc) => (
            <div key={acc.id} className="flex items-center gap-3">
              <div
                className={`relative flex size-9 shrink-0 items-center justify-center rounded-lg ${channelTile(acc.channel_type)}`}
              >
                {channelIcon(acc.channel_type)}
                <span className="border-card bg-success absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2" />
              </div>
              <div className="min-w-0 grow">
                <span className="truncate font-medium capitalize">{acc.channel_type}</span>
                <div className="text-muted-foreground truncate text-xs">
                  “{acc.account_id}” · {engageSummary(acc)}
                </div>
              </div>
              <Button variant="outline" size="sm" onPress={() => setEditingEngage(acc)}>
                Engagement
              </Button>
              <Button variant="outline" size="sm" onPress={() => setRemoving(acc)}>
                Disconnect
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            {CHANNEL_CATALOG.filter((ch) => !connectedTypes.has(ch.id)).map((ch) => (
              <Button
                key={ch.id}
                variant="outline"
                size="sm"
                onPress={() =>
                  navigate({
                    to: '/agents/$groupId/connect',
                    params: { groupId },
                    search: { channel: ch.id },
                  })
                }
              >
                {channelIcon(ch.id)} Connect {ch.name}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <IntegrationsCard groupId={groupId} />

      {removing && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Disconnect ${removing.channel_type}?`}
          description="The bot goes offline immediately. Your chat history stays."
          confirmLabel="Disconnect"
          onConfirm={() => void disconnect(removing)}
        />
      )}

      {editingEngage && (
        <EngagementDialog
          account={editingEngage}
          onClose={() => setEditingEngage(null)}
          onSaved={() => {
            setEditingEngage(null);
            void refresh();
          }}
        />
      )}
    </PageShell>
  );
}

function EngagementDialog({
  account,
  onClose,
  onSaved,
}: {
  account: ChannelAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<EngageMode>(account.engage_mode ?? 'mention');
  const [pattern, setPattern] = useState(account.engage_pattern ?? '');
  const [pending, setPending] = useState(false);

  async function save() {
    if (mode === 'pattern' && !pattern.trim()) {
      return toast.error('Enter a pattern, or use “.” to reply to everything');
    }
    setPending(true);
    try {
      await custom('channel-accounts', 'set-engagement', {
        id: account.id,
        engage_mode: mode,
        engage_pattern: mode === 'pattern' ? pattern.trim() : '',
      });
      toast.success('Saved');
      onSaved();
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : 'Could not save');
      setPending(false);
    }
  }

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-[26rem] max-w-full">
        <DialogHeader>
          <DialogTitle>When should this agent reply?</DialogTitle>
          <DialogDescription slot="description">
            Applies to {account.channel_type} channels and groups. Direct messages always get a reply.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-4">
          <Select
            label="Engagement"
            selectedKey={mode}
            onSelectionChange={(k) => setMode(k as EngageMode)}
            description={ENGAGE_OPTIONS.find((o) => o.id === mode)?.hint}
          >
            {ENGAGE_OPTIONS.map((o) => (
              <SelectItem key={o.id} id={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </Select>

          {mode === 'pattern' && (
            <TextField
              label="Pattern"
              value={pattern}
              onChange={setPattern}
              placeholder="e.g. (?i)deploy|ship   ·   . matches everything"
              description="Regular expression matched against the message text."
            />
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={pending} onPress={() => void save()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Dialog>
    </Modal>
  );
}
