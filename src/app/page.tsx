import { Explorer } from '@/components/Explorer';
import { config } from '@/lib/config';
import { listProjects } from '@/lib/services/catalog';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Explorer
      projects={listProjects()}
      mockMode={config.mockMode}
      limits={{
        maxCompareWindowDays: config.maxCompareWindowDays,
        previewPageSize: config.previewPageSize,
        sampleRowLimit: config.sampleRowLimit,
      }}
    />
  );
}
