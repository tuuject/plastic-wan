import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { MonoValue } from './kv-list';

export function CopyableValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [copying, setCopying] = useState(false);
  const action = t('common.copyValue', { label, value: value ?? '' });
  return (
    <span className="text-muted-foreground inline-flex max-w-full flex-wrap items-center gap-1 text-xs">
      <span>{label}:</span>
      <MonoValue value={value} />
      {value === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full pointer-coarse:size-12"
          aria-label={action}
          title={action}
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            try {
              await navigator.clipboard.writeText(value);
              toast.success(t('common.copied'));
            } catch {
              toast.error(t('common.copyFailed'));
            } finally {
              setCopying(false);
            }
          }}
        >
          <Icons.copy aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}
