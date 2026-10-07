import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  getImageConfig,
  getImageModelCatalog,
  getImageModelEndpoints,
  getImageStatus,
  type ImageConfigView,
  type ImageModelConfig,
  putImageConfig,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';

const selectClass =
  'h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-ring disabled:opacity-50';

/** Model row in the form: `key` is a stable React key, `description` is normalized to a string. */
type EditableModel = ImageModelConfig & { key: string; description: string };

/** Strip the stable key and omit empty descriptions before persisting. */
function toModelPayload(model: EditableModel): ImageModelConfig {
  const { key: _key, description, ...rest } = model;
  return description.trim() === '' ? rest : { ...rest, description };
}

export default function ImageSettingsPage() {
  const { t } = useTranslation();
  const config = useQuery({ queryKey: ['image-config'], queryFn: getImageConfig });
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus });
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{t('image.settings.title')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('image.settings.statusLine', {
            status: status.isPending
              ? t('common.loading')
              : status.isError
                ? t('image.settings.statusReadFailed')
                : status.data.enabled
                  ? t('common.enabled')
                  : t('common.disabled'),
          })}
        </p>
      </div>
      {config.isPending ? (
        <p className="text-muted-foreground text-sm">{t('image.settings.readingConfig')}</p>
      ) : config.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{errorMessage(config.error)}</p>
          <Button variant="outline" onClick={() => void config.refetch()}>
            {t('common.reload')}
          </Button>
        </div>
      ) : (
        <ImageSettingsForm key={config.data.revision} initial={config.data} />
      )}
    </div>
  );
}

function ImageSettingsForm({ initial }: { initial: ImageConfigView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const credentialNames = [...new Set([...initial.credentials, ...initial.models.map((model) => model.credentialRef)])];
  const [credentials, setCredentials] = useState(() =>
    (credentialNames.length > 0 ? credentialNames : ['openrouter']).map((name) => ({
      key: crypto.randomUUID(),
      name,
      secret: '',
      saved: initial.credentials.includes(name),
      source: initial.credentials.includes(name)
        ? ''
        : initial.credential_providers.includes(name)
          ? name
          : initial.credential_providers.length === 1
            ? (initial.credential_providers[0] ?? '')
            : '',
    })),
  );
  const [models, setModels] = useState(() =>
    [...new Map(initial.models.map((model) => [JSON.stringify(model), model])).values()].map((model) => ({
      ...model,
      key: crypto.randomUUID(),
      description: model.description ?? '',
    })),
  );
  const mergedDuplicates = initial.models.length - new Set(initial.models.map((model) => JSON.stringify(model))).size;
  const [search, setSearch] = useState('');
  const [modelId, setModelId] = useState('');
  const [providerTag, setProviderTag] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const catalog = useQuery({
    queryKey: ['image-model-catalog'],
    queryFn: getImageModelCatalog,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const endpoints = useQuery({
    queryKey: ['image-model-endpoints', modelId],
    queryFn: () => getImageModelEndpoints(modelId),
    enabled: enabled && modelId !== '',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const selectedModel = catalog.data?.models.find((model) => model.id === modelId);
  const availableEndpoints = endpoints.data?.endpoints ?? [];
  const selectedEndpoint =
    availableEndpoints.find((endpoint) => endpoint.providerTag === providerTag) ??
    availableEndpoints.find((endpoint) => endpoint.unavailableReason === null);
  const selectedCredential = credentialRef || credentials[0]?.name || '';
  const visibleModels =
    catalog.data?.models.filter(
      (model) =>
        model.id === modelId || `${model.name} ${model.id}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const alreadyAdded = models.some(
    (model) => model.upstreamModel === modelId && model.providerTag === selectedEndpoint?.providerTag,
  );
  const editedCredentials = credentials.filter(
    (entry) => entry.saved || entry.name.trim() || entry.secret.trim() || entry.source,
  );
  const invalidName = editedCredentials.find((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name));
  const missingKey = editedCredentials.find((entry) => !entry.saved && !entry.secret.trim() && !entry.source);
  const missingReference = models.find(
    (model) => !editedCredentials.some((entry) => entry.name === model.credentialRef),
  );
  const validationError = !enabled
    ? null
    : models.length === 0
      ? t('image.settings.noModelsSelected')
      : new Set(models.map((model) => model.id)).size !== models.length
        ? t('image.settings.duplicateModelIds')
        : invalidName
          ? t('image.settings.invalidCredentialName')
          : new Set(editedCredentials.map((entry) => entry.name)).size !== editedCredentials.length
            ? t('image.settings.duplicateCredentialNames')
            : missingReference
              ? t('image.settings.modelCredentialMissing', {
                  model: missingReference.name,
                  credential: missingReference.credentialRef,
                })
              : missingKey
                ? t('image.settings.credentialKeyMissing', { name: missingKey.name })
                : null;

  const save = useMutation({
    mutationFn: () => {
      if (validationError !== null) {
        throw new Error(validationError);
      }
      return putImageConfig(
        {
          enabled,
          ...(enabled
            ? {
                credentials: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.secret.trim() !== '')
                    .map((entry) => [entry.name, entry.secret.trim()]),
                ),
                credential_sources: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.source !== '' && entry.secret.trim() === '')
                    .map((entry) => [entry.name, entry.source]),
                ),
                models: models.map(toModelPayload),
              }
            : {}),
        },
        initial.revision,
      );
    },
    onSuccess: async (result) => {
      toast.success(result.enabled ? t('image.settings.appliedToast') : t('image.settings.disabledToast'));
      setCredentials((current) => current.map((entry) => ({ ...entry, secret: '' })));
      await Promise.all(
        ['image-config', 'image-status', 'providers', 'config-status'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  function addModel() {
    if (!selectedModel || !selectedEndpoint || selectedEndpoint.unavailableReason !== null || alreadyAdded) {
      return;
    }
    setModels((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        id: selectedEndpoint.id,
        name: selectedModel.name,
        provider: 'openrouter',
        upstreamModel: selectedModel.id,
        credentialRef: selectedCredential,
        providerTag: selectedEndpoint.providerTag,
        capabilities: selectedEndpoint.capabilities,
        description: '',
      },
    ]);
    setModelId('');
    setProviderTag('');
    setSearch('');
  }

  return (
    <div className="space-y-6">
      <Panel title={t('image.settings.enablePanelTitle')}>
        <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
          <div className="flex items-center gap-3">
            <input
              id="image-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4"
            />
            <Label htmlFor="image-enabled">{t('image.settings.enableLabel')}</Label>
          </div>
          {enabled && (
            <>
              <p className="text-muted-foreground text-sm">{t('image.settings.credentialsHint')}</p>
              {credentials.map((entry, index) => (
                <div key={entry.key} className="grid gap-3 sm:grid-cols-[160px_1fr]">
                  <div className="space-y-2">
                    <Label htmlFor={`credential-name-${index}`}>{t('image.settings.credentialName')}</Label>
                    <Input
                      id={`credential-name-${index}`}
                      value={entry.name}
                      disabled={entry.saved || models.some((model) => model.credentialRef === entry.name)}
                      onChange={(event) =>
                        setCredentials((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    {!entry.saved && initial.credential_providers.length > 0 && (
                      <div className="space-y-2">
                        <Label htmlFor={`credential-source-${index}`}>{t('image.settings.keySource')}</Label>
                        <select
                          id={`credential-source-${index}`}
                          className={selectClass}
                          value={entry.source}
                          onChange={(event) =>
                            setCredentials((current) =>
                              current.map((item) =>
                                item.key === entry.key ? { ...item, source: event.target.value, secret: '' } : item,
                              ),
                            )
                          }
                        >
                          <option value="">{t('image.settings.newKeyOption')}</option>
                          {initial.credential_providers.map((alias) => (
                            <option key={alias} value={alias}>
                              {t('image.settings.savedCredentialOption', { alias })}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {entry.source === '' && (
                      <>
                        <Label htmlFor={`credential-key-${index}`}>{t('image.settings.apiKeyLabel')}</Label>
                        <Input
                          id={`credential-key-${index}`}
                          type="password"
                          autoComplete="new-password"
                          placeholder={
                            initial.credentials.includes(entry.name)
                              ? t('image.settings.configuredPlaceholder')
                              : t('image.settings.newKeyPlaceholder')
                          }
                          value={entry.secret}
                          onChange={(event) =>
                            setCredentials((current) =>
                              current.map((item) =>
                                item.key === entry.key ? { ...item, secret: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </>
                    )}
                  </div>
                  {!entry.saved && credentials.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="sm:col-span-2 sm:justify-self-start"
                      disabled={models.some((model) => model.credentialRef === entry.name)}
                      onClick={() => setCredentials((current) => current.filter((item) => item.key !== entry.key))}
                    >
                      {t('image.settings.removeCredential')}
                    </Button>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCredentials((current) => [
                    ...current,
                    { key: crypto.randomUUID(), name: '', secret: '', saved: false, source: '' },
                  ])
                }
              >
                {t('image.settings.addCredential')}
              </Button>
            </>
          )}
        </fieldset>
      </Panel>
      {enabled && (
        <Panel
          title={t('image.settings.modelsPanelTitle')}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={catalog.isFetching || save.isPending}
              onClick={() => {
                void catalog.refetch();
                if (modelId) {
                  void endpoints.refetch();
                }
              }}
            >
              {catalog.isFetching ? t('image.settings.fetchingModels') : t('image.settings.refreshModels')}
            </Button>
          }
        >
          <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
            <p className="text-muted-foreground text-sm">{t('image.settings.modelsHint')}</p>
            {catalog.isError && (
              <p role="alert" className="text-destructive text-sm">
                {t('image.settings.catalogError', { error: errorMessage(catalog.error) })}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="image-model-search">{t('image.settings.searchModels')}</Label>
              <Input
                id="image-model-search"
                placeholder={t('image.settings.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-model-select">{t('image.settings.modelSelectLabel')}</Label>
              <select
                id="image-model-select"
                className={selectClass}
                value={modelId}
                disabled={catalog.isPending || visibleModels.length === 0}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setProviderTag('');
                }}
              >
                <option value="">
                  {catalog.isPending
                    ? t('image.settings.fetchingModelsOption')
                    : visibleModels.length === 0
                      ? t('image.settings.noMatchingModels')
                      : t('image.settings.selectModelOption')}
                </option>
                {visibleModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.id})
                  </option>
                ))}
              </select>
            </div>
            {modelId && (
              <div className="space-y-3">
                {endpoints.isPending ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    {t('image.settings.readingEndpoints')}
                  </p>
                ) : endpoints.isError ? (
                  <div role="alert" className="space-y-2">
                    <p className="text-destructive text-sm">
                      {t('image.settings.endpointsError', { error: errorMessage(endpoints.error) })}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => void endpoints.refetch()}>
                      {t('image.settings.retryProviders')}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="image-provider-select">{t('image.settings.provider')}</Label>
                      <select
                        id="image-provider-select"
                        className={selectClass}
                        value={selectedEndpoint?.providerTag ?? ''}
                        onChange={(event) => setProviderTag(event.target.value)}
                      >
                        {!selectedEndpoint && <option value="">{t('image.settings.noProviders')}</option>}
                        {availableEndpoints.map((endpoint) => (
                          <option
                            key={endpoint.providerTag}
                            value={endpoint.providerTag}
                            disabled={endpoint.unavailableReason !== null}
                          >
                            {endpoint.providerName}
                          </option>
                        ))}
                      </select>
                    </div>
                    {selectedEndpoint ? (
                      <ModelCapabilities capabilities={selectedEndpoint.capabilities} />
                    ) : (
                      <p role="status" className="text-muted-foreground text-sm">
                        {availableEndpoints[0]?.unavailableReason ?? t('image.settings.noAvailableProvider')}
                      </p>
                    )}
                  </>
                )}
                {credentials.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="image-credential-select">{t('image.settings.useCredential')}</Label>
                    <select
                      id="image-credential-select"
                      className={selectClass}
                      value={selectedCredential}
                      onChange={(event) => setCredentialRef(event.target.value)}
                    >
                      {credentials
                        .filter((entry) => entry.name !== '')
                        .map((entry) => (
                          <option key={entry.key}>{entry.name}</option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            <Button
              variant="outline"
              disabled={
                !selectedModel ||
                !selectedEndpoint ||
                selectedEndpoint.unavailableReason !== null ||
                !selectedCredential ||
                alreadyAdded ||
                models.length >= 64
              }
              onClick={addModel}
            >
              {alreadyAdded ? t('image.settings.alreadyAdded') : t('image.settings.addModel')}
            </Button>
            {mergedDuplicates > 0 && (
              <p className="text-muted-foreground text-sm">
                {t('image.settings.mergedDuplicates', { count: mergedDuplicates })}
              </p>
            )}
            {models.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('image.settings.noModelsYet')}</p>
            ) : (
              <ul className="space-y-5">
                {models.map((model) => (
                  <li key={model.key} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{model.name}</p>
                        <p className="text-muted-foreground break-all text-xs">
                          {model.upstreamModel} · {model.providerTag} ·{' '}
                          {t('image.settings.credentialRef', { name: model.credentialRef })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('image.settings.removeModel', { name: model.name })}
                        onClick={() => setModels((current) => current.filter((item) => item !== model))}
                      >
                        {t('image.settings.remove')}
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`model-description-${model.key}`}>
                        {t('image.settings.modelDescriptionLabel')}
                      </Label>
                      <Textarea
                        id={`model-description-${model.key}`}
                        rows={2}
                        maxLength={1000}
                        value={model.description}
                        placeholder={t('image.settings.modelDescriptionPlaceholder')}
                        onChange={(event) =>
                          setModels((current) =>
                            current.map((item) =>
                              item.key === model.key ? { ...item, description: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <p className="text-muted-foreground text-xs">{t('image.settings.modelDescriptionHint')}</p>
                    </div>
                    <ModelCapabilities capabilities={model.capabilities} />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </Panel>
      )}
      {validationError && (
        <p id="image-save-requirements" role="status" className="text-sm text-muted-foreground">
          {validationError}
        </p>
      )}
      {save.isError && validationError === null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(save.error)}
        </p>
      )}
      <Button
        onClick={() => {
          if (validationError !== null) {
            toast.error(validationError);
            return;
          }
          save.mutate();
        }}
        aria-describedby={validationError ? 'image-save-requirements' : undefined}
        disabled={save.isPending}
      >
        {save.isPending ? t('common.saving') : t('image.settings.saveAndApply')}
      </Button>
    </div>
  );
}

function ModelCapabilities({ capabilities }: { capabilities: ImageModelConfig['capabilities'] }) {
  const { t } = useTranslation();
  const qualityNames: Record<string, string> = {
    auto: t('image.settings.enumAuto'),
    low: t('image.settings.enumLow'),
    medium: t('image.settings.enumMedium'),
    high: t('image.settings.enumHigh'),
  };
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      {capabilities.imageInput
        ? t('image.settings.capabilitiesInput', { count: capabilities.maxInputImages })
        : t('image.settings.capabilitiesTextOnly')}{' '}
      · {t('image.settings.capabilitiesOutputs', { count: capabilities.maxOutputs })}
      <br />
      {t('image.settings.aspectRatiosLabel', {
        values: capabilities.aspectRatios
          .map((value) => (value === 'auto' ? t('image.settings.enumAuto') : value))
          .join('、'),
      })}
      {' · '}
      {t('image.settings.qualityLabel', {
        values: capabilities.resolutionClasses.map((value) => qualityNames[value] ?? value).join('、'),
      })}
    </p>
  );
}
