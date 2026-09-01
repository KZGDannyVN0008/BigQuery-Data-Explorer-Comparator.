import { fail, ok } from '@/lib/api';
import { getTableMetadata } from '@/lib/services/catalog';
import { describeSql } from '@/lib/sql/introspection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const metadata = await getTableMetadata({
      project: params.get('project'),
      dataset: params.get('dataset'),
      table: params.get('table'),
    });
    return ok({ metadata, previewSql: describeSql(metadata.ref) });
  } catch (error) {
    return fail(error);
  }
}
