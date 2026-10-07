import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type BadgeSemantic,
  type ColumnSpec,
  ConfirmDialog,
  MonoValue,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  ApiError,
  cancelPromptRunning,
  failedPromptVersion,
  type PromptDiffHunk,
  type PromptDiffLine,
  type PromptDiffView,
  type PromptDocument,
  type PromptSaveResponse,
  type PromptScopeRef,
  type PromptVersionItem,
  type PromptVersionSource,
  restorePromptVersion,
  savePrompt,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatsQuery, promptDiffQuery, promptDocumentQuery, promptVersionsQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** The same limit the API enforces on a version note. */
const MAX_NOTE_CHARS = 200;
const GLOBAL_SCOPE_VALUE = 'global';
const CHAT_SCOPE_PREFIX = 'chat:';
const PROMPT_CONFLICT_CODE = 'prompt_conflict';

/** What the last write reported, rendered next to the editor. */
type Notice =
  | { readonly kind: 'saved' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'apply_failed'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/** The editor's own copy: text plus the file hash `Save` pins with If-Match. */
interface PromptDraft {
  readonly hash: string;
  readonly text: string;
  readonly note: string;
}

function scopeOfValue(value: string): PromptScopeRef {
  return value.startsWith(CHAT_SCOPE_PREFIX)
    ? { scope: 'group', chat: value.slice(CHAT_SCOPE_PREFIX.length) }
    : { scope: 'global' };
}

function sourceTone(source: PromptVersionSource): BadgeSemantic {
  switch (source) {
    case 'panel':
      return 'info';
    case 'rollback':
      return 'neutral';
    case 'external':
      return 'warning';
  }
}

function sourceLabelKey(
  source: PromptVersionSource,
): 'pages.prompts.sourcePanel' | 'pages.prompts.sourceExternal' | 'pages.prompts.sourceRollback' {
  switch (source) {
    case 'panel':
      return 'pages.prompts.sourcePanel';
    case 'rollback':
      return 'pages.prompts.sourceRollback';
    case 'external':
      return 'pages.prompts.sourceExternal';
  }
}

function diffMarker(type: PromptDiffLine['type']): string {
  return type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
}

/** Hunk separator in the unified-diff header format the API emits. */
function hunkHeader(hunk: PromptDiffHunk): string {
  return `@@ -${hunk.fromStart},${hunk.fromCount} +${hunk.toStart},${hunk.toCount} @@`;
}

function DiffView({ diff }: { readonly diff: PromptDiffView }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="bg-muted/40 border-b px-3 py-2 font-mono text-xs">
        {t('pages.prompts.diffTitle', { from: diff.from.seq, to: diff.to.seq })}
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <pre className="min-w-max font-mono text-xs leading-relaxed">
          {diff.hunks.map((hunk) => (
            <Fragment key={hunkHeader(hunk)}>
              <div className="bg-muted/50 text-muted-foreground px-3 py-0.5">{hunkHeader(hunk)}</div>
              {hunk.lines.map((line) => (
                <div
                  // Unified-diff coordinates are file-global and strictly
                  // increasing, so a line's own numbers identify it.
                  key={`${line.type}:${line.fromLine ?? 'x'}:${line.toLine ?? 'y'}`}
                  data-line-type={line.type}
                  className={cn(
                    'flex',
                    line.type === 'removed' && 'bg-danger/10',
                    line.type === 'added' && 'bg-success/10',
                  )}
                >
                  <span className="text-muted-foreground w-10 shrink-0 px-2 text-right tabular-nums select-none">
                    {line.fromLine ?? ''}
                  </span>
                  <span className="text-muted-foreground w-10 shrink-0 px-2 text-right tabular-nums select-none">
                    {line.toLine ?? ''}
                  </span>
                  <span className={cn('pr-4 whitespace-pre', line.type === 'context' && 'text-muted-foreground')}>
                    {`${diffMarker(line.type)}${line.text}`}
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Save outcomes: a recorded/applied prompt, a no-op, or one of the write failures. */
function WriteNotice({ notice }: { readonly notice: Notice | null }): React.ReactElement | null {
  const { t } = useTranslation();
  switch (notice?.kind) {
    case undefined:
      return null;
    case 'saved':
      return (
        <p role="status" className="text-success text-sm">
          {t('pages.prompts.saved')}
        </p>
      );
    case 'unchanged':
      return (
        <p role="status" className="text-muted-foreground text-sm">
          {t('pages.prompts.unchanged')}
        </p>
      );
    case 'conflict':
      return (
        <p role="alert" className="text-destructive text-sm">
          {t('pages.prompts.conflict')}
        </p>
      );
    case 'apply_failed':
      return (
        <Alert variant="destructive">
          <AlertTitle>{t('pages.prompts.applyFailedTitle')}</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      );
    case 'error':
      return (
        <p role="alert" className="text-destructive text-sm break-words">
          {notice.message}
        </p>
      );
  }
}

/**
 * The textarea is seeded from the file view and re-seeded whenever that view's
 * content hash changes (scope switch, refetch after a conflict): the draft only
 * survives while it still describes the content its hash pins.
 */
function PromptEditor({
  file,
  applied,
  notice,
  saving,
  onSave,
}: {
  readonly file: PromptDocument;
  readonly applied: PromptVersionItem | null;
  readonly notice: Notice | null;
  readonly saving: boolean;
  readonly onSave: (draft: PromptDraft) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const current =
    draft !== null && draft.hash === file.content_hash
      ? draft
      : { hash: file.content_hash, text: file.prompt, note: '' };
  const matches = applied !== null && applied.content_hash === file.content_hash;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="prompt-text">{t('pages.prompts.promptLabel')}</Label>
        <Textarea
          id="prompt-text"
          value={current.text}
          spellCheck={false}
          placeholder={t('pages.prompts.promptPlaceholder')}
          className="min-h-96 font-mono text-xs"
          onChange={(event) => setDraft({ hash: file.content_hash, text: event.target.value, note: current.note })}
        />
        <p className="text-muted-foreground text-xs">{t('pages.prompts.editorHint')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="prompt-note">{t('pages.prompts.noteLabel')}</Label>
        <Input
          id="prompt-note"
          value={current.note}
          maxLength={MAX_NOTE_CHARS}
          placeholder={t('pages.prompts.notePlaceholder')}
          onChange={(event) => setDraft({ hash: file.content_hash, text: current.text, note: event.target.value })}
        />
        <p className="text-muted-foreground text-xs">{t('pages.prompts.noteHint', { count: MAX_NOTE_CHARS })}</p>
      </div>
      <div className="bg-muted/30 space-y-1.5 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('pages.prompts.appliedVersion')}</span>
          {applied === null ? (
            <span className="text-muted-foreground">{t('pages.prompts.noVersions')}</span>
          ) : (
            <>
              <MonoValue value={`v${applied.seq}`} />
              <ToneBadge tone={sourceTone(applied.source)}>{t(sourceLabelKey(applied.source))}</ToneBadge>
              <span className="text-muted-foreground text-xs tabular-nums">{formatTime(applied.created_at)}</span>
              {applied.created_by === null ? null : (
                <span className="text-muted-foreground text-xs">{applied.created_by}</span>
              )}
            </>
          )}
        </div>
        {applied === null ? null : (
          <p className={cn('text-xs', matches ? 'text-success' : 'text-warning')}>
            {matches ? t('pages.prompts.fileMatches') : t('pages.prompts.fileDiffers')}
          </p>
        )}
      </div>
      {file.scope === 'group' && file.prompt.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('pages.prompts.groupCreationHint')}</p>
      ) : null}
      <WriteNotice notice={notice} />
      <Button type="button" disabled={saving} onClick={() => onSave(current)}>
        {saving ? t('pages.prompts.saving') : t('pages.prompts.save')}
      </Button>
    </div>
  );
}

export default function PromptsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery(chatsQuery);
  const [scopeValue, setScopeValue] = useState(GLOBAL_SCOPE_VALUE);
  const scope = scopeOfValue(scopeValue);
  const fileQuery = useQuery(promptDocumentQuery(scope));
  const versions = useQuery(promptVersionsQuery(scope));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PromptVersionItem | null>(null);
  const [compare, setCompare] = useState<{ readonly from: string; readonly to: string } | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const file = fileQuery.data;
  const applied = versions.data?.current ?? null;
  const items = versions.data?.items ?? [];

  const invalidatePrompts = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['prompt-document'] });
    void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
  };
  /** A conflict refetches the moved file; an apply failure still recorded a version. */
  const failWrite = (error: unknown): void => {
    if (error instanceof ApiError && error.code === PROMPT_CONFLICT_CODE) {
      setNotice({ kind: 'conflict' });
      void fileQuery.refetch();
      return;
    }
    if (failedPromptVersion(error) !== null) {
      setNotice({ kind: 'apply_failed', message: errorMessage(error) });
      invalidatePrompts();
      return;
    }
    setNotice({ kind: 'error', message: errorMessage(error) });
  };
  const succeedWrite = (result: PromptSaveResponse): void => {
    if (result.status === 'unchanged') {
      setNotice({ kind: 'unchanged' });
      return;
    }
    setNotice({ kind: 'saved' });
    toast.success(t('pages.prompts.savedToast'));
    invalidatePrompts();
    if (result.affected_running > 0) {
      setCancelTarget(result.affected_running);
    }
  };
  const save = useMutation({
    mutationFn: (draft: PromptDraft) => {
      const note = draft.note.trim();
      return savePrompt(scope, note.length === 0 ? { prompt: draft.text } : { prompt: draft.text, note }, draft.hash);
    },
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: succeedWrite,
    onError: failWrite,
  });
  const restore = useMutation({
    mutationFn: (input: { readonly version: PromptVersionItem; readonly hash: string }) =>
      restorePromptVersion(
        input.version.id,
        { note: t('pages.prompts.restoreNote', { seq: input.version.seq }) },
        input.hash,
      ),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: (result) => {
      setRestoreTarget(null);
      succeedWrite(result);
    },
    onError: (error) => {
      failWrite(error);
      // Both failures mean the recorded history moved: close the dialog onto
      // the refreshed file view and the failure notice.
      if (error instanceof ApiError && (error.code === PROMPT_CONFLICT_CODE || failedPromptVersion(error) !== null)) {
        setRestoreTarget(null);
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelPromptRunning(scope),
    onSuccess: (result) => {
      setCancelTarget(null);
      toast.success(
        t('pages.prompts.cancelResult', { count: result.canceled_invocations, buckets: result.expired_buckets }),
      );
      void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
    },
  });
  const changeScope = (value: string): void => {
    setScopeValue(value);
    setNotice(null);
    setCancelTarget(null);
    setRestoreTarget(null);
    setCompare(null);
    setFromId(null);
    setToId(null);
  };
  const selectable = (id: string | null, fallback: string | null): string | null =>
    id !== null && items.some((item) => item.id === id) ? id : fallback;
  const fromValue = selectable(fromId, items.at(1)?.id ?? null);
  const toValue = selectable(toId, items.at(0)?.id ?? null);
  const diffSelection = compare ?? { from: '', to: '' };
  const diff = useQuery({ ...promptDiffQuery(diffSelection.from, diffSelection.to), enabled: compare !== null });
  const columns: readonly ColumnSpec<PromptVersionItem>[] = [
    {
      key: 'version',
      title: t('pages.prompts.colVersion'),
      render: (row) => (
        <span className="inline-flex items-center gap-2">
          <MonoValue value={`v${row.seq}`} />
          {row.id === applied?.id ? <ToneBadge tone="success">{t('pages.prompts.currentBadge')}</ToneBadge> : null}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.prompts.colCreated'),
      render: (row) => <span className="tabular-nums">{formatTime(row.created_at)}</span>,
    },
    {
      key: 'source',
      title: t('pages.prompts.colSource'),
      render: (row) => <ToneBadge tone={sourceTone(row.source)}>{t(sourceLabelKey(row.source))}</ToneBadge>,
    },
    {
      key: 'note',
      title: t('pages.prompts.colNote'),
      render: (row) => <TextValue value={row.note} />,
    },
    {
      key: 'author',
      title: t('pages.prompts.colAuthor'),
      render: (row) => <TextValue value={row.created_by} />,
    },
    {
      key: 'actions',
      title: t('pages.prompts.colActions'),
      align: 'right',
      render: (row) =>
        row.id === applied?.id ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={file === undefined || restore.isPending}
            onClick={() => {
              restore.reset();
              setRestoreTarget(row);
            }}
          >
            {t('pages.prompts.restore')}
          </Button>
        ),
    },
  ];
  return (
    <div className="space-y-6">
      <Panel
        title={t('pages.prompts.editorTitle')}
        action={
          <div className="flex items-center gap-2">
            <Label htmlFor="prompt-scope" className="text-muted-foreground text-xs">
              {t('pages.prompts.scopeLabel')}
            </Label>
            <Select value={scopeValue} onValueChange={changeScope}>
              <SelectTrigger id="prompt-scope" size="sm" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_SCOPE_VALUE}>{t('pages.prompts.globalScope')}</SelectItem>
                {(chats.data?.items ?? []).map((chat) => (
                  <SelectItem key={chat.id} value={`${CHAT_SCOPE_PREFIX}${chat.id}`}>
                    {chat.title === null
                      ? t('pages.prompts.chatScope', { id: chat.id })
                      : t('pages.prompts.chatScopeTitled', { title: chat.title, id: chat.id })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {fileQuery.isPending ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : fileQuery.isError || file === undefined ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(fileQuery.error)}
            </p>
            <Button variant="outline" onClick={() => void fileQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <PromptEditor
            // Remount when the applied version moves (save, restore, an
            // external apply picked up on refetch): a restore can return the
            // file to the hash the draft was pinned to, and only a fresh
            // editor reliably re-seeds from the file view.
            key={applied?.id ?? 'no-applied-version'}
            file={file}
            applied={applied}
            notice={notice}
            saving={save.isPending}
            onSave={(draft) => save.mutate(draft)}
          />
        )}
      </Panel>
      <Panel title={t('pages.prompts.historyTitle')}>
        {versions.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : versions.isError ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(versions.error)}
            </p>
            <Button variant="outline" onClick={() => void versions.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="prompt-compare-from" className="text-muted-foreground text-xs">
                  {t('pages.prompts.compareFrom')}
                </Label>
                <Select value={fromValue ?? ''} onValueChange={(value) => setFromId(value)}>
                  <SelectTrigger id="prompt-compare-from" size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {`v${item.seq}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-compare-to" className="text-muted-foreground text-xs">
                  {t('pages.prompts.compareTo')}
                </Label>
                <Select value={toValue ?? ''} onValueChange={(value) => setToId(value)}>
                  <SelectTrigger id="prompt-compare-to" size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {`v${item.seq}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fromValue === null || toValue === null || fromValue === toValue}
                onClick={() => {
                  if (fromValue !== null && toValue !== null) {
                    setCompare({ from: fromValue, to: toValue });
                  }
                }}
              >
                {t('pages.prompts.compare')}
              </Button>
            </div>
            <TableShell
              columns={columns}
              data={items}
              rowKey={(row) => row.id}
              emptyText={t('pages.prompts.emptyVersions')}
            />
            {versions.data === undefined ? null : (
              <p className="text-muted-foreground text-xs">
                {t('pages.prompts.retention', { count: versions.data.retained })}
              </p>
            )}
            {compare === null ? null : diff.isPending ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : diff.isError || diff.data === undefined ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {errorMessage(diff.error)}
              </p>
            ) : diff.data.hunks.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('pages.prompts.noDifferences')}</p>
            ) : (
              <DiffView diff={diff.data} />
            )}
          </div>
        )}
      </Panel>
      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelTarget(null);
          }
        }}
        title={t('pages.prompts.affectedTitle')}
        description={t('pages.prompts.affectedDescription', { count: cancelTarget ?? 0 })}
        confirmText={t('pages.prompts.affectedConfirm', { count: cancelTarget ?? 0 })}
        cancelText={t('pages.prompts.affectedDismiss')}
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) {
            setRestoreTarget(null);
          }
        }}
        title={t('pages.prompts.restoreTitle', { seq: restoreTarget?.seq ?? '' })}
        description={t('pages.prompts.restoreDescription')}
        confirmText={t('pages.prompts.restoreConfirm')}
        cancelText={t('common.cancel')}
        pending={restore.isPending}
        error={restore.isError ? errorMessage(restore.error) : null}
        onConfirm={() => {
          if (restoreTarget !== null && file !== undefined) {
            restore.mutate({ version: restoreTarget, hash: file.content_hash });
          }
        }}
      />
    </div>
  );
}
