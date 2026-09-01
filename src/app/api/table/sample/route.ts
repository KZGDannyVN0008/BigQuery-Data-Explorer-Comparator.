import { fail, ok, readJson, stringArray } from '@/lib/api';
import { getTableMetadata } from '@/lib/services/catalog';
import { getSample } from '@/lib/services/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const metadata = await getTableMetadata(body.ref);
    const { sample, sql } = await getSample(
      metadata,
      {
        dateColumn: body.dateColumn as string | undefined,
        startDate: body.startDate as string | undefined,
        endDate: body.endDate as string | undefined,
      },
      stringArray(body.columns, 'columns'),
    );
    return ok({ sample, sql });
  } catch (error) {
    return fail(error);
  }
}
