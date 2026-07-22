import { useCallback, useEffect, useState } from 'react';
import {
  IconBook,
  IconBrandGithub,
  IconBrandGmail,
  IconCalendar,
  IconChartBar,
  IconPuzzle,
  IconSearch,
  IconWorld,
} from '@tabler/icons-react';

import { Badge } from 'ui/components/Badge';
import { Button } from 'ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from 'ui/components/Card';
import { Modal } from 'ui/components/Modal';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from 'ui/components/Dialog';
import { NativeLink } from 'ui/components/NativeLink';
import { Skeleton } from 'ui/components/Skeleton';
import { TextField } from 'ui/components/TextField';
import { toast } from 'ui/components/Toast';

import { CommandError, call } from '../lib/api';

interface IntegrationEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  auth: { type: 'api_key' | 'none' | 'guided'; env?: string; urlEnv?: string; helpUrl?: string; help?: string };
  enabled_groups: string[];
}

const INTEGRATION_ICONS: Record<string, typeof IconPuzzle> = {
  'brave-search': IconSearch,
  tavily: IconWorld,
  firecrawl: IconWorld,
  context7: IconBook,
  github: IconBrandGithub,
  grafana: IconChartBar,
  gmail: IconBrandGmail,
  'google-calendar': IconCalendar,
};

/**
 * The abilities (integrations) this agent has — search, email, docs, and
 * more. Enabling one wires an MCP server into the agent's container.
 *
 * Rendered as a card (no page chrome) so it can be stacked alongside the
 * channel connections card on the combined Connections tab.
 */
export function IntegrationsCard({ groupId }: { groupId: string }) {
  const [integrations, setIntegrations] = useState<IntegrationEntry[] | null>(null);
  const [enabling, setEnabling] = useState<IntegrationEntry | null>(null);

  const refresh = useCallback(async () => {
    const catalog = await call<IntegrationEntry[]>('integrations-list').catch(() => [] as IntegrationEntry[]);
    setIntegrations(catalog);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (integrations === null) {
    return <Skeleton className="h-48 w-full rounded-xl" aria-hidden />;
  }

  return (
    <>
      <Card variant="outline">
        <CardHeader>
          <CardTitle className="text-base">Abilities</CardTitle>
          <CardDescription>Give this agent new abilities — search, email, docs, and more.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {integrations.map((entry) => {
            const EntryIcon = INTEGRATION_ICONS[entry.id] ?? IconPuzzle;
            const enabledHere = entry.enabled_groups.includes(groupId);
            const guided = entry.auth.type === 'guided';
            return (
              <div key={entry.id} className="flex items-center gap-3">
                <div className="bg-muted text-foreground/80 border-border flex size-9 shrink-0 items-center justify-center rounded-lg border">
                  <EntryIcon className="size-4.5" stroke={1.75} />
                </div>
                <div className="min-w-0 grow">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{entry.name}</span>
                    {enabledHere && (
                      <Badge variant="secondary">
                        <span className="bg-success mr-1 inline-block size-1.5 rounded-full" /> on
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {guided ? entry.auth.help : entry.description}
                  </div>
                </div>
                {!guided && (
                  <Button variant="outline" size="sm" onPress={() => setEnabling(entry)}>
                    {enabledHere ? 'Manage' : 'Enable'}
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {enabling && (
        <IntegrationDialog
          entry={enabling}
          groupId={groupId}
          onClose={() => setEnabling(null)}
          onChanged={() => {
            setEnabling(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function IntegrationDialog({
  entry,
  groupId,
  onClose,
  onChanged,
}: {
  entry: IntegrationEntry;
  groupId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);

  const enabledHere = entry.enabled_groups.includes(groupId);
  const needsKey = entry.auth.type === 'api_key';
  const needsUrl = !!entry.auth.urlEnv;

  async function run(action: 'enable' | 'disable') {
    if (action === 'enable' && needsKey && !key.trim()) return toast.error('Paste the API key first');
    if (action === 'enable' && needsUrl && !url.trim()) return toast.error('Enter the instance URL first');
    setPending(true);
    try {
      if (action === 'enable') {
        await call('integrations-enable', { id: entry.id, group: groupId, key: key.trim(), url: url.trim() });
        toast.success(`${entry.name} is being added — your agent will have it in a few minutes`);
      } else {
        await call('integrations-disable', { id: entry.id, group: groupId });
        toast.success(`${entry.name} disabled`);
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : 'Something went wrong');
      setPending(false);
    }
  }

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-[26rem] max-w-full">
        <DialogHeader>
          <DialogTitle>{entry.name}</DialogTitle>
          <DialogDescription slot="description">{entry.description}</DialogDescription>
        </DialogHeader>

        {needsKey && !enabledHere && (
          <div className="mt-4 flex flex-col gap-3">
            {needsUrl && (
              <TextField
                label="Instance URL"
                type="url"
                placeholder="https://grafana.example.com"
                value={url}
                onChange={setUrl}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <TextField
                label="API key"
                type="password"
                value={key}
                onChange={setKey}
                description={entry.auth.help}
              />
              {entry.auth.helpUrl && (
                <NativeLink href={entry.auth.helpUrl} target="_blank" rel="noopener noreferrer" className="text-xs">
                  Get a key →
                </NativeLink>
              )}
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onPress={onClose}>
            Cancel
          </Button>
          {enabledHere ? (
            <Button variant="destructive" isDisabled={pending} onPress={() => void run('disable')}>
              {pending ? 'Disabling…' : 'Disable'}
            </Button>
          ) : (
            <Button isDisabled={pending} onPress={() => void run('enable')}>
              {pending ? 'Enabling…' : 'Enable'}
            </Button>
          )}
        </div>
      </Dialog>
    </Modal>
  );
}
