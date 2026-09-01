import { fail, ok } from '@/lib/api';
import { validateTableRef } from '@/lib/services/catalog';
import { getRelationships } from '@/lib/services/relationships';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const ref = await validateTableRef({
      project: params.get('project'),
      dataset: params.get('dataset'),
      table: params.get('table'),
    });
    return ok(await getRelationships(ref));
  } catch (error) {
    return fail(error);
  }
}
