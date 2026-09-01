import { fail, ok } from '@/lib/api';
import { listTables } from '@/lib/services/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const tables = await listTables(params.get('project') ?? '', params.get('dataset') ?? '');
    return ok({ tables });
  } catch (error) {
    return fail(error);
  }
}
