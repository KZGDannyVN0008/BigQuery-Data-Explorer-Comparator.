import { fail, ok, readJson, stringArray } from '@/lib/api';
import { getTableMetadata } from '@/lib/services/catalog';
import { getColumnProfiles } from '@/lib/services/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const metadata = await getTableMetadata(body.ref);
    const columns = stringArray(body.columns, 'columns');
    const result = await getColumnProfiles(
      metadata,
      {
        dateColumn: body.dateColumn as string | undefined,
        startDate: body.startDate as string | undefined,
        endDate: body.endDate as string | undefined,
      },
      columns.length > 0 ? columns : metadata.columns.slice(0, 8).map((c) => c.name),
      { includeTopValues: body.includeTopValues !== false },
    );
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
